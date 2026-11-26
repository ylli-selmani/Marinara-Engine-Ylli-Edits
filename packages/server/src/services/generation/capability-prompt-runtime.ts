import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import {
  collectCapabilityPromptContext,
  type CapabilityPromptContextRequest,
} from "../capability-packages/capability-prompt-context.service.js";
import { collectCapabilityLorebookClaims } from "../capability-packages/capability-lorebook-claims.service.js";
import type { ResolvedOwnerSpatialProjection } from "@marinara-engine/shared";
import { formatOwnerSpatialBreadcrumb } from "../spatial-context/projection.js";
import { collectRoleplayEventContext } from "../capability-packages/capability-roleplay-events.service.js";
import { processLorebooks } from "../lorebook/index.js";
import { resolveLorebookScopeExclusions } from "../lorebook/game-lorebook-scope.js";
import { replaceRuntimeAgentSection, type RuntimeAgentSectionTokens } from "./runtime-agent-sections.js";

type ProcessLorebookOptions = NonNullable<Parameters<typeof processLorebooks>[3]>;

/**
 * The current location for a prompt-context request: only when the projection's map belongs to this chat's mode,
 * the same rule the Engine's own scan uses for World Maps' forced entries.
 */
export function capabilityPromptLocation(
  projection: ResolvedOwnerSpatialProjection | null | undefined,
  chatMode: string,
): CapabilityPromptContextRequest["currentLocation"] {
  if (!projection || projection.ownerMode !== chatMode) return null;
  return {
    locationId: projection.currentLocationId,
    path: formatOwnerSpatialBreadcrumb(projection).trim(),
    lorebookEntryIds: [...projection.lorebookEntryIds],
  };
}

/**
 * Re-scans lorebooks a package claimed for this chat, for the turn that package failed to deliver its own context.
 * Returns the activated lore as one text block, or null when nothing activates.
 */
export type ClaimedLorebookRescan = (lorebookIds: string[]) => Promise<string | null>;

/** What the call site's own lorebook scan used, so the fallback scans the same turn the same way. */
export interface ClaimedLorebookRescanInput {
  chatId: string;
  chatMode: string;
  chatMeta: Record<string, unknown>;
  /** Built only when a fallback actually runs. */
  scanMessages: () => Parameters<typeof processLorebooks>[1];
  characterIds: string[];
  personaId?: string | null;
  activeLorebookIds: string[];
  /** World Maps' current-location entries, when the call site scans them. */
  forcedEntryIds?: string[];
  tokenBudget?: number;
  resolveContent?: ProcessLorebookOptions["resolveContent"];
  wrapFormat?: CapabilityPromptContextRequest["wrapFormat"];
}

function wrapFallbackLore(text: string, wrapFormat: CapabilityPromptContextRequest["wrapFormat"]): string {
  if (wrapFormat === "markdown") return `## World info\n\n${text}`;
  if (wrapFormat === "none") return text;
  return `<world_info>\n${text}\n</world_info>`;
}

/**
 * Build the fallback for one turn. It scans like the Engine would have without the claim: the same messages,
 * characters, persona, chat lorebooks and budget, the user's own exclusions (claims left out), restricted to the
 * claimed books. Entry timing (sticky, cooldown) is read but not advanced, so a rare fallback turn doesn't shift it.
 * Embeddings and decision statements are skipped: this only runs when something already went wrong.
 */
export function createClaimedLorebookRescan(db: DB, input: ClaimedLorebookRescanInput): ClaimedLorebookRescan {
  return async (lorebookIds) => {
    const exclusions = resolveLorebookScopeExclusions(input.chatMode, input.chatMeta);
    const result = await processLorebooks(db, input.scanMessages(), null, {
      chatId: input.chatId,
      characterIds: input.characterIds,
      personaId: input.personaId ?? null,
      activeLorebookIds: input.activeLorebookIds,
      forcedEntryIds: input.forcedEntryIds ?? [],
      onlyLorebookIds: lorebookIds,
      excludedLorebookIds: exclusions.excludedLorebookIds,
      excludedSourceAgentIds: exclusions.excludedSourceAgentIds,
      tokenBudget: input.tokenBudget,
      entryStateOverrides:
        (input.chatMeta.entryStateOverrides as ProcessLorebookOptions["entryStateOverrides"]) ?? undefined,
      entryTimingStates: (input.chatMeta.entryTimingStates as ProcessLorebookOptions["entryTimingStates"]) ?? undefined,
      previewOnly: true,
      resolveContent: input.resolveContent,
    });
    const parts = [
      result.worldInfoBefore,
      result.worldInfoAfter,
      ...result.depthEntries.map((entry) => entry.content),
      ...Object.values(result.outlets),
    ]
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? wrapFallbackLore(parts.join("\n\n"), input.wrapFormat) : null;
  };
}

/**
 * The same read-only package placement for generation and Peek Prompt.
 *
 * A package that claimed lorebooks for this chat (`registerLorebookClaims`) had them skipped by the scan that
 * already ran. If its contributor then fails or times out, `rescanClaimedLorebooks` puts that lore back, in the
 * package's place, so a broken package never costs the turn lore the Engine would have injected on its own.
 */
export async function injectCapabilityContexts(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  request: CapabilityPromptContextRequest,
  db: DB,
  sectionTokens: ReadonlyMap<string, RuntimeAgentSectionTokens>,
  options: { rescanClaimedLorebooks?: ClaimedLorebookRescan } = {},
) {
  const promptContext = await collectCapabilityPromptContext(request);
  const placed = [...promptContext.packageBlocks];
  if (options.rescanClaimedLorebooks && promptContext.failedPackageIds.length > 0) {
    const failed = new Set(promptContext.failedPackageIds);
    const claims = collectCapabilityLorebookClaims({
      chatId: request.chatId,
      chatMode: request.mode,
      chatMeta: request.chatMeta,
    });
    for (const claim of claims.byPackage) {
      if (!failed.has(claim.packageId)) continue;
      try {
        const text = await options.rescanClaimedLorebooks(claim.lorebookIds);
        if (text) placed.push({ packageId: claim.packageId, text });
        logger.warn(
          "[capability] %s failed to deliver context; re-scanned its %d claimed lorebook(s)",
          claim.packageId,
          claim.lorebookIds.length,
        );
      } catch (error) {
        logger.error(error, "[capability] claimed-lorebook fallback scan failed for %s", claim.packageId);
      }
    }
  }
  const blocks = placed.flatMap((block) => {
    const tokens = sectionTokens.get(block.packageId);
    return tokens && replaceRuntimeAgentSection(messages, tokens, block.text) ? [] : [block.text];
  });
  const eventBlock = await collectRoleplayEventContext(db, request.chatId, request.targetCharacterIds ?? []);
  if (eventBlock) blocks.push(eventBlock);
  if (blocks.length > 0) {
    const context = blocks.join("\n\n");
    const systemMessage = messages.find((message) => message.role === "system");
    if (systemMessage) systemMessage.content += "\n\n" + context;
    else messages.unshift({ role: "system", content: context });
  }
  return promptContext;
}

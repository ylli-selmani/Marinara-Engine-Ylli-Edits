import { currentRoomGeneration } from "../multiplayer/generation-policy.js";
// ──────────────────────────────────────────────
// Capability prompt-context registry — gives the `prompt-context` permission its mechanism.
//
// A contributor is called ONCE per generation with a read-only view of the chat and returns the text to
// append, or null for nothing this turn. It must not mutate anything, and a throw is swallowed by the
// collector. It may also declare which built-in game systems it replaces; undeclared stays built-in.
// ──────────────────────────────────────────────

import { logRateLimited } from "../../lib/log-rate-limit.js";

/** Read-only view of the turn handed to each contributor. */
/** Capability API 1.839. The chat's current World Maps location, as the Engine's own lorebook scan uses it. */
export interface CapabilityPromptContextLocation {
  /** The World Maps location id (`loc:<id>` as an EntityRef). */
  locationId: string;
  /** Breadcrumb names, outermost first, joined with " > ". */
  path: string;
  /** Lorebook entries World Maps links to this location: the ones the Engine's scan forces in for it. */
  lorebookEntryIds: string[];
}

export interface CapabilityPromptContextRequest {
  chatId: string;
  /** The chat's metadata record (where game/agent state lives). */
  chatMeta: Record<string, unknown>;
  /** Chat mode, so a contributor can bail out of modes it doesn't serve. */
  mode: string;
  /** Target characters for this generation. Empty means narrator or no resolved target. */
  targetCharacterIds?: string[];
  /** Active persona for this generation, when one is selected. */
  personaId?: string | null;
  /** Agent-data sections already placed by the active preset. */
  placedAgentTypes?: string[];
  /** The preset's section wrap format, so a contributor's block matches the prompt around it. */
  wrapFormat?: "xml" | "markdown" | "none";
  /**
   * Capability API 1.839. On a regenerate or swipe, the message being replaced. The Engine leaves it (and anything
   * after it) out of its own lorebook scan, so a contributor reading the chat should too, or every swipe matches
   * against the previous swipe's text.
   */
  regenerateMessageId?: string | null;
  /**
   * Capability API 1.839. Where the chat is on its World Maps map this turn (travel and swipes already resolved),
   * when World Maps is added to the chat and its map belongs to this mode. A package that claims lorebooks should
   * inject the linked entries itself, since a claim also skips them in the Engine's scan.
   */
  currentLocation?: CapabilityPromptContextLocation | null;
  /**
   * Capability API 1.839. The context is only shown (Peek Prompt) or used for a dry run, never sent as a turn.
   * Return the same text, but record nothing (no activity logs, no counters).
   */
  preview?: boolean;
}

/** Built-in game systems an experience can declare it replaces. Open set — undeclared stays built-in. */
export interface CapabilityProvidedGameSystems {
  /** The experience tracks items itself ⇒ drop the [inventory:] command and the PLAYER INVENTORY block. */
  inventory?: boolean;
}

/** Rich form of a contribution, for a package that also replaces built-in systems. */
export interface CapabilityPromptContribution {
  text?: string | null;
  provides?: CapabilityProvidedGameSystems;
}

/** A package's per-turn contributor. May return a bare string, the rich form, or nothing. */
export type CapabilityPromptContextContributor = (
  request: CapabilityPromptContextRequest,
) =>
  | string
  | CapabilityPromptContribution
  | null
  | undefined
  | Promise<string | CapabilityPromptContribution | null | undefined>;

/** What the collector hands the turn: the text blocks plus the union of every `provides` declaration. */
export interface CapabilityPromptContextResult {
  blocks: string[];
  packageBlocks: Array<{ packageId: string; text: string }>;
  provides: CapabilityProvidedGameSystems;
  /** Packages whose contributor threw or ran out of time this turn (not ones that returned nothing). */
  failedPackageIds: string[];
}

/** Registration options for a contributor. */
export interface CapabilityPromptContextOptions {
  /**
   * How long the turn waits for this contributor, in ms. Defaults to {@link CONTRIBUTOR_TIMEOUT_MS}; clamped to
   * {@link CONTRIBUTOR_MAX_TIMEOUT_MS}. For a contributor that makes one model call (a librarian or reranker pass
   * over retrieval candidates) and returns its own fallback when that call is slow. Every second here is a second
   * before the reply starts, so ask only for what the call needs.
   */
  timeoutMs?: number;
}

interface ContributorRegistration {
  contribute: CapabilityPromptContextContributor;
  timeoutMs: number;
}

const contributorsByPackage = new Map<string, ContributorRegistration>();

export function getCapabilityPromptContextPackageIds(): string[] {
  return [...contributorsByPackage.keys()];
}

/** Register (or replace) the contributor for a package. Returns a releaser for deactivation. */
export function registerCapabilityPromptContext(
  packageId: string,
  contributor: CapabilityPromptContextContributor,
  options?: CapabilityPromptContextOptions,
): () => void {
  if (typeof contributor !== "function") throw new Error("Capability prompt-context contributor is invalid");
  const registration = { contribute: contributor, timeoutMs: resolveContributorTimeout(options?.timeoutMs) };
  contributorsByPackage.set(packageId, registration);
  return () => {
    if (contributorsByPackage.get(packageId) === registration) contributorsByPackage.delete(packageId);
  };
}

/** Deadline per contributor. A throw is already non-fatal, but a promise that never settles would hang
 *  the turn, so building the prompt can't wait on one indefinitely. */
export const CONTRIBUTOR_TIMEOUT_MS = 2_000;

/** The longest a contributor may ask for (capability API 1.839). */
export const CONTRIBUTOR_MAX_TIMEOUT_MS = 5_000;

/** A requested deadline, clamped to [{@link CONTRIBUTOR_TIMEOUT_MS}, {@link CONTRIBUTOR_MAX_TIMEOUT_MS}]. */
export function resolveContributorTimeout(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return CONTRIBUTOR_TIMEOUT_MS;
  return Math.min(CONTRIBUTOR_MAX_TIMEOUT_MS, Math.max(CONTRIBUTOR_TIMEOUT_MS, Math.floor(requested)));
}

/**
 * Reject if `value` has not settled within {@link CONTRIBUTOR_TIMEOUT_MS}. A primitive is passed straight
 * through, and the timer is cleared on settle and unref'd so a pending deadline never holds the event loop
 * open during shutdown.
 *
 * Anything that can defer races the deadline, not just a native Promise: `Promise.resolve` ADOPTS a
 * thenable, so a hand-rolled one that never settles would slip past the guard and hang the turn — which is
 * the exact failure this exists to prevent.
 */
export function withDeadline<T>(value: Promise<T> | T, label: string, timeoutMs = CONTRIBUTOR_TIMEOUT_MS): Promise<T> {
  const canDefer = value !== null && (typeof value === "object" || typeof value === "function");
  if (!canDefer) return Promise.resolve(value);
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(value),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Collect every registered contribution for this turn. A contributor that fails, times out or returns
 * nothing is skipped, so one bad package can't block generation. Contributors run in registration order:
 * they compose one prompt, so the block order has to be stable across a run.
 */
export async function collectCapabilityPromptContext(
  request: CapabilityPromptContextRequest,
): Promise<CapabilityPromptContextResult> {
  if (currentRoomGeneration() || contributorsByPackage.size === 0)
    return { blocks: [], packageBlocks: [], provides: {}, failedPackageIds: [] };
  const blocks: string[] = [];
  const packageBlocks: Array<{ packageId: string; text: string }> = [];
  const provides: CapabilityProvidedGameSystems = {};
  const failedPackageIds: string[] = [];
  const activeExperienceId =
    typeof request.chatMeta.gameExperienceId === "string" ? request.chatMeta.gameExperienceId : null;
  for (const [packageId, { contribute, timeoutMs }] of contributorsByPackage) {
    try {
      const contribution = await withDeadline(
        contribute(request),
        `prompt-context contributor ${packageId}`,
        timeoutMs,
      );
      if (contribution === null || contribution === undefined) continue;
      const text = typeof contribution === "string" ? contribution : contribution.text;
      if (typeof text === "string" && text.trim().length > 0) {
        const normalized = text.trim();
        blocks.push(normalized);
        packageBlocks.push({ packageId, text: normalized });
      }
      // Only the experience recorded on this game may replace its built-in systems. Other packages may
      // still contribute prompt context, but cannot hide Classic inventory from unrelated games.
      if (
        packageId === activeExperienceId &&
        typeof contribution === "object" &&
        contribution.provides?.inventory === true
      ) {
        provides.inventory = true;
      }
    } catch (error) {
      failedPackageIds.push(packageId);
      // Non-fatal by design: a broken contributor costs its own context, not the player's turn.
      // Runs every turn, so a package that keeps failing logs once a minute, with a repeat count.
      logRateLimited(
        "warn",
        `prompt-context:${packageId}`,
        error,
        "[capability] prompt-context contributor failed for %s",
        packageId,
      );
    }
  }
  return { blocks, packageBlocks, provides, failedPackageIds };
}

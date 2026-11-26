import { currentRoomGeneration } from "../multiplayer/generation-policy.js";
import { logRateLimited } from "../../lib/log-rate-limit.js";
// ──────────────────────────────────────────────
// Capability lorebook claims: a package that injects some lorebooks itself (the Lorebook Manager's retrieval)
// claims them for a chat, and the Engine's own scanner then skips them, so they aren't injected twice.
//
// A claim feeds the same exclusion list as the user's per-chat "exclude this lorebook", so it drops a book however
// it is attached (chat, character, persona, global) and also covers the World Maps `current_location` entries.
// Nothing is written to the chat: a claim lasts only while the package is active, so an uninstalled or disabled
// package can't leave books silently switched off.
// ──────────────────────────────────────────────

/** What a claim resolver sees: the chat being scanned. */
export interface CapabilityLorebookClaimRequest {
  chatId: string;
  chatMode: string;
  chatMeta: Record<string, unknown>;
}

/**
 * Returns the lorebook ids this package handles itself in this chat. Called on every scan, so it must be
 * synchronous and cheap: answer from state the package keeps in memory (for example its chat bindings).
 */
export type CapabilityLorebookClaimResolver = (request: CapabilityLorebookClaimRequest) => readonly string[] | null;

export interface CapabilityLorebookClaims {
  lorebookIds: string[];
  byPackage: Array<{ packageId: string; packageName: string; lorebookIds: string[] }>;
}

const resolversByPackage = new Map<string, { resolve: CapabilityLorebookClaimResolver; packageName: string }>();

/** Register (or replace) a package's claim resolver. Returns a releaser for deactivation. */
export function registerCapabilityLorebookClaims(
  packageId: string,
  resolver: CapabilityLorebookClaimResolver,
  packageName: string = packageId,
): () => void {
  if (typeof resolver !== "function") throw new Error("Capability lorebook claim resolver is invalid");
  const registration = { resolve: resolver, packageName };
  resolversByPackage.set(packageId, registration);
  return () => {
    if (resolversByPackage.get(packageId) === registration) resolversByPackage.delete(packageId);
  };
}

/**
 * Every active package's claims for this chat. A resolver that throws or returns something odd claims nothing.
 * Skipped in hosted multiplayer rooms, like prompt-context contributors: a claimed book is only safe to skip when
 * the claiming package will inject it, and package context doesn't run there.
 */
export function collectCapabilityLorebookClaims(request: CapabilityLorebookClaimRequest): CapabilityLorebookClaims {
  if (resolversByPackage.size === 0 || currentRoomGeneration()) return { lorebookIds: [], byPackage: [] };
  const all = new Set<string>();
  const byPackage: CapabilityLorebookClaims["byPackage"] = [];
  for (const [packageId, { resolve, packageName }] of resolversByPackage) {
    try {
      const claimed = resolve(request);
      if (!Array.isArray(claimed)) continue;
      const ids = [
        ...new Set(
          claimed.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()),
        ),
      ];
      if (ids.length === 0) continue;
      for (const id of ids) all.add(id);
      byPackage.push({ packageId, packageName, lorebookIds: ids });
    } catch (error) {
      logRateLimited(
        "warn",
        `lorebook-claims:${packageId}`,
        error,
        "[capability] lorebook claim resolver failed for %s",
        packageId,
      );
    }
  }
  return { lorebookIds: [...all], byPackage };
}

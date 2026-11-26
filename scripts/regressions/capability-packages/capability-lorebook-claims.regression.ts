/**
 * Capability API 1.839: a package that injects some lorebooks itself claims them for a chat, and the Engine's scan
 * skips them however they are attached (global here), the World Maps `current_location` entries included. Claims
 * only apply when the caller passes the chat id, die with the package's registration, and a broken or async
 * resolver claims nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-lorebook-claims-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const { getDB, closeDB } = await import("../../../packages/server/src/db/connection.js");
const { createLorebooksStorage } = await import("../../../packages/server/src/services/storage/lorebooks.storage.js");
const { processLorebooks } = await import("../../../packages/server/src/services/lorebook/index.js");
const { resolveLorebookScopeExclusions } =
  await import("../../../packages/server/src/services/lorebook/game-lorebook-scope.js");
const { registerCapabilityLorebookClaims, collectCapabilityLorebookClaims } =
  await import("../../../packages/server/src/services/capability-packages/capability-lorebook-claims.service.js");
const { registerCapabilityPromptContext } =
  await import("../../../packages/server/src/services/capability-packages/capability-prompt-context.service.js");
const { createClaimedLorebookRescan, injectCapabilityContexts } =
  await import("../../../packages/server/src/services/generation/capability-prompt-runtime.js");

const db = await getDB();
try {
  const lorebooks = createLorebooksStorage(db);
  const create = (name: string) =>
    lorebooks.create({ name, isGlobal: true } as Parameters<typeof lorebooks.create>[0]) as Promise<{ id: string }>;
  const managed = await create("Fae Courts");
  const plain = await create("Weather");
  const entry = (lorebookId: string, name: string, keys: string[]) =>
    lorebooks.createEntry({ lorebookId, name, keys, content: `${name} lore.` } as Parameters<
      typeof lorebooks.createEntry
    >[0]) as Promise<{ id: string }>;
  const court = await entry(managed.id, "Unseelie Court", ["court"]);
  const hall = await entry(managed.id, "Moonlit Hall", []);
  const rain = await entry(plain.id, "Rain", ["court"]);

  const scan = (chatId: string | undefined) => {
    const exclusions = resolveLorebookScopeExclusions("roleplay", {}, { chatId });
    return processLorebooks(db, [{ role: "user", content: "We reach the court." }], null, {
      chatId,
      characterIds: [],
      activeLorebookIds: [],
      // World Maps' current location injects this entry through the same scan.
      forcedEntryIds: [hall.id],
      ...exclusions,
    });
  };

  const before = await scan("chat-1");
  assert.deepEqual(before.activatedEntryIds.sort(), [court.id, hall.id, rain.id].sort(), "nothing claimed yet");

  const seen: unknown[] = [];
  const release = registerCapabilityLorebookClaims(
    "lorebook-manager",
    (request) => {
      seen.push(request);
      return request.chatId === "chat-1" ? [managed.id, ` ${managed.id} `, "", 7 as never] : null;
    },
    "Lorebook Manager",
  );
  const brokenRelease = registerCapabilityLorebookClaims("broken", () => {
    throw new Error("boom");
  });
  const asyncRelease = registerCapabilityLorebookClaims("async", (() =>
    Promise.resolve([plain.id])) as unknown as Parameters<typeof registerCapabilityLorebookClaims>[1]);
  // A rejected promise must be swallowed, not left as an unhandled rejection that crashes the server.
  const rejectingRelease = registerCapabilityLorebookClaims("rejecting", (() =>
    Promise.reject(new Error("late boom"))) as unknown as Parameters<typeof registerCapabilityLorebookClaims>[1]);

  assert.deepEqual(collectCapabilityLorebookClaims({ chatId: "chat-1", chatMode: "roleplay", chatMeta: {} }), {
    lorebookIds: [managed.id],
    byPackage: [{ packageId: "lorebook-manager", packageName: "Lorebook Manager", lorebookIds: [managed.id] }],
  });
  assert.deepEqual(seen.at(-1), { chatId: "chat-1", chatMode: "roleplay", chatMeta: {} });

  const claimed = await scan("chat-1");
  assert.deepEqual(claimed.activatedEntryIds, [rain.id], "claimed book skipped, current_location entry included");

  const otherChat = await scan("chat-2");
  assert.deepEqual(otherChat.activatedEntryIds.sort(), [court.id, hall.id, rain.id].sort(), "claims are per chat");

  assert.deepEqual(
    resolveLorebookScopeExclusions("roleplay", { excludedLorebookIds: ["user-off"] }).excludedLorebookIds,
    ["user-off"],
    "without a chat id (membership checks, includes) claims don't apply",
  );
  assert.deepEqual(
    resolveLorebookScopeExclusions("roleplay", { excludedLorebookIds: ["user-off"] }, { chatId: "chat-1" })
      .excludedLorebookIds,
    ["user-off", managed.id],
    "claims add to the user's own exclusions",
  );

  release();
  brokenRelease();
  asyncRelease();
  rejectingRelease();
  const released = await scan("chat-1");
  assert.deepEqual(released.activatedEntryIds.sort(), [court.id, hall.id, rain.id].sort(), "released with the package");

  // Releasing a stale registration must not remove a newer one for the same package.
  const first = registerCapabilityLorebookClaims("lorebook-manager", () => [managed.id]);
  registerCapabilityLorebookClaims("lorebook-manager", () => [plain.id]);
  first();
  assert.deepEqual(
    collectCapabilityLorebookClaims({ chatId: "chat-1", chatMode: "roleplay", chatMeta: {} }).lorebookIds,
    [plain.id],
  );

  // Fallback: a claiming package whose contributor fails gets its claimed books re-scanned, so no lore is lost.
  const rescan = createClaimedLorebookRescan(db, {
    chatId: "chat-1",
    chatMode: "roleplay",
    chatMeta: {},
    scanMessages: () => [{ role: "user", content: "We reach the court." }],
    characterIds: [],
    activeLorebookIds: [],
    forcedEntryIds: [hall.id, rain.id],
    wrapFormat: "xml",
  });
  const fallbackText = await rescan([managed.id]);
  assert.ok(fallbackText?.startsWith("<world_info>"), String(fallbackText));
  assert.match(fallbackText!, /Unseelie Court lore\./);
  assert.match(fallbackText!, /Moonlit Hall lore\./, "current-location entries of claimed books come back too");
  assert.doesNotMatch(fallbackText!, /Rain lore/, "only the claimed books are re-scanned");

  const releaseClaim = registerCapabilityLorebookClaims("lorebook-manager", () => [managed.id]);
  const request = { chatId: "chat-1", chatMeta: {}, mode: "roleplay", wrapFormat: "xml" as const };
  const systemPrompt = () => [{ role: "system" as const, content: "System." }];
  let rescans = 0;
  const countingRescan = async (ids: string[]) => {
    rescans += 1;
    return rescan(ids);
  };

  const releaseBroken = registerCapabilityPromptContext("lorebook-manager", () => {
    throw new Error("retrieval crashed");
  });
  const brokenMessages = systemPrompt();
  await injectCapabilityContexts(brokenMessages, request, db, new Map(), { rescanClaimedLorebooks: countingRescan });
  assert.equal(rescans, 1);
  assert.match(brokenMessages[0]!.content, /Unseelie Court lore\./, "the failed package's lore is put back");
  releaseBroken();

  const releaseWorking = registerCapabilityPromptContext("lorebook-manager", () => "Compendium picks.");
  const workingMessages = systemPrompt();
  await injectCapabilityContexts(workingMessages, request, db, new Map(), { rescanClaimedLorebooks: countingRescan });
  assert.equal(rescans, 1, "no rescan when the package delivered");
  assert.doesNotMatch(workingMessages[0]!.content, /Unseelie Court lore/);
  assert.match(workingMessages[0]!.content, /Compendium picks\./);
  releaseWorking();
  releaseClaim();

  // Let a swallowed rejection settle before the process could report it as unhandled.
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.log("capability-lorebook-claims regression passed");
} finally {
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

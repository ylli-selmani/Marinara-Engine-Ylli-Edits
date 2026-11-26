/**
 * Capability API 1.839: entry-level lorebook reads and writes on `api.runtime.resources`, for packages that manage
 * lorebooks (the Lorebook Manager). Summaries carry no content; create returns the stored entry with its id; update
 * validates like the editor, keeps unrelated fields, refuses locked entries unless the patch only unlocks them, and
 * keeps a character's embedded book in sync.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CharacterData } from "../../packages/shared/src/index.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-resources-lorebook-entries-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createCapabilityResourceHost } =
  await import("../../packages/server/src/services/capability-packages/capability-resources.service.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { embedLorebookIntoCharacter } =
  await import("../../packages/server/src/services/lorebook/character-book-sync.js");

const db = await getDB();
try {
  const resources = createCapabilityResourceHost(db);
  const lorebooks = createLorebooksStorage(db);
  const book = (await lorebooks.create({ name: "Fae Courts", description: "Courts", isGlobal: true } as never)) as {
    id: string;
  };
  assert.ok(book);

  // Create returns the stored entry with its id, and typed relationship keys survive the schema.
  const court = await resources.createLorebookEntry!(book.id, {
    name: "Unseelie Court",
    content: "The night court.",
    description: "The court of night.",
    keys: ["unseelie"],
    tag: "faction",
  });
  assert.ok(court.id);
  assert.equal(court.lorebookId, book.id);
  assert.equal(court.data.name, "Unseelie Court");
  const queen = await resources.createLorebookEntry!(book.id, {
    name: "Syliveera",
    content: "Queen of the Unseelie Court.",
    keys: ["syliveera"],
    relationships: { [court.id]: "leads", "char:c1": "related_to" },
  });
  await assert.rejects(resources.createLorebookEntry!("missing-book", { name: "Nobody" }), /not found/);

  // Summaries: no content, keys and relationships intact, book settings carried.
  const [summary] = await resources.listLorebookSummaries!([book.id, "missing-book"]);
  assert.ok(summary);
  assert.equal(summary.isGlobal, true);
  assert.equal(summary.entries.length, 2);
  const queenSummary = summary.entries.find((entry) => entry.id === queen.id)!;
  assert.equal("content" in queenSummary, false);
  assert.deepEqual(queenSummary.relationships, { [court.id]: "leads", "char:c1": "related_to" });
  assert.deepEqual(queenSummary.keys, ["syliveera"]);

  // Update changes only what the patch names.
  const updated = await resources.updateLorebookEntry!(queen.id, {
    description: "Queen of night.",
    dynamicState: { status: "crowned" },
  });
  assert.equal(updated?.data.description, "Queen of night.");
  assert.equal(updated?.data.content, "Queen of the Unseelie Court.");
  assert.deepEqual(updated?.data.relationships, { [court.id]: "leads", "char:c1": "related_to" });
  assert.deepEqual(updated?.data.dynamicState, { status: "crowned" });
  assert.equal(await resources.updateLorebookEntry!("missing-entry", { name: "x" }), null);
  await assert.rejects(resources.updateLorebookEntry!(queen.id, { keys: "not-an-array" as never }));

  // Locked entries: refused, except a patch that only unlocks.
  await resources.updateLorebookEntry!(court.id, { locked: true });
  await assert.rejects(resources.updateLorebookEntry!(court.id, { content: "Overwritten" }), /locked/);
  const unlocked = await resources.updateLorebookEntry!(court.id, { locked: false });
  assert.equal(unlocked?.data.locked, false);
  assert.equal(unlocked?.data.content, "The night court.");

  // A character's embedded book follows package writes.
  const characters = createCharactersStorage(db);
  const card = (await characters.create({ name: "Raven", description: "A fae." } as unknown as CharacterData))!;
  await lorebooks.update(book.id, { characterId: card.id } as never);
  await embedLorebookIntoCharacter(db, card.id, book.id);
  await resources.updateLorebookEntry!(court.id, { content: "The night court, renamed." });
  const row = (await characters.getById(card.id)) as { data: string } | null;
  const data = JSON.parse(row!.data) as { character_book?: { entries?: Array<{ content?: string }> } };
  assert.ok(
    data.character_book?.entries?.some((entry) => entry.content === "The night court, renamed."),
    "embedded character book was not synced",
  );

  console.log("capability-resources-lorebook-entries regression passed");
} finally {
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

// Relationship keys are bare entry ids or typed `<kind>:<id>` references (cards, personas, books, map
// locations). Duplicating a lorebook used to drop every key it could not remap, losing card and cross-book links.
import assert from "node:assert/strict";
import {
  formatEntityRef,
  parseEntityRef,
  remapEntryRelationships,
  toRelationshipKey,
} from "../../../packages/shared/src/utils/entity-ref.js";

assert.deepEqual(parseEntityRef("abc"), { kind: "lore", id: "abc", ref: "lore:abc" });
assert.deepEqual(parseEntityRef(" char:c1 "), { kind: "char", id: "c1", ref: "char:c1" });
assert.deepEqual(parseEntityRef("lore:abc"), { kind: "lore", id: "abc", ref: "lore:abc" });
// An unknown prefix is part of a bare id, not a kind.
assert.deepEqual(parseEntityRef("weird:x"), { kind: "lore", id: "weird:x", ref: "lore:weird:x" });
assert.equal(parseEntityRef("   "), null);

assert.equal(formatEntityRef("persona", " p1 "), "persona:p1");
assert.throws(() => formatEntityRef("book", " "));
assert.equal(toRelationshipKey("lore:abc"), "abc");
assert.equal(toRelationshipKey("char:c1"), "char:c1");

const idMap = new Map([
  ["e1", "copy-e1"],
  ["e2", "copy-e2"],
]);
assert.deepEqual(
  remapEntryRelationships(
    {
      e2: "part_of",
      "lore:e1": "related_to",
      "other-book-entry": "located_in",
      "char:c1": "represents",
      "persona:p1": "ally_of",
      "book:b9": "related_to",
      "loc:l3": "maps_to",
    },
    idMap,
  ),
  {
    "copy-e2": "part_of",
    "copy-e1": "related_to",
    "other-book-entry": "located_in",
    "char:c1": "represents",
    "persona:p1": "ally_of",
    "book:b9": "related_to",
    "loc:l3": "maps_to",
  },
);
assert.deepEqual(remapEntryRelationships(null, idMap), {});

console.log("lorebook-entity-ref regression passed");

// Typed references between lorebook entries and the things they link to (`LorebookEntry.relationships` keys).
//
// A key is either a bare entry id (the original form, still what entry-to-entry links store) or a typed
// `<kind>:<id>` reference to a card, persona, lorebook or map location. Packages such as the Lorebook Manager
// write the typed forms, so every Engine path that copies or remaps relationships must understand both.

export type EntityRefKind = "lore" | "char" | "persona" | "book" | "npc" | "item" | "itemdef" | "loc";

export interface ParsedEntityRef {
  kind: EntityRefKind;
  id: string;
  /** Canonical `<kind>:<id>` form. */
  ref: string;
}

export const ENTITY_REF_KINDS: readonly EntityRefKind[] = Object.freeze([
  "lore",
  "char",
  "persona",
  "book",
  "npc",
  "item",
  "itemdef",
  "loc",
]);

const KNOWN_KINDS: ReadonlySet<string> = new Set(ENTITY_REF_KINDS);

/** Parse a relationship key or entity reference. A bare id without a known prefix is a lorebook entry. */
export function parseEntityRef(raw: string): ParsedEntityRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const prefix = trimmed.slice(0, colonIndex);
    const id = trimmed.slice(colonIndex + 1).trim();
    if (KNOWN_KINDS.has(prefix) && id) {
      return { kind: prefix as EntityRefKind, id, ref: `${prefix}:${id}` };
    }
  }
  return { kind: "lore", id: trimmed, ref: `lore:${trimmed}` };
}

/** Build the canonical `<kind>:<id>` reference. */
export function formatEntityRef(kind: EntityRefKind, id: string): string {
  const cleanId = id.trim();
  if (!cleanId) throw new Error(`Cannot format an empty ${kind} entity reference`);
  return `${kind}:${cleanId}`;
}

/** The key a link is stored under in `LorebookEntry.relationships`: bare id for entries, typed for the rest. */
export function toRelationshipKey(targetRef: string): string {
  const parsed = parseEntityRef(targetRef);
  if (!parsed) throw new Error(`Invalid entity reference: ${targetRef}`);
  return parsed.kind === "lore" ? parsed.id : parsed.ref;
}

/**
 * Remap a copied entry's relationships onto the copy's entry ids.
 *
 * Links to entries that were copied along point at their copies. Links to anything else keep pointing where
 * they did: an entry in another lorebook still exists, and a card, persona, lorebook or map location is not
 * part of the copy. Dropping those (the old behaviour) lost every card and cross-book link on duplicate.
 */
export function remapEntryRelationships(
  relationships: Record<string, string> | null | undefined,
  entryIdMap: ReadonlyMap<string, string>,
): Record<string, string> {
  const remapped: Record<string, string> = {};
  if (!relationships) return remapped;
  for (const [key, relation] of Object.entries(relationships)) {
    const parsed = parseEntityRef(key);
    if (!parsed || typeof relation !== "string") continue;
    if (parsed.kind === "lore") {
      remapped[entryIdMap.get(parsed.id) ?? parsed.id] = relation;
    } else {
      remapped[parsed.ref] = relation;
    }
  }
  return remapped;
}

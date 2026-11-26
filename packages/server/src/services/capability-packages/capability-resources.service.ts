import type {
  CapabilityCharacterGroupRecord,
  CapabilityCharacterPage,
  CapabilityCharacterPageOptions,
  CapabilityCharacterRecord,
  CapabilityCharacterRow,
  CapabilityCharacterSummary,
  CapabilityLorebookCreateInput,
  CapabilityLorebookEntryInput,
  CapabilityLorebookEntryPatch,
  CapabilityLorebookEntryRow,
  CapabilityLorebookSummary,
  CapabilityLorebookEntryRecord,
  CapabilityLorebookEntrySelection,
  CapabilityLorebookRecord,
  CapabilityLorebookUpdateInput,
  CapabilityPersonaCreateInput,
  CapabilityPersonaRecord,
  CapabilityPersonaUpdateInput,
  CapabilityResourceHost,
} from "@marinara-engine/shared";
import { createLorebookEntrySchema, updateLorebookEntrySchema } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { syncCharacterBookFromLorebook } from "../lorebook/character-book-sync.js";
import { LIBRARY_PAGE_LIMIT } from "../../utils/list-pagination.js";

type LorebookEntrySource = {
  id: string;
  lorebookId: string;
  name: string;
  content: string;
  description: string;
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  );
}

function entryRow(entry: Record<string, unknown>): CapabilityLorebookEntryRow {
  return { id: String(entry.id), lorebookId: String(entry.lorebookId), data: entry };
}

function characterRow(row: CapabilityCharacterRow): CapabilityCharacterRow {
  return {
    id: row.id,
    data: row.data,
    comment: row.comment ?? "",
    avatarPath: row.avatarPath ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `permissions` are the package's declared ones; reads need none, `updateCharacterExtensions` needs `character-write`. */
export function createCapabilityResourceHost(db: DB, permissions: readonly string[] = []): CapabilityResourceHost {
  const characters = createCharactersStorage(db);
  const lorebooks = createLorebooksStorage(db);
  const canWriteCharacters = permissions.includes("character-write");
  return {
    async getCharacters(characterIds): Promise<CapabilityCharacterRow[]> {
      const rows = characterIds ? await characters.getByIds(characterIds) : await characters.list();
      return rows.map(characterRow);
    },

    async listCharacterGroups(): Promise<CapabilityCharacterGroupRecord[]> {
      return (await characters.listGroups()).map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description ?? "",
        avatarPath: group.avatarPath ?? null,
        characterIds: group.characterIds,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      }));
    },

    async listCharactersPage(options: CapabilityCharacterPageOptions): Promise<CapabilityCharacterPage> {
      // The same bounds the library route puts on a page.
      const limit =
        Number.isFinite(options.limit) && options.limit > 0
          ? Math.min(LIBRARY_PAGE_LIMIT, Math.max(1, Math.trunc(options.limit)))
          : LIBRARY_PAGE_LIMIT;
      const offset = Number.isFinite(options.offset) && options.offset > 0 ? Math.trunc(options.offset) : 0;
      const page = await characters.listPage({ ...options, limit, offset });
      return { ...page, items: page.items.map(characterRow) };
    },

    async listCharacterSummaries(characterIds: string[]): Promise<CapabilityCharacterSummary[]> {
      return characters.listSummariesByIds(characterIds);
    },

    async updateCharacterExtensions(characterId: string, patch: Record<string, unknown>) {
      if (!canWriteCharacters) {
        throw new Error('Writing a character requires the "character-write" permission.');
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("[capability] updateCharacterExtensions takes an object of extension keys");
      }
      // An undefined value would silently delete the key once the card is stored as JSON.
      const undefinedKey = Object.keys(patch).find((key) => patch[key] === undefined);
      if (undefinedKey) {
        throw new Error(
          `[capability] updateCharacterExtensions: "${undefinedKey}" has no value; send null to clear it`,
        );
      }
      const result = await characters.updateExtensions(characterId, patch, { versionSource: "capability-package" });
      return result ? characterRow(result.row) : null;
    },

    async listCharacters(characterIds): Promise<CapabilityCharacterRecord[]> {
      const requestedIds = characterIds ? uniqueStrings(characterIds) : null;
      const records = requestedIds
        ? await Promise.all(requestedIds.map((characterId) => characters.getById(characterId)))
        : await characters.list();
      return records.flatMap((record) =>
        record ? [{ id: record.id, data: record.data, comment: record.comment ?? "" }] : [],
      );
    },

    async listPersonas(personaIds): Promise<CapabilityPersonaRecord[]> {
      const requestedIds = personaIds ? uniqueStrings(personaIds) : null;
      const records = requestedIds
        ? await Promise.all(requestedIds.map((personaId) => characters.getPersona(personaId)))
        : await characters.listPersonas();
      return records.flatMap((record) => (record ? [{ id: record.id, data: record }] : []));
    },

    async listLorebooks(lorebookIds): Promise<CapabilityLorebookRecord[]> {
      const requestedIds = lorebookIds ? uniqueStrings(lorebookIds) : null;
      const records = (
        requestedIds
          ? await Promise.all(requestedIds.map((lorebookId) => lorebooks.getById(lorebookId)))
          : await lorebooks.list()
      ) as Array<({ id: string } & Record<string, unknown>) | null>;
      return Promise.all(
        records
          .flatMap((record) =>
            record ? [{ id: record.id, data: record, entries: lorebooks.listEntries(record.id) }] : [],
          )
          .map(async (record) => ({ ...record, entries: await record.entries })),
      );
    },

    async listLorebookSummaries(lorebookIds): Promise<CapabilityLorebookSummary[]> {
      const requestedIds = lorebookIds ? uniqueStrings(lorebookIds) : null;
      const records = (
        requestedIds
          ? await Promise.all(requestedIds.map((lorebookId) => lorebooks.getById(lorebookId)))
          : await lorebooks.list()
      ) as Array<Record<string, unknown> | null>;
      const books = records.filter((record): record is Record<string, unknown> => Boolean(record));
      const entries = (await lorebooks.listEntriesByLorebooks(
        books.map((book) => String(book.id)),
      )) as unknown as Array<Record<string, unknown>>;
      const entriesByBook = new Map<string, CapabilityLorebookSummary["entries"]>();
      for (const entry of entries) {
        const lorebookId = String(entry.lorebookId);
        const list = entriesByBook.get(lorebookId) ?? [];
        list.push({
          id: String(entry.id),
          lorebookId,
          name: typeof entry.name === "string" ? entry.name : "",
          description: typeof entry.description === "string" ? entry.description : "",
          tag: typeof entry.tag === "string" ? entry.tag : "",
          keys: stringArray(entry.keys),
          secondaryKeys: stringArray(entry.secondaryKeys),
          enabled: entry.enabled !== false,
          constant: entry.constant === true,
          locked: entry.locked === true,
          relationships: stringRecord(entry.relationships),
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        });
        entriesByBook.set(lorebookId, list);
      }
      return books.map((book) => ({
        id: String(book.id),
        name: typeof book.name === "string" ? book.name : "",
        description: typeof book.description === "string" ? book.description : "",
        category: typeof book.category === "string" ? book.category : "uncategorized",
        enabled: book.enabled !== false,
        isGlobal: book.isGlobal === true,
        tokenBudget: typeof book.tokenBudget === "number" ? book.tokenBudget : null,
        entries: entriesByBook.get(String(book.id)) ?? [],
      }));
    },

    async listEligibleLorebookEntries(
      selection: CapabilityLorebookEntrySelection,
    ): Promise<CapabilityLorebookEntryRecord[]> {
      const selectedLorebookIds = uniqueStrings(selection.lorebookIds);
      const selectedEntryIds = uniqueStrings(selection.entryIds);
      const bookEntries = (await lorebooks.listEntriesByLorebooks(
        selectedLorebookIds,
      )) as unknown as LorebookEntrySource[];
      const directEntries = (await Promise.all(selectedEntryIds.map((entryId) => lorebooks.getEntry(entryId)))).filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ) as unknown as LorebookEntrySource[];
      const requestedEntries = Array.from(
        new Map([...bookEntries, ...directEntries].map((entry) => [entry.id, entry])).values(),
      );
      const eligibleEntries = (await lorebooks.listEligibleEntriesByIds(
        requestedEntries.map((entry) => entry.id),
        {
          excludedLorebookIds: selection.excludedLorebookIds,
          excludedSourceAgentIds: selection.excludedSourceAgentIds,
        },
      )) as unknown as LorebookEntrySource[];
      const eligibleById = new Map(eligibleEntries.map((entry) => [entry.id, entry]));
      const orderedEntries = requestedEntries.flatMap((entry) => eligibleById.get(entry.id) ?? []);
      const books = (await lorebooks.list()) as unknown as Array<{ id: string; name: string }>;
      const bookNameById = new Map(books.map((book) => [book.id, book.name]));

      return orderedEntries.map((entry) => ({
        id: entry.id,
        lorebookId: entry.lorebookId,
        lorebookName: bookNameById.get(entry.lorebookId) ?? "Unknown lorebook",
        name: entry.name,
        content: entry.content,
        description: entry.description,
      }));
    },

    // Write surface — thin passthroughs to storage. The capability input types are declared narrowly
    // enough to hand straight to it, so nothing here needs a cast.
    async createPersona(input: CapabilityPersonaCreateInput): Promise<CapabilityPersonaRecord> {
      const record = await characters.createPersona(input.name, input.description, input.avatarPath, {
        comment: input.comment,
        appearance: input.appearance,
        tags: input.tags,
      });
      if (!record) throw new Error("[capability] createPersona failed");
      return { id: record.id, data: record };
    },

    async updatePersona(personaId: string, updates: CapabilityPersonaUpdateInput): Promise<void> {
      await characters.updatePersona(personaId, updates);
    },

    async createLorebook(input: CapabilityLorebookCreateInput): Promise<CapabilityLorebookRecord> {
      const record = (await lorebooks.create(input)) as ({ id: string } & Record<string, unknown>) | null;
      if (!record) throw new Error("[capability] createLorebook failed");
      return { id: record.id, data: record, entries: [] };
    },

    async updateLorebook(lorebookId: string, updates: CapabilityLorebookUpdateInput): Promise<void> {
      await lorebooks.update(lorebookId, updates);
    },

    async bulkCreateLorebookEntries(lorebookId: string, entries: CapabilityLorebookEntryInput[]): Promise<void> {
      await lorebooks.bulkCreateEntries(lorebookId, entries);
    },

    async createLorebookEntry(
      lorebookId: string,
      entry: CapabilityLorebookEntryInput,
    ): Promise<CapabilityLorebookEntryRow> {
      if (!(await lorebooks.getById(lorebookId))) throw new Error(`[capability] Lorebook ${lorebookId} not found`);
      const input = createLorebookEntrySchema.parse({ ...entry, lorebookId });
      const created = await db.transaction(async (tx) => {
        const record = await createLorebooksStorage(tx).createEntry(input);
        await syncCharacterBookFromLorebook(tx, lorebookId, { throwOnError: true });
        return record;
      });
      if (!created) throw new Error("[capability] createLorebookEntry failed");
      return entryRow(created as unknown as Record<string, unknown>);
    },

    async updateLorebookEntry(
      entryId: string,
      patch: CapabilityLorebookEntryPatch,
    ): Promise<CapabilityLorebookEntryRow | null> {
      const input = updateLorebookEntrySchema.parse(patch);
      const changedKeys = Object.entries(input).flatMap(([key, value]) => (value === undefined ? [] : [key]));
      const onlyUnlocks = changedKeys.length === 1 && changedKeys[0] === "locked" && input.locked === false;
      const updated = await db.transaction(async (tx) => {
        const storage = createLorebooksStorage(tx);
        // Read inside the transaction, so a lock saved just before this write still refuses it.
        const existing = (await storage.getEntry(entryId)) as unknown as Record<string, unknown> | null;
        if (!existing) return null;
        if (existing.locked === true && !onlyUnlocks) throw new Error("[capability] Lorebook entry is locked");
        const lorebookId = String(existing.lorebookId);
        const record = await storage.updateEntry(entryId, input);
        if (record) await syncCharacterBookFromLorebook(tx, lorebookId, { throwOnError: true });
        return record;
      });
      return updated ? entryRow(updated as unknown as Record<string, unknown>) : null;
    },

    async removeLorebookEntry(entryId: string): Promise<void> {
      await lorebooks.removeEntry(entryId);
    },
  };
}

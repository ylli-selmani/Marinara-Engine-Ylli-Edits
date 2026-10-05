import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseTagCsv, type ParsedTagCsv, type TagRecord } from "@marinara-engine/shared";

import { clearStoredVocabulary, loadStoredVocabulary, saveStoredVocabulary } from "../lib/tag-vocabulary-store";

/** The repair report for the last import, kept so the UI can explain what changed. */
export type TagImportReport = Omit<ParsedTagCsv, "tags">;

/**
 * Holds the user-supplied tag vocabulary for booru-style autocomplete.
 *
 * Marinara ships no tag data, so this stays empty until the user imports a CSV.
 * The settings persist through localStorage (zustand's `persist`), but the parsed
 * records are far too large for that quota and live in IndexedDB instead; see
 * `tag-vocabulary-store.ts`. `hydrate()` restores them on startup.
 */
interface TagAutocompleteState {
  /** Enable completion in opted-in fields. Off by default. */
  enabled: boolean;
  /** Append ", " after an inserted tag. */
  appendComma: boolean;
  /** Name of the imported CSV, for display only. */
  sourceName: string;
  /** Number of tags in the current vocabulary. */
  tagCount: number;
  /** What the last import had to repair, for the import dialog's summary. */
  lastReport: TagImportReport | null;
  /** True once the stored vocabulary has been read, so the UI can avoid flashing. */
  hydrated: boolean;

  /** In-memory vocabulary, mirrored to IndexedDB on import. */
  tags: TagRecord[];

  setEnabled: (enabled: boolean) => void;
  setAppendComma: (appendComma: boolean) => void;
  importCsv: (text: string, sourceName: string) => { count: number; report: TagImportReport };
  clearTags: () => void;
  /** Restores the vocabulary saved by a previous session. */
  hydrate: () => Promise<void>;
}

export const useTagAutocompleteStore = create<TagAutocompleteState>()(
  persist(
    (set) => ({
      enabled: false,
      appendComma: true,
      sourceName: "",
      tagCount: 0,
      lastReport: null,
      hydrated: false,
      tags: [],

      setEnabled: (enabled) => set({ enabled }),
      setAppendComma: (appendComma) => set({ appendComma }),

      importCsv: (text, sourceName) => {
        const { tags, ...report } = parseTagCsv(text);
        set({ tags, tagCount: tags.length, sourceName, lastReport: report, hydrated: true });
        // Persist in the background; a failure only costs the next reload.
        void saveStoredVocabulary(tags, sourceName);
        return { count: tags.length, report };
      },

      clearTags: () => {
        set({ tags: [], tagCount: 0, sourceName: "", lastReport: null, hydrated: true });
        void clearStoredVocabulary();
      },

      hydrate: async () => {
        const stored = await loadStoredVocabulary();
        set((state) => {
          // Don't clobber a vocabulary imported while the read was in flight.
          if (state.tags.length > 0) return { hydrated: true };
          if (!stored) return { hydrated: true };
          return {
            tags: stored.tags,
            tagCount: stored.tags.length,
            sourceName: stored.sourceName,
            hydrated: true,
          };
        });
      },
    }),
    {
      name: "marinara-tag-autocomplete",
      // `tags` and `lastReport` are intentionally excluded: both are rebuilt per session.
      partialize: (state) => ({
        enabled: state.enabled,
        appendComma: state.appendComma,
      }),
    },
  ),
);

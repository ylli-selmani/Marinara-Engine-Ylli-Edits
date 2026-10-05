import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseTagCsv, type ParsedTagCsv, type TagRecord } from "@marinara-engine/shared";

/** The repair report for the last import, kept so the UI can explain what changed. */
export type TagImportReport = Omit<ParsedTagCsv, "tags">;

/**
 * Holds the user-supplied tag vocabulary for booru-style autocomplete.
 *
 * Marinara ships no tag data, so this stays empty until the user imports a CSV.
 * The parsed records are never persisted — a 125k-tag scrape would blow the
 * localStorage quota — so only the settings and the source filename survive a
 * reload. The settings panel reports the empty state when that happens.
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

  /** In-memory vocabulary. Not persisted. */
  tags: TagRecord[];

  setEnabled: (enabled: boolean) => void;
  setAppendComma: (appendComma: boolean) => void;
  importCsv: (text: string, sourceName: string) => { count: number; report: TagImportReport };
  clearTags: () => void;
}

export const useTagAutocompleteStore = create<TagAutocompleteState>()(
  persist(
    (set) => ({
      enabled: false,
      appendComma: true,
      sourceName: "",
      tagCount: 0,
      lastReport: null,
      tags: [],

      setEnabled: (enabled) => set({ enabled }),
      setAppendComma: (appendComma) => set({ appendComma }),

      importCsv: (text, sourceName) => {
        const { tags, ...report } = parseTagCsv(text);
        set({ tags, tagCount: tags.length, sourceName, lastReport: report });
        return { count: tags.length, report };
      },

      clearTags: () => set({ tags: [], tagCount: 0, sourceName: "", lastReport: null }),
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

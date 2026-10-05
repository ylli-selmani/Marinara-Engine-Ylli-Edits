import { create } from "zustand";
import { persist } from "zustand/middleware";

import { parseTagCsv, type TagRecord } from "../lib/tag-autocomplete";

/**
 * Holds the user-supplied tag vocabulary for booru-style autocomplete.
 *
 * Marinara ships no tag data, so this is empty until the user imports a CSV.
 * The records themselves are never persisted to localStorage — a 3 MB scrape
 * would blow the quota — only the settings and the source filename are.
 */
interface TagAutocompleteState {
  /** Enable completion in opted-in fields. Off by default. */
  enabled: boolean;
  /** Append ", " after an inserted tag. */
  appendComma: boolean;
  /** Max suggestions rendered at once. */
  maxResults: number;
  /** Name of the imported CSV, for display only. */
  sourceName: string;
  /** Number of tags in the current vocabulary. */
  tagCount: number;

  /** In-memory vocabulary. Not persisted. */
  tags: TagRecord[];

  setEnabled: (enabled: boolean) => void;
  setAppendComma: (appendComma: boolean) => void;
  setMaxResults: (maxResults: number) => void;
  importCsv: (text: string, sourceName: string) => number;
  clearTags: () => void;
}

export const useTagAutocompleteStore = create<TagAutocompleteState>()(
  persist(
    (set) => ({
      enabled: false,
      appendComma: true,
      maxResults: 20,
      sourceName: "",
      tagCount: 0,
      tags: [],

      setEnabled: (enabled) => set({ enabled }),
      setAppendComma: (appendComma) => set({ appendComma }),
      setMaxResults: (maxResults) => set({ maxResults: Math.min(Math.max(maxResults, 5), 100) }),

      importCsv: (text, sourceName) => {
        const tags = parseTagCsv(text);
        set({ tags, tagCount: tags.length, sourceName });
        return tags.length;
      },

      clearTags: () => set({ tags: [], tagCount: 0, sourceName: "" }),
    }),
    {
      name: "marinara-tag-autocomplete",
      // `tags` is intentionally excluded: it is re-imported per session.
      partialize: (state) => ({
        enabled: state.enabled,
        appendComma: state.appendComma,
        maxResults: state.maxResults,
      }),
    },
  ),
);

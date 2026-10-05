import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseTagCsv, type ParsedTagCsv, type TagRecord } from "@marinara-engine/shared";

import { clearStoredVocabulary, loadStoredVocabulary, saveStoredVocabulary } from "../lib/tag-vocabulary-store";

/** The repair report for the last import, kept so the UI can explain what changed. */
export type TagImportReport = Omit<ParsedTagCsv, "tags">;

/**
 * Categories offered as suggestions, following the Danbooru numbering.
 *
 * Filtering matters more than it looks: on a 125,865-tag export, general tags are
 * only 24.7% of the vocabulary, while artists are 39.0% and characters 29.0%. Most
 * prompt writing wants general tags, so disabling the other two removes roughly
 * three quarters of the candidate set — fewer useless suggestions, and less work
 * per keystroke.
 */
export const TAG_CATEGORY_OPTIONS = [
  { category: 0, labelKey: "settings.tagAutocomplete.categoryGeneral" },
  { category: 1, labelKey: "settings.tagAutocomplete.categoryArtist" },
  { category: 3, labelKey: "settings.tagAutocomplete.categoryCopyright" },
  { category: 4, labelKey: "settings.tagAutocomplete.categoryCharacter" },
  { category: 5, labelKey: "settings.tagAutocomplete.categoryMeta" },
] as const;

/**
 * General and artist are on by default; the rest are opt-in.
 *
 * Style presets are dominated by general tags and artist names, which is what
 * people actually write in an image prompt. Characters and copyrights are usually
 * noise there, and together they are 36% of a typical export, so defaulting them
 * off makes the common case both quieter and cheaper. A category only appears in
 * the settings when the imported CSV actually contains it.
 */
export const DEFAULT_ENABLED_CATEGORIES: number[] = [0, 1];
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
  /** Categories offered as suggestions. Everything is on until the user narrows it. */
  enabledCategories: number[];
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
  setCategoryEnabled: (category: number, enabled: boolean) => void;
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
      enabledCategories: [...DEFAULT_ENABLED_CATEGORIES],

      setEnabled: (enabled) => set({ enabled }),
      setAppendComma: (appendComma) => set({ appendComma }),

      setCategoryEnabled: (category, enabled) =>
        set((state) => {
          const next = new Set(state.enabledCategories);
          if (enabled) next.add(category);
          else next.delete(category);
          // Never let every category be switched off: that silently disables
          // completion with no explanation, which reads as a broken feature.
          if (next.size === 0) return {};
          return { enabledCategories: [...next].sort((a, b) => a - b) };
        }),

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
        enabledCategories: state.enabledCategories,
      }),
    },
  ),
);

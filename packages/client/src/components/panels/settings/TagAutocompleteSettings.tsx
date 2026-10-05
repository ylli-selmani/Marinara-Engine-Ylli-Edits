import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Trash2 } from "lucide-react";

import { TAG_CATEGORY_OPTIONS, useTagAutocompleteStore } from "../../../stores/tag-autocomplete.store";
import { ToggleSetting } from "./SettingControls";
import { TagCsvImportDialog } from "./TagCsvImportDialog";

export const TAG_AUTOCOMPLETE_CONTROL_ID = "tag-autocomplete";

/**
 * Settings > Advanced: booru tag autocomplete for image prompt fields.
 *
 * Marinara ships no tag data. The vocabulary always comes from a CSV the user
 * imports — the same `<name>,<type>,<postCount>,"<aliases>"` layout the a1111
 * tagcomplete extension uses, so an existing Danbooru export works as-is. Import
 * opens a preview dialog rather than replacing the vocabulary on file pick,
 * because these files are large and easy to grab the wrong one of.
 */
export function TagAutocompleteSettings({ anchorId }: { anchorId?: string }) {
  const { t } = useTranslation();
  const [importOpen, setImportOpen] = useState(false);

  const enabled = useTagAutocompleteStore((state) => state.enabled);
  const appendComma = useTagAutocompleteStore((state) => state.appendComma);
  const enabledCategories = useTagAutocompleteStore((state) => state.enabledCategories);
  const tags = useTagAutocompleteStore((state) => state.tags);
  const tagCount = useTagAutocompleteStore((state) => state.tagCount);
  const sourceName = useTagAutocompleteStore((state) => state.sourceName);
  const hydrated = useTagAutocompleteStore((state) => state.hydrated);
  const setEnabled = useTagAutocompleteStore((state) => state.setEnabled);
  const setAppendComma = useTagAutocompleteStore((state) => state.setAppendComma);
  const setCategoryEnabled = useTagAutocompleteStore((state) => state.setCategoryEnabled);
  const clearTags = useTagAutocompleteStore((state) => state.clearTags);

  // Only offer categories the imported CSV actually contains, with a count so the
  // choice is informed — a small export may have no characters or copyrights at
  // all, and a toggle for an empty category is just noise.
  const availableCategories = useMemo(() => {
    if (tags.length === 0) return [];

    const counts = new Map<number, number>();
    for (const tag of tags) counts.set(tag.category, (counts.get(tag.category) ?? 0) + 1);

    return TAG_CATEGORY_OPTIONS.flatMap((option) => {
      const count = counts.get(option.category) ?? 0;
      return count > 0 ? [{ ...option, count }] : [];
    });
  }, [tags]);

  return (
    <div id={anchorId} className="flex scroll-mt-3 flex-col gap-2">
      <ToggleSetting
        label={t("settings.tagAutocomplete.enable")}
        checked={enabled}
        onChange={setEnabled}
        help={t("settings.tagAutocomplete.enableHelp")}
      />
      <ToggleSetting
        label={t("settings.tagAutocomplete.appendComma")}
        checked={appendComma}
        onChange={setAppendComma}
        help={t("settings.tagAutocomplete.appendCommaHelp")}
      />

      {availableCategories.length > 1 ? (
        <div className="flex flex-col gap-1 border-t border-[var(--border)] px-1.5 pt-2">
          <p className="text-[0.6875rem] font-medium text-[var(--foreground)]">
            {t("settings.tagAutocomplete.categoriesTitle")}
          </p>
          <p className="pb-1 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            {t("settings.tagAutocomplete.categoriesHelp")}
          </p>
          {availableCategories.map((option) => (
            <ToggleSetting
              key={option.category}
              label={t(option.labelKey)}
              checked={enabledCategories.includes(option.category)}
              onChange={(next) => setCategoryEnabled(option.category, next)}
              help={t("settings.tagAutocomplete.categoryCount", { count: option.count.toLocaleString() })}
            />
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 px-1.5 pt-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
          >
            <FileUp className="h-3 w-3" />
            {t("settings.tagAutocomplete.importCsv")}
          </button>
          {tagCount > 0 ? (
            <button
              type="button"
              onClick={clearTags}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--destructive)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            >
              <Trash2 className="h-3 w-3" />
              {t("settings.tagAutocomplete.clear")}
            </button>
          ) : null}
        </div>
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {!hydrated
            ? t("settings.tagAutocomplete.loadingVocabulary")
            : tagCount > 0
              ? t("settings.tagAutocomplete.loaded", { count: tagCount.toLocaleString(), name: sourceName })
              : t("settings.tagAutocomplete.noVocabulary")}
        </p>
      </div>

      <TagCsvImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useTagAutocompleteStore } from "../../../stores/tag-autocomplete.store";
import { ToggleSetting } from "./SettingControls";

export const TAG_AUTOCOMPLETE_CONTROL_ID = "tag-autocomplete";

/**
 * Settings > Advanced: booru tag autocomplete for image prompt fields.
 *
 * Marinara ships no tag data. The vocabulary always comes from a CSV the user
 * imports here — the same `<name>,<type>,<postCount>,"<aliases>"` layout the
 * a1111 tagcomplete extension uses, so an existing Danbooru export works as-is.
 */
export function TagAutocompleteSettings({ anchorId }: { anchorId?: string }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const enabled = useTagAutocompleteStore((state) => state.enabled);
  const appendComma = useTagAutocompleteStore((state) => state.appendComma);
  const tagCount = useTagAutocompleteStore((state) => state.tagCount);
  const sourceName = useTagAutocompleteStore((state) => state.sourceName);
  const setEnabled = useTagAutocompleteStore((state) => state.setEnabled);
  const setAppendComma = useTagAutocompleteStore((state) => state.setAppendComma);
  const importCsv = useTagAutocompleteStore((state) => state.importCsv);
  const clearTags = useTagAutocompleteStore((state) => state.clearTags);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const count = importCsv(text, file.name);
      if (count === 0) {
        toast.error(t("settings.tagAutocomplete.importEmpty"));
        return;
      }
      toast.success(t("settings.tagAutocomplete.imported", { count: count.toLocaleString() }));
    } catch {
      toast.error(t("settings.tagAutocomplete.importFailed"));
    } finally {
      setImporting(false);
      // Reset so re-picking the same file still fires a change event.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

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

      <div className="flex flex-col gap-1.5 px-1.5 pt-1">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={importing}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <FileUp className="h-3 w-3" />
            {importing ? t("settings.tagAutocomplete.importing") : t("settings.tagAutocomplete.importCsv")}
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
          {tagCount > 0
            ? t("settings.tagAutocomplete.loaded", { count: tagCount.toLocaleString(), name: sourceName })
            : t("settings.tagAutocomplete.noVocabulary")}
        </p>
      </div>
    </div>
  );
}

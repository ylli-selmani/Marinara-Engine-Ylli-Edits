import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FileUp, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { parseTagCsv, TAG_CSV_MAX_CHARS } from "@marinara-engine/shared";

import { useTagAutocompleteStore } from "../../../stores/tag-autocomplete.store";
import { Modal } from "../../ui/Modal";

/** Rows rendered in the issue and preview lists, to keep a huge file cheap. */
const PREVIEW_LIMIT = 100;

/**
 * Imports a booru tag CSV, previewing what will be stored before committing it.
 *
 * The vocabulary is large and user-supplied, so a silent import is the wrong
 * default: a mis-picked file or a partially downloaded export should be visible
 * as a row count and a list of problems before it replaces anything. The same
 * parser runs here and wherever the file is read later, so the preview cannot
 * disagree with the result.
 */
export function TagCsvImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  const importCsv = useTagAutocompleteStore((state) => state.importCsv);
  const setEnabled = useTagAutocompleteStore((state) => state.setEnabled);

  const parsed = useMemo(() => (text.trim() ? parseTagCsv(text) : null), [text]);
  const errors = parsed?.issues.filter((issue) => issue.severity === "error") ?? [];
  const warnings = parsed?.issues.filter((issue) => issue.severity === "warning") ?? [];
  const tooLarge = text.length > TAG_CSV_MAX_CHARS;
  const canImport = !!parsed && parsed.tags.length > 0 && !tooLarge && !importing;

  const reset = () => {
    setText("");
    setFileName("");
  };

  const close = () => {
    if (importing) return;
    reset();
    onClose();
  };

  const loadText = (value: string, name = "") => {
    setText(value);
    setFileName(name);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    loadText(await file.text(), file.name);
  };

  const handleImport = () => {
    if (!canImport) return;
    setImporting(true);
    try {
      const { count, report } = importCsv(text, fileName || t("settings.tagAutocomplete.pastedVocabulary"));
      setEnabled(true);

      if (report.skippedRows > 0 || report.repairedRows > 0) {
        toast.warning(
          t("settings.tagAutocomplete.importedWithIssues", {
            count: count.toLocaleString(),
            skipped: report.skippedRows.toLocaleString(),
            repaired: report.repairedRows.toLocaleString(),
          }),
        );
      } else {
        toast.success(t("settings.tagAutocomplete.imported", { count: count.toLocaleString() }));
      }

      reset();
      onClose();
    } catch {
      toast.error(t("settings.tagAutocomplete.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("settings.tagAutocomplete.importTitle")}
      width="max-w-2xl"
      closeDisabled={importing}
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          {t("settings.tagAutocomplete.importDescription")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--accent)]"
          >
            <FileUp size="0.8125rem" />
            {t("settings.tagAutocomplete.chooseFile")}
          </button>
          {fileName ? (
            <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">{fileName}</span>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <textarea
          value={text}
          onChange={(event) => loadText(event.target.value, fileName)}
          placeholder={t("settings.tagAutocomplete.pastePlaceholder")}
          aria-label={t("settings.tagAutocomplete.pasteLabel")}
          spellCheck={false}
          className="mari-editor-field block h-32 w-full resize-y px-3 py-2 font-mono text-xs"
        />

        {tooLarge ? (
          <p className="text-xs text-[var(--destructive)]">{t("settings.tagAutocomplete.fileTooLarge")}</p>
        ) : null}

        {parsed ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <span className="font-medium">
                {t("settings.tagAutocomplete.readyCount", { count: parsed.tags.length.toLocaleString() })}
              </span>
              {parsed.skippedRows > 0 ? (
                <span className="text-amber-500">
                  {t("settings.tagAutocomplete.skippedCount", { count: parsed.skippedRows.toLocaleString() })}
                </span>
              ) : null}
              {parsed.repairedRows > 0 ? (
                <span className="text-amber-500">
                  {t("settings.tagAutocomplete.repairedCount", { count: parsed.repairedRows.toLocaleString() })}
                </span>
              ) : null}
              {errors.length > 0 ? (
                <span className="text-[var(--destructive)]">
                  {t("settings.tagAutocomplete.errorCount", { count: errors.length })}
                </span>
              ) : null}
            </div>

            {warnings.length > 0 ? (
              <ul className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] p-2 text-xs">
                {warnings.slice(0, PREVIEW_LIMIT).map((issue, index) => (
                  <li key={`${issue.code}-${issue.line}-${index}`} className="flex items-start gap-1.5">
                    <AlertTriangle size="0.75rem" className="mt-0.5 shrink-0 text-amber-500" />
                    <span className="min-w-0 break-words">
                      {issue.line !== null ? (
                        <span className="text-[var(--muted-foreground)]">
                          {t("settings.tagAutocomplete.lineLabel", { line: issue.line })}{" "}
                        </span>
                      ) : null}
                      {t(`settings.tagAutocomplete.issue.${issue.code}`, { detail: issue.detail ?? "" })}
                    </span>
                  </li>
                ))}
                {warnings.length > PREVIEW_LIMIT ? (
                  <li className="text-[var(--muted-foreground)]">
                    {t("settings.tagAutocomplete.moreIssues", { count: warnings.length - PREVIEW_LIMIT })}
                  </li>
                ) : null}
              </ul>
            ) : null}

            {parsed.tags.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--border)]">
                {parsed.tags.slice(0, PREVIEW_LIMIT).map((tag, index) => (
                  <div
                    key={`${tag.name}-${index}`}
                    className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="truncate font-medium">{tag.name.replace(/_/g, " ")}</span>
                    {tag.aliases.length > 0 ? (
                      <span className="shrink-0 text-[0.625rem] text-[var(--muted-foreground)]">
                        {t("settings.tagAutocomplete.aliasCount", { count: tag.aliases.length })}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
                      {tag.postCount > 0 ? tag.postCount.toLocaleString() : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <XCircle size="0.75rem" className="text-[var(--destructive)]" />
                {t("settings.tagAutocomplete.importEmpty")}
              </p>
            )}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            onClick={close}
            disabled={importing}
            className="rounded-lg px-4 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {t("capabilities.actions.cancel")}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!canImport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-opacity disabled:opacity-50"
          >
            {importing ? <Loader2 size="0.8125rem" className="animate-spin" /> : null}
            {importing ? t("settings.tagAutocomplete.importing") : t("settings.tagAutocomplete.importConfirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

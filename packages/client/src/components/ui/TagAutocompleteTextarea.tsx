import { useRef } from "react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useTagAutocomplete } from "../../hooks/use-tag-autocomplete";
import { TagAutocompleteOverlay } from "./TagSuggestionPopup";

interface TagAutocompleteTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Opt out per field; the global setting is still required. Defaults to on. */
  enabled?: boolean;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  spellCheck?: boolean;
  maxLength?: number;
  className?: string;
  /** Rendered directly after the textarea, inside the same relative wrapper. */
  footer?: ReactNode;
}

/**
 * A plain tag/prompt textarea with booru tag completion.
 *
 * This is the lightweight counterpart to `MacroTextarea`: it deliberately brings
 * no macro toolbar, preview, or token counter, so it can replace the raw
 * `<textarea>` elements in settings panels and modals without changing their look.
 *
 * Completion is inert until a vocabulary is imported and the feature is enabled,
 * so using this component is safe on any image prompt field.
 */
export function TagAutocompleteTextarea({
  value,
  onChange,
  enabled = true,
  rows = 6,
  placeholder,
  ariaLabel,
  spellCheck = true,
  maxLength,
  className,
  footer,
}: TagAutocompleteTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocomplete = useTagAutocomplete({ value, onChange, enabled, textareaRef });

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        {...autocomplete.textareaProps}
        rows={rows}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={spellCheck}
        maxLength={maxLength}
        className={cn(
          "w-full resize-y rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition placeholder:text-[var(--muted-foreground)] focus:ring-[var(--primary)]/50",
          className,
        )}
      />
      <TagAutocompleteOverlay autocomplete={autocomplete} textareaRef={textareaRef} />
      {footer}
    </div>
  );
}

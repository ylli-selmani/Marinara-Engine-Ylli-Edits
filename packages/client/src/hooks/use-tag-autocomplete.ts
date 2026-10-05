import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";

import { applyTagCompletion, getTagFragmentAtCaret, matchTags, type TagMatch } from "../lib/tag-autocomplete";
import { useTagAutocompleteStore } from "../stores/tag-autocomplete.store";

/**
 * Props to spread onto any `<textarea>` that should offer tag completion.
 *
 * The hook is deliberately renderer-agnostic: it never renders the popup itself,
 * so a caller keeps full control of its own markup. Spread these onto the
 * element and render `<TagSuggestionPopup>` with the returned matches.
 */
export interface TagAutocompleteTextareaProps {
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

interface UseTagAutocompleteOptions {
  /** Current field value. Read at event time so callers stay in control of state. */
  value: string;
  onChange: (value: string) => void;
  /** Per-field opt-in. Independent of the global setting. */
  enabled?: boolean;
  /** Ref to the textarea the popup should anchor to. */
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Existing keydown handler to preserve, e.g. MacroTextarea's Tab handling. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** Existing change handler to preserve. */
  onChangeEvent?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

export interface UseTagAutocompleteResult {
  /** Suggestions to render; already empty when the popup should stay closed. */
  matches: TagMatch[];
  activeIndex: number;
  /** Caret offset to anchor the popup to, or null when closed. */
  anchor: number | null;
  /**
   * Normalized fragment currently being completed.
   *
   * Exposed so the popup can tell which suggestion is the text already written,
   * and confirm it is real vocabulary rather than just the top-ranked guess.
   */
  query: string;
  /** True when suggestions are currently available. */
  isOpen: boolean;
  handleSelect: (match: TagMatch) => void;
  setActiveIndex: (index: number) => void;
  /** Closes the list until the next edit, for outside presses and Escape. */
  dismiss: () => void;
  /** Spread onto the textarea to wire completion without replacing existing handlers. */
  textareaProps: TagAutocompleteTextareaProps;
}

/**
 * Drives tag completion for one textarea.
 *
 * Suggestions are recomputed from the fragment before the caret. Matching runs
 * against an in-memory vocabulary; the prefix index inside `matchTags` keeps a
 * 125k-tag import under a millisecond per keystroke.
 *
 * Everything is inert unless a CSV has been imported, the global setting is on,
 * and the caller opts this field in — so the hook is safe to call unconditionally.
 */
export function useTagAutocomplete({
  value,
  onChange,
  enabled = true,
  textareaRef,
  onKeyDown,
  onChangeEvent,
}: UseTagAutocompleteOptions): UseTagAutocompleteResult {
  const tags = useTagAutocompleteStore((state) => state.tags);
  const storeEnabled = useTagAutocompleteStore((state) => state.enabled);
  const appendComma = useTagAutocompleteStore((state) => state.appendComma);
  const enabledCategories = useTagAutocompleteStore((state) => state.enabledCategories);

  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Read the live value from the element rather than a captured prop, so the
  // fragment is never computed against a stale render.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Kept in a ref so keydown handlers read the active range without re-binding.
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  /**
   * The vocabulary restricted to the enabled categories.
   *
   * Filtering here rather than per match keeps one stable array identity, so the
   * index cache is built once for the current selection instead of per keystroke.
   */
  const visibleTags = useMemo(() => {
    if (enabledCategories.length === 0) return tags;
    const allowed = new Set(enabledCategories);
    // Most exports are dominated by artist and character tags, so this can remove
    // three quarters of the vocabulary before any matching happens.
    if (tags.every((tag) => allowed.has(tag.category))) return tags;
    return tags.filter((tag) => allowed.has(tag.category));
  }, [tags, enabledCategories]);

  const active = enabled && storeEnabled && visibleTags.length > 0;

  /** Resolves the textarea from a possibly-callback ref. */
  const getTextarea = useCallback(
    () => (textareaRef && typeof textareaRef === "object" ? textareaRef.current : null),
    [textareaRef],
  );

  const matches = useMemo(() => {
    if (!active || !query) return [];
    return matchTags(visibleTags, query);
  }, [active, query, visibleTags]);

  const close = useCallback(() => {
    setQuery("");
    setAnchor(null);
    rangeRef.current = null;
  }, []);

  // After an explicit dismissal, stay closed until the user actually edits the
  // text again. Without this, the selectionchange listener immediately reopens
  // the list the user just clicked away from.
  const suppressedRef = useRef(false);

  const dismiss = useCallback(() => {
    suppressedRef.current = true;
    close();
  }, [close]);

  const refresh = useCallback(() => {
    const textarea = getTextarea();
    if (!active || !textarea) {
      close();
      return;
    }

    const fragment = getTagFragmentAtCaret(textarea.value, textarea.selectionStart);
    if (!fragment) {
      close();
      return;
    }

    if (suppressedRef.current) return;

    rangeRef.current = { start: fragment.start, end: fragment.end };
    setQuery(fragment.query);
    setAnchor(fragment.end);
    setActiveIndex(0);
  }, [active, close, getTextarea]);

  const handleSelect = useCallback(
    (match: TagMatch) => {
      const textarea = getTextarea();
      if (!textarea) return;

      // Recompute the range from the live selection rather than trusting the one
      // captured at refresh time. A mouse click, Ctrl+A, Home/End, or a selection
      // change produces no onChange and no popup-open keydown, so the cached range
      // can be stale; applying it would overwrite text the user did not target.
      const live = getTagFragmentAtCaret(textarea.value, textarea.selectionStart);
      const range = live ?? rangeRef.current;
      if (!range) return;

      const result = applyTagCompletion(textarea.value, range, match.tag.name, { appendComma });
      onChange(result.value);

      // Restore the caret after React commits the new value.
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(result.caret, result.caret);
      });

      close();
    },
    [appendComma, close, getTextarea, onChange],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (matches.length > 0) {
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % matches.length);
            return;
          case "ArrowUp":
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
            return;
          case "Enter":
          case "Tab": {
            const match = matches[activeIndex];
            if (match) {
              event.preventDefault();
              handleSelect(match);
              return;
            }
            break;
          }
          case "Escape":
            event.preventDefault();
            dismiss();
            return;
          default:
            // Let the keystroke land, then re-evaluate from the new caret.
            requestAnimationFrame(refresh);
        }
      }

      // Completion only consumes keys while its popup is open; everything else
      // falls through to the caller's own handler.
      onKeyDown?.(event);
    },
    [activeIndex, dismiss, handleSelect, matches, onKeyDown, refresh],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      // The textarea is controlled by the caller's `value` prop, so the edit has to
      // be published or the parent re-renders the old value and the keystroke is
      // silently discarded. Callers that pass `onChangeEvent` (MacroTextarea) run
      // their own formatting and publish the result themselves, so only the plain
      // case publishes here.
      if (!onChangeEvent) onChange(event.target.value);
      onChangeEvent?.(event);
      // An edit is an explicit intent to see suggestions again.
      suppressedRef.current = false;
      // The DOM value is already updated here, so the fragment can be read now.
      requestAnimationFrame(refresh);
    },
    [onChange, onChangeEvent, refresh],
  );

  // Close when the field loses the vocabulary or the feature is turned off.
  useEffect(() => {
    if (!active) close();
  }, [active, close]);

  // Re-evaluate on caret moves that produce neither a change nor a keydown, such
  // as a mouse click or Ctrl+A. Without this the popup would keep showing the
  // previous fragment's suggestions.
  useEffect(() => {
    const textarea = getTextarea();
    if (!active || !textarea) return;

    const onSelectionChange = () => {
      if (document.activeElement !== textarea) return;
      refresh();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [active, getTextarea, refresh]);

  const isOpen = active && anchor !== null && matches.length > 0;

  return {
    matches: anchor === null ? [] : matches,
    activeIndex,
    anchor,
    query,
    isOpen,
    handleSelect,
    setActiveIndex,
    dismiss,
    textareaProps: { onKeyDown: handleKeyDown, onChange: handleChange },
  };
}

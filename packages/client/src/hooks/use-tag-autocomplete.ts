import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";

import { applyTagCompletion, getTagFragmentAtCaret, matchTags, type TagMatch } from "../lib/tag-autocomplete";
import { useTagAutocompleteStore } from "../stores/tag-autocomplete.store";

interface UseTagAutocompleteOptions {
  onChange: (value: string) => void;
  enabled: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

interface UseTagAutocompleteResult {
  matches: TagMatch[];
  activeIndex: number;
  /** Caret offset the popup anchors to; null when the popup is closed. */
  anchor: number | null;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  handleSelect: (match: TagMatch) => void;
  setActiveIndex: (index: number) => void;
  /** Recompute suggestions after a change, from the live caret position. */
  refresh: () => void;
}

/**
 * Drives tag completion for one textarea.
 *
 * Suggestions are recomputed on every keystroke from the fragment before the
 * caret. Matching runs against the in-memory vocabulary, which is small enough
 * (tens of thousands of tags) that a linear scan stays well under a frame.
 */
export function useTagAutocomplete({
  onChange,
  enabled,
  textareaRef,
}: UseTagAutocompleteOptions): UseTagAutocompleteResult {
  const tags = useTagAutocompleteStore((state) => state.tags);
  const storeEnabled = useTagAutocompleteStore((state) => state.enabled);
  const appendComma = useTagAutocompleteStore((state) => state.appendComma);
  const maxResults = useTagAutocompleteStore((state) => state.maxResults);

  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Kept in a ref so keydown handlers read the current range without re-binding.
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  const active = enabled && storeEnabled && tags.length > 0;

  /** Resolves the textarea from a possibly-callback ref. */
  const getTextarea = useCallback(
    () => (textareaRef && typeof textareaRef === "object" ? textareaRef.current : null),
    [textareaRef],
  );

  const matches = useMemo(() => {
    if (!active || !query) return [];
    return matchTags(tags, query, maxResults);
  }, [active, query, tags, maxResults]);

  const close = useCallback(() => {
    setQuery("");
    setAnchor(null);
    rangeRef.current = null;
  }, []);

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

    rangeRef.current = { start: fragment.start, end: fragment.end };
    setQuery(fragment.query);
    setAnchor(fragment.end);
    setActiveIndex(0);
  }, [active, close, getTextarea]);

  const handleSelect = useCallback(
    (match: TagMatch) => {
      const textarea = getTextarea();
      const range = rangeRef.current;
      if (!textarea || !range) return;

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

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (matches.length === 0) return;

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
          if (!match) return;
          event.preventDefault();
          handleSelect(match);
          return;
        }
        case "Escape":
          event.preventDefault();
          close();
          return;
        default:
          // Let the keystroke land, then re-evaluate from the new caret.
          requestAnimationFrame(refresh);
      }
    },
    [activeIndex, close, handleSelect, matches, refresh],
  );

  // Close when the field loses the vocabulary or the feature is turned off.
  useEffect(() => {
    if (!active) close();
  }, [active, close]);

  return {
    matches: anchor === null ? [] : matches,
    activeIndex,
    anchor,
    onKeyDown,
    handleSelect,
    setActiveIndex,
    refresh,
  };
}

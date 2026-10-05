import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TagMatch } from "../../lib/tag-autocomplete";
import { displayTagName, normalizeTagKey } from "../../lib/tag-autocomplete";
import type { UseTagAutocompleteResult } from "../../hooks/use-tag-autocomplete";
import { cn } from "../../lib/utils";

/**
 * Chip styling per booru tag category, keyed by the CSV `type` column.
 *
 * A colored name alone left the meaning unguessable, so each row carries a labeled
 * pill instead. The colors stay literal palette values rather than theme tokens:
 * they encode the booru category, and users coming from a1111 tagcomplete read
 * these hues as meaning (artist = rose, copyright = amber, and so on). Theming
 * them would break that recognition.
 *
 * The pills reuse `.mari-editor-chip`, the same class the lorebook, preset, and
 * character tag chips use, so they match the rest of the app. General and unknown
 * categories take the accent variant, which resolves through
 * `--marinara-editor-accent` to `--marinara-chat-chrome-accent`.
 */
const CATEGORY_CHIP_CLASS: Record<number, string> = {
  1: "border-rose-400/40 bg-rose-400/15 text-rose-300",
  3: "border-amber-400/40 bg-amber-400/15 text-amber-300",
  4: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
  5: "border-sky-400/40 bg-sky-400/15 text-sky-300",
};

/**
 * Human-readable category names, mirroring the booru numbering.
 *
 * Deliberately not localized for the well-known four: these are the Danbooru
 * category names users already know, and the settings toggles carry the
 * translated long forms.
 */
const CATEGORY_LABELS: Record<number, string> = {
  0: "general",
  1: "artist",
  3: "copyright",
  4: "character",
  5: "meta",
  7: "meta",
  8: "meta",
};

/** Resolves a category to its pill label, falling back to the generic custom-tag copy. */
function categoryLabel(category: number, t: (key: string) => string): string {
  return CATEGORY_LABELS[category] ?? t("ui.ui.tagsuggestionpopup.customTag");
}

/**
 * Normalizes a tag name for the "you already wrote this" comparison.
 *
 * Punctuation and spacing are dropped on both sides so `watercolor pencil medium`
 * matches the stored `watercolor_(medium)` form. A tag's identity is its words —
 * someone typing by hand reasonably drops the parenthesized qualifier, and they
 * should still be told the tag exists.
 */
function comparableTagName(name: string): string {
  return normalizeTagKey(name)
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

interface TagSuggestionPopupProps {
  matches: TagMatch[];
  activeIndex: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Caret offset the popup should anchor to. */
  caret: number;
  /** The tag text currently written in the field, normalized. */
  query: string;
  onSelect: (match: TagMatch) => void;
  onHover: (index: number) => void;
  /** Called when the user presses outside the list and the field. */
  onDismiss: () => void;
}

/** Popup width in px. Kept in sync with the class below so clamping can use it. */
const POPUP_WIDTH = 320;
/** Vertical space assumed before the popup has been measured. */
const POPUP_FALLBACK_HEIGHT = 240;

/** Smallest popup height worth showing; below this the list is unusable. */
const POPUP_MIN_HEIGHT = 96;
/** Tallest the popup grows; beyond this the list scrolls. */
const POPUP_MAX_HEIGHT = 240;

export function TagSuggestionPopup({
  matches,
  activeIndex,
  textareaRef,
  caret,
  query,
  onSelect,
  onHover,
  onDismiss,
}: TagSuggestionPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  // The `*` marker is part of the query but not of any tag name, so it is stripped
  // before comparing a suggestion against what the field contains. Whitespace is
  // trimmed too: `normalizeTagQuery` collapses underscores to spaces, so the spaced
  // form `* hair` arrives as `* hair` and a bare strip would leave a leading space
  // that no tag name can equal.
  const writtenTag = query.replace(/^\*\s*/, "").trim();

  useLayoutEffect(() => {
    const textarea = textareaRef && typeof textareaRef === "object" ? textareaRef.current : null;
    if (!textarea || matches.length === 0) {
      setPosition(null);
      return;
    }

    /**
     * The popup is `position: fixed`, so its coordinates are viewport-relative —
     * window scroll must NOT be added. It still has to respect the nearest
     * clipping ancestor, because a `fixed` element is contained (and clipped) by
     * any ancestor that establishes a containing block. Prompt fields inside a
     * modal body or a settings drawer sit in an `overflow-y-auto` container, so
     * clamping to the viewport alone lets the list be cut off or hidden.
     */
    const clippingRectOf = (element: HTMLElement): DOMRect => {
      let node = element.parentElement;
      let bounds = new DOMRect(0, 0, window.innerWidth, window.innerHeight);

      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const clips =
          /(auto|scroll|hidden|clip)/.test(style.overflowY) || /(auto|scroll|hidden|clip)/.test(style.overflowX);

        if (clips) {
          const rect = node.getBoundingClientRect();
          bounds = new DOMRect(
            Math.max(bounds.left, rect.left),
            Math.max(bounds.top, rect.top),
            Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left),
            Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top),
          );
        }

        node = node.parentElement;
      }

      return bounds;
    };

    const update = () => {
      const rect = textarea.getBoundingClientRect();
      // The popup is measured once it exists. `offsetWidth`/`offsetHeight` reflect
      // border-box, so the clamp uses the same geometry the browser lays out.
      const popupHeight = popupRef.current?.offsetHeight || POPUP_FALLBACK_HEIGHT;
      const popupWidth = popupRef.current?.offsetWidth || POPUP_WIDTH;
      const bounds = clippingRectOf(textarea);

      // Anchor below the whole field rather than below the caret's line. Caret
      // anchoring covers the text being edited whenever the field is more than a
      // line or two tall, because the popup starts on the caret's row and grows
      // down over the rest of the text.
      const gap = 4;
      const anchorTop = rect.bottom;
      const spaceBelow = bounds.bottom - anchorTop;
      const spaceAbove = rect.top - bounds.top;

      // Flipping above is only safe when the popup genuinely fits there. Testing
      // `spaceAbove > spaceBelow` alone is not enough: a tall field (MacroTextarea's
      // expanded editor is ~780px) leaves almost no room above it, so the flip fired
      // and was then clamped straight back down over the field — reintroducing the
      // overlap this anchoring exists to prevent.
      const openUpward = spaceBelow < popupHeight && spaceAbove >= popupHeight + gap;

      // Whatever room the chosen side actually has. The popup is capped to it rather
      // than clamped, so a short container scrolls the list instead of pushing it
      // back across the field.
      const room = Math.max((openUpward ? spaceAbove : spaceBelow) - gap, POPUP_MIN_HEIGHT);
      const availableHeight = Math.min(popupHeight, room);

      const rawTop = openUpward ? rect.top - availableHeight - gap : anchorTop + gap;
      // Clamp into the visible band so a short container still shows the list.
      const maxTop = Math.max(bounds.top + gap, bounds.bottom - availableHeight - gap);
      const top = Math.min(Math.max(rawTop, bounds.top + gap), maxTop);

      // Align to the field's own left edge so the list reads as belonging to it.
      // The caret's horizontal position is deliberately not used: the popup hangs
      // under the whole field now, so following the caret would make it drift as
      // the user types without adding any information.
      const rawLeft = rect.left;
      // A narrow container (a settings card can be ~280px) cannot fit the popup at
      // its natural width, so clamp against the space actually available instead of
      // letting the list run past the edge.
      const available = bounds.right - bounds.left - 8;
      const effectiveWidth = Math.min(popupWidth, Math.max(available, 0));
      const maxLeft = Math.max(bounds.left + 4, bounds.right - effectiveWidth - 4);
      const left = Math.min(Math.max(rawLeft, bounds.left + 4), maxLeft);

      setPosition({ top, left, maxWidth: effectiveWidth, maxHeight: availableHeight });
    };

    update();

    // The first pass measures a popup that may not be laid out yet, so it falls
    // back to the constant width. Re-running after paint clamps against the real
    // box, which is what keeps the list from running past the right edge.
    const remeasure = requestAnimationFrame(update);

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(remeasure);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [caret, matches, textareaRef]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const active = popupRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Dismiss on an outside press, matching ContextMenu's behaviour. Without this
  // the list lingered after the user moved on. The textarea itself is excluded
  // so clicking to reposition the caret refines the suggestions instead of
  // closing them, and the frame delay keeps the opening keystroke from
  // immediately dismissing the list.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popupRef.current?.contains(target)) return;

      const textarea = textareaRef && typeof textareaRef === "object" ? textareaRef.current : null;
      if (textarea?.contains(target)) return;

      onDismiss();
    };

    const frame = requestAnimationFrame(() => {
      document.addEventListener("mousedown", onPointerDown);
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onDismiss, textareaRef]);

  if (matches.length === 0 || !position) return null;

  return createPortal(
    <div
      ref={popupRef}
      role="listbox"
      aria-label={t("ui.ui.tagsuggestionpopup.tagSuggestions")}
      className="glass-strong fixed z-[9999] max-h-60 w-80 overflow-y-auto rounded-xl py-1 text-xs text-[var(--popover-foreground)]"
      style={{
        top: position.top,
        left: position.left,
        maxWidth: position.maxWidth,
        // Capped to the room on the chosen side, so a short container scrolls the
        // list rather than clamping it back across the field it is anchored to.
        maxHeight: Math.min(position.maxHeight, POPUP_MAX_HEIGHT),
      }}
    >
      {matches.map((match, index) => {
        // The row that is exactly what the field already contains. Ranking put it
        // first by luck; this marks it as *known vocabulary*, so the user can see
        // the tag they wrote is real instead of merely being guessed at.
        //
        // Punctuation is ignored because it is often dropped when typing by hand:
        // someone typing `watercolor pencil medium` means `watercolor pencil
        // (medium)`, and that is the tag they should be told exists.
        const isWritten = Boolean(writtenTag) && comparableTagName(match.tag.name) === comparableTagName(writtenTag);

        return (
          <button
            key={match.tag.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            data-index={index}
            // mousedown fires before the textarea's blur, so selection is not lost.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(match);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-1.5 text-left text-xs transition-colors",
              index === activeIndex ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]/60",
              // The tag already written in the field is marked with an accent edge
              // rather than a second pill, so the category pill below is always the
              // only pill on the row and stays unambiguous.
              isWritten && "border-l-[var(--marinara-chat-chrome-accent)]",
            )}
            title={isWritten ? t("ui.ui.tagsuggestionpopup.alreadyWritten") : undefined}
          >
            <span className="truncate font-medium text-[var(--foreground)]">{displayTagName(match.tag.name)}</span>
            <span
              className={cn(
                "mari-editor-chip shrink-0 px-1.5 py-px text-[0.5625rem] uppercase tracking-wide",
                CATEGORY_CHIP_CLASS[match.tag.category] ?? "mari-editor-chip--accent",
              )}
            >
              {categoryLabel(match.tag.category, t)}
            </span>
            {match.matchedAlias ? (
              <span className="shrink-0 truncate text-[0.625rem] text-[var(--muted-foreground)]">
                {displayTagName(match.matchedAlias)} →
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
              {match.tag.postCount > 0 ? match.tag.postCount.toLocaleString() : t("ui.ui.tagsuggestionpopup.customTag")}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Renders nothing unless the given completion state has something to show.
 *
 * Convenience wrapper for callers that already hold a `useTagAutocomplete`
 * result, so a tag field only needs to spread `textareaProps` and drop this
 * component next to its textarea.
 */
export function TagAutocompleteOverlay({
  autocomplete,
  textareaRef,
}: {
  autocomplete: UseTagAutocompleteResult;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  if (!autocomplete.isOpen || autocomplete.anchor === null) return null;

  return (
    <TagSuggestionPopup
      matches={autocomplete.matches}
      activeIndex={autocomplete.activeIndex}
      textareaRef={textareaRef}
      caret={autocomplete.anchor}
      query={autocomplete.query}
      onSelect={autocomplete.handleSelect}
      onHover={autocomplete.setActiveIndex}
      onDismiss={autocomplete.dismiss}
    />
  );
}

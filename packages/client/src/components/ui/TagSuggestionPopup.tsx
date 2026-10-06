import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Palette, Tag, User, Wrench } from "lucide-react";

import type { TagMatch } from "../../lib/tag-autocomplete";
import { displayTagName, normalizeTagKey } from "../../lib/tag-autocomplete";
import { caretLineTopOf, placePopup } from "../../lib/tag-popup-placement";
import type { UseTagAutocompleteResult } from "../../hooks/use-tag-autocomplete";
import { cn } from "../../lib/utils";

/**
 * Category icons, keyed by the CSV `type` column (Danbooru numbering).
 *
 * Distinguished by icon rather than hue, following the engine's own conventions:
 * `AgentsPanel` separates its categories with a distinct icon per section and has
 * no color field at all, `LorebooksPanel`'s `CATEGORY_COLORS` maps six categories
 * to one identical value, and `globals.css` reserves the named palettes for data
 * visualization rather than component chrome. An icon also survives a theme change
 * and reads on touch, where the hover that would explain a color does not exist
 * (DESIGN.md, "The No Tiny Mystery Rule").
 *
 * Sizes match `AgentsPanel`'s section icons, which are the closest precedent.
 */
const CATEGORY_ICONS: Record<number, typeof User> = {
  0: Tag, // general
  1: Palette, // artist
  3: BookOpen, // copyright / series
  4: User, // character
  5: Wrench, // meta
  7: Wrench,
  8: Wrench,
};

/**
 * Localization key naming a category, used as the icon's accessible label.
 *
 * These are the short forms for a list row; the settings toggles carry the longer
 * translated wording.
 */
const CATEGORY_LABEL_KEYS: Record<number, string> = {
  0: "ui.ui.tagsuggestionpopup.categoryGeneral",
  1: "ui.ui.tagsuggestionpopup.categoryArtist",
  3: "ui.ui.tagsuggestionpopup.categoryCopyright",
  4: "ui.ui.tagsuggestionpopup.categoryCharacter",
  5: "ui.ui.tagsuggestionpopup.categoryMeta",
};

/** Resolves a category's icon, or null for the general/unknown categories. */
function categoryIcon(category: number) {
  return CATEGORY_ICONS[category] ?? null;
}

/** Resolves a category's accessible label, falling back to the generic copy. */
function categoryLabelKey(category: number): string {
  return CATEGORY_LABEL_KEYS[category] ?? "ui.ui.tagsuggestionpopup.customTag";
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

      // The placement is pure arithmetic over rectangles, so it lives in the lib
      // where the regression suite can exercise it without a DOM.
      const caretLineTop = caretLineTopOf({
        caret,
        value: textarea.value,
        scrollTop: textarea.scrollTop,
        rect,
        bounds,
        style: window.getComputedStyle(textarea),
      });

      const { top, availableHeight } = placePopup({
        bounds,
        rect,
        caretLineTop,
        popupHeight,
      });

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
      // `p-1` keeps the rows off the container's rounded edge, so a row's rounded
      // outline is not clipped by the container's own corner curves.
      className="glass-strong fixed z-[9999] max-h-60 w-80 overflow-y-auto rounded-xl p-1 text-xs text-[var(--popover-foreground)]"
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

        const CategoryIcon = categoryIcon(match.tag.category);

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
              // The accent carries every piece of interaction chrome on a row: the
              // keyboard/hover pointer, the written marker, and the focus edge.
              "flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs transition-colors",
              index === activeIndex
                ? "border-l-[var(--marinara-chat-chrome-accent)] bg-[var(--marinara-chat-chrome-accent)]/15"
                : "border-l-transparent hover:bg-[var(--muted)]/50",
              // The tag already written in the field is marked the way the engine marks
              // a focused field: a border in the accent rather than the resting
              // `--border` tint. See `CharacterEditor`'s textareas, which go from
              // `border-[var(--border)]` to `focus:border-[var(--primary)]`.
              //
              // Drawn as an outline rather than a `border`, because a border sits on
              // the row's edge where the container's rounded corners and
              // `overflow-hidden` clip it — which ate the curve on the first and last
              // rows and every curve on a single-row list. An outline is not part of
              // the row's border box, so it renders whole.
              //
              // The short inset glow is what makes the row read as marked rather than
              // merely outlined; on its own it is too vague to define a shape.
              isWritten &&
                "rounded-lg outline outline-1 -outline-offset-2 outline-[var(--marinara-chat-chrome-accent)] shadow-[inset_0_0_10px_-2px_var(--marinara-chat-chrome-accent)]",
              isWritten && index === activeIndex && "border-l-[var(--marinara-chat-chrome-accent)]",
            )}
            // The row itself carries no title: the icon already names the category and
            // the visible text is the tag. Each truncating span below titles itself,
            // so a hover reveals exactly the text that was cut off rather than a
            // restatement of the row.
          >
            {CategoryIcon ? (
              <CategoryIcon
                // Slightly above the label size. At 0.75rem the more detailed
                // glyphs lost their shape and read as a blob, which is why the
                // general category uses the simple tag outline.
                size="0.875rem"
                aria-label={t(categoryLabelKey(match.tag.category))}
                className="shrink-0 text-[var(--muted-foreground)]"
              />
            ) : null}
            <span
              // A long tag name is the common case in a 320px popup, and the list is
              // too dense for a marquee. Hovering reveals the full name, which is
              // enough to confirm before inserting it.
              title={displayTagName(match.tag.name)}
              className={cn(
                "truncate font-medium",
                isWritten ? "text-[var(--marinara-chat-chrome-accent)]" : "text-[var(--foreground)]",
              )}
            >
              {displayTagName(match.tag.name)}
            </span>
            {match.matchedAlias ? (
              <span
                title={displayTagName(match.matchedAlias)}
                className="shrink-0 truncate text-[0.625rem] text-[var(--muted-foreground)]"
              >
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

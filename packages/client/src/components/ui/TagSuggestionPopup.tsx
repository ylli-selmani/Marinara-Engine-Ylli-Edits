import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Brush, Tag, Users, Wrench, type LucideIcon } from "lucide-react";

import type { TagMatch } from "../../lib/tag-autocomplete";
import { displayTagName, sameTagName } from "../../lib/tag-autocomplete";
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
const CATEGORY_ICONS: Record<number, LucideIcon> = {
  0: Tag, // general
  // A brush, not a palette and not a person. A palette reads as "art style / aesthetic"
  // rather than "artist"; a person-with-pen read as "artist" correctly but was nearly the
  // same silhouette as the character glyph, which is the one thing these have to avoid.
  // A brush is unmistakable at 0.875rem and shares no shape with the other categories.
  1: Brush, // artist
  3: BookOpen, // copyright / series
  // The same `Users` glyph the top bar uses for the Characters panel, so a character tag
  // points at the concept the rest of the app already uses for characters. Explicitly NOT
  // the venetian mask: that is the personas symbol throughout the app (TopBar,
  // PersonasPanel, RightPanel, ChatSettingsDrawer), and a persona is not a danbooru
  // character — reusing it would teach the wrong association.
  4: Users, // character
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
 * A tag name that slides itself into view when the row is hovered and the name is cut off.
 *
 * The list is only 320px wide and real tag names overflow it often. A `title` tooltip is the
 * usual answer, but here it covers the row the user is trying to read and the list is dense
 * enough that it flickers as the pointer moves. Instead the text translates left by exactly
 * its own overflow and back when the pointer leaves.
 *
 * The distance is measured rather than guessed because it depends on the rendered width of
 * the name, which varies with the font and the space the alias and count leave behind. A
 * name that fits measures zero, gets no custom property, and never moves.
 *
 * The clipped edge gets a fade rather than an ellipsis. That is a presentation choice, NOT a
 * measurement constraint — an earlier version of this comment claimed `text-overflow:
 * ellipsis` zeroes `scrollWidth` and so cannot coexist with the slide. That is false, and it
 * was measured: `overflow: hidden` with an ellipsis reports `scrollWidth` 294 against
 * `clientWidth` 116 on a 116px box, so the difference is perfectly usable. `scrollWidth`
 * always reports full content width; only `clientWidth` clamps. The ellipsis was dropped
 * because a fade reads better against the row's fade-out than a glyph does, and because
 * ellipsis plus a sliding element is visually noisy.
 *
 * KNOWN CEILING: the shift is the full overflow, so the tail lands flush with the right edge
 * and the HEAD slides out of the left clip. A long name therefore never shows all at once —
 * the user trades a cut tail for a cut head. Showing both would need a shorter travel plus a
 * wider field, or an actual marquee loop, which was rejected as too busy for a dense list.
 *
 * Only the name uses this. The alias beside it truncates in place, because two spans
 * travelling different distances at once read as shaken rather than as revealing anything.
 *
 * ponytail: touch has no hover, so the reveal is unreachable on a phone. The CSS has a
 * `.mari-tag-scroll-text--press` rule for a long-press reveal but nothing applies it; wiring
 * it needs a pointer-event handler on the row. Not done because the popup is keyboard- and
 * pointer-driven today and no touch path exists to hang it on.
 */
function ScrollingTagName({
  text,
  className,
  wrapperClassName,
  slide = true,
}: {
  text: string;
  className: string;
  /** Extra flex classes for the clipping wrapper, which is the flex item. */
  wrapperClassName?: string;
  /**
   * Whether this text reveals itself on hover. False for the alias, which truncates where it
   * sits: two spans travelling different distances at once read as shaken rather than as
   * revealing anything.
   */
  slide?: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const node = textRef.current;
    if (!wrap || !node) {
      return;
    }

    const measure = () => {
      // scrollWidth is the text's full width even while it is clipped, so the difference
      // from the wrapper is exactly how far it has to travel. (An earlier comment here
      // claimed a clamped child zeroes this — it does not; `scrollWidth` always reports
      // full content width and only `clientWidth` clamps. The span is left unclamped
      // because it reads more simply, not because the measurement requires it.)
      //
      // Travelling the exact overflow leaves the tail flush against the clip edge, still
      // under the fade mask, so a fully scrolled name ended up slightly blurred — the
      // reveal worked but the destination was not clean. The overshoot clears the fade.
      // It is capped because a name clipped by only a pixel or two would otherwise jump a
      // visible 8px, and it stays well under the 1.5rem mask so the tail never leaves the
      // wrapper.
      const overflow = node.scrollWidth - wrap.clientWidth;
      if (overflow <= 0) {
        setShift(0);
        return;
      }
      setShift(overflow + Math.min(8, Math.max(2, overflow * 0.1)));
    };

    measure();

    // The popup is rem-based and re-measured on zoom and on window resize, so a width
    // captured once goes stale. Observing the wrapper catches both without a resize listener.
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={wrapRef}
      className={cn("mari-tag-scroll-wrap", slide && "mari-tag-scroll-wrap--slide", wrapperClassName)}
      // Drives the clipped-edge fade. It has to come from the measurement rather than a CSS
      // rule, because CSS cannot see whether the text actually overflows.
      data-clipped={shift > 0 ? "true" : undefined}
      // A tooltip for the clipped case only. The slide is the primary way to read a long tag,
      // but it needs hover and it is disabled under `prefers-reduced-motion`, and touch has
      // neither — so this is what remains reachable there. Only set when actually clipped, so
      // a tag that already fits does not grow a redundant tooltip.
      title={shift > 0 ? text : undefined}
    >
      <span
        ref={textRef}
        className={cn("mari-tag-scroll-text", className)}
        style={slide && shift > 0 ? ({ "--mari-tag-scroll-shift": `-${shift}px` } as CSSProperties) : undefined}
      >
        {text}
      </span>
    </span>
  );
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
  // Drives remeasurement when the list grows or shrinks, which changes the popup's
  // natural height even though the row markup is otherwise identical.
  const matchCount = matches.length;
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
      const node = popupRef.current;
      // The popup's own laid-out height must never be the input to its own cap, or
      // it can never grow: a one-row popup measures ~40px, caps itself at 40px, and
      // stays scrollable no matter how many matches arrive. `offsetHeight` reports
      // the *constrained* box, so it is only a valid measurement when nothing has
      // constrained it yet. `scrollHeight` is the natural content height and is
      // what the fit should be computed against.
      const naturalHeight = node
        ? Math.max(node.scrollHeight, Math.min(node.offsetHeight || 0, POPUP_MAX_HEIGHT))
        : POPUP_FALLBACK_HEIGHT;
      const popupHeight = Math.min(naturalHeight || POPUP_FALLBACK_HEIGHT, POPUP_MAX_HEIGHT);
      const popupWidth = node?.offsetWidth || POPUP_WIDTH;
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

    // Two passes, because the row list changes height after React commits it. The
    // first pass runs against the rows currently in the DOM; the frame callback then
    // measures the popup with the *new* rows so the granted height matches what will
    // actually be drawn. Without the second pass the popup kept the previous list's
    // height and simply scrolled.
    const remeasure = requestAnimationFrame(update);

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(remeasure);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
    // `matches.length` is a dependency on purpose: regenerating an equal-length list
    // does not change the popup's box, but growing from one row to twenty does, and
    // the array identity alone does not tell us which happened.
  }, [caret, matches, matchCount, textareaRef]);

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
      // No padding: rows bleed to the container edge so a row's highlight and its
      // accent spine fill the popup instead of floating inside it. The container
      // supplies the outer curve, and the first and last rows round their own outward
      // corners to match it (see the row classes below).
      //
      // Only vertical scrolling is allowed. Rows fill the width and every text span
      // truncates, so a horizontal scrollbar would have nothing to reveal — it showed
      // up as a dead bar along the bottom in one report. The rows themselves measured
      // as exactly container-width when checked, so this is a guard against a future
      // row that does not truncate, not a fix for a reproduced overflow.
      //
      // The z-index sits above `ExpandedMacroEditor`'s `z-[10050]` because that modal
      // hosts tag fields of its own: at the usual floating-layer value of `z-[9999]`
      // the list rendered *behind* the editor it belongs to. This is the top of the
      // ladder, which is correct for a control that must be visible over any surface
      // containing a tag field.
      className="glass-strong fixed z-[10060] max-h-60 w-80 overflow-x-hidden overflow-y-auto rounded-xl text-xs text-[var(--popover-foreground)]"
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
        // Punctuation is tolerated because it is often dropped when typing by hand:
        // someone typing `watercolor pencil medium` means `watercolor pencil
        // (medium)`, and that is the tag they should be told exists. But this is an
        // identity claim about the user's own text, so it must not be *lossy* the way
        // alias suppression can afford to be — the punctuation-blind helper also
        // collapses genuinely different tags (`bluesky`/`blue_sky`,
        // `blood`/`blood+`), which would badge a tag the user never typed.
        const isWritten = Boolean(writtenTag) && sameTagName(match.tag.name, writtenTag);

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
              //
              // The spine is a left border rather than a separate element so it spans
              // the row's full height, including the padding. It used to look like a
              // stub sitting inside the highlight because the container's padding and
              // the row's own rounded corners cut it short.
              //
              // Padding is 10px, not 12px: the spine already contributes 2px on the
              // left, so matching the two sides visually means the left padding has to
              // be smaller than the right. At 12px the icon sat 14px from the popup
              // edge against the count's 12px, which read as dead space past the
              // rounded corner. Measured: this puts the icon at 12px and the count at
              // 10px, and gives back ~4px of width to every name.
              "flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors",
              // The outer corners follow the container's curve, so a bleeding row does
              // not poke past it. Interior rows stay square so the list reads as one
              // block rather than a stack of pills.
              index === 0 && "rounded-t-[0.75rem]",
              index === matches.length - 1 && "rounded-b-[0.75rem]",
              index === activeIndex
                ? "border-l-[var(--marinara-chat-chrome-accent)] bg-[var(--marinara-chat-chrome-accent)]/15"
                : "border-l-transparent hover:bg-[var(--muted)]/50",
              // The tag already written in the field is marked the way the engine marks
              // a focused field: a border in the accent rather than the resting
              // `--border` tint. See `CharacterEditor`'s textareas, which go from
              // `border-[var(--border)]` to `focus:border-[var(--primary)]`.
              //
              // Drawn as an inset outline rather than a border, because a border sits on
              // the row's edge where the container's rounded corners and scroll clipping
              // eat it — which lost the curve on the first and last rows and every curve
              // on a single-row list. An outline is not part of the border box, so it
              // renders whole.
              //
              // The short inset glow is what makes the row read as marked rather than
              // merely outlined; on its own it is too vague to define a shape.
              isWritten &&
                "outline outline-1 -outline-offset-2 outline-[var(--marinara-chat-chrome-accent)] shadow-[inset_0_0_10px_-2px_var(--marinara-chat-chrome-accent)]",
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
                // Accent-tinted, matching the rest of the row's interactive chrome (the
                // spine, the pointer fill, the written marker) so the icon belongs to the
                // row rather than sitting beside it. The tint is decoration only: the
                // categories are told apart by SHAPE, and each icon keeps its own
                // `aria-label`, so nothing depends on the colour to be understood.
                className="shrink-0 text-[var(--marinara-chat-chrome-accent)]"
              />
            ) : null}
            <ScrollingTagName
              text={displayTagName(match.tag.name)}
              // A percentage of the row's free space, and it must be able to SHRINK: the space
              // left after the icon and count varies with the count's own digits ("83" vs
              // "2,195,202"), so anything with a fixed rem width overflows the 320px popup and
              // pushes the count off the right edge — measured 46px over with
              // `w-[11.5rem]` + `w-[6.5rem]`. The percentage plus `shrink` is what prevents
              // that; measured row overflow is 0 at root sizes 8-32px.
              //
              // The wrapper is also the clipping box, so the sliding text cannot paint over the
              // alias. No `truncate` here: the fade at the clipped edge is the cue instead.
              className={cn(
                "font-medium",
                isWritten ? "text-[var(--marinara-chat-chrome-accent)]" : "text-[var(--foreground)]",
              )}
              wrapperClassName="min-w-0 w-[58%] shrink"
            />
            {match.matchedAlias ? (
              <>
                {/* The arrow is a marker BETWEEN the two names, not part of either, so it sits
                    outside the scrolling wrapper and never moves. Inside, it travelled with the
                    alias text and slid away from the name it points at. The alias column is
                    narrower for it, so the two together still occupy the same 42% share.

                    A left-pointing arrow because the alias column is to the RIGHT of the tag
                    name: it marks the alias the user typed as resolving to the tag beside it.
                    A rightward arrow pointed away from that tag and read as aiming at the count. */}
                <span aria-hidden="true" className="shrink-0 pl-1 text-[0.625rem] text-[var(--muted-foreground)]">
                  ←
                </span>
                <ScrollingTagName
                  // Concatenated rather than a template literal: the localization audit reads a
                  // template in an attribute position as a static UI string and demands a catalog
                  // key for it. The arrow is decoration on a tag name, not copy to translate.
                  text={displayTagName(match.matchedAlias)}
                  className="text-[0.625rem] text-[var(--muted-foreground)]"
                  wrapperClassName="min-w-0 w-[42%] shrink"
                />
              </>
            ) : null}
            <span className="ml-auto shrink-0 pl-2 text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
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

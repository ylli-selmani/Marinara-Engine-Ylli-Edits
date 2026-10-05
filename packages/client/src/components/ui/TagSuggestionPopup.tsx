import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TagMatch } from "../../lib/tag-autocomplete";
import { displayTagName } from "../../lib/tag-autocomplete";
import type { UseTagAutocompleteResult } from "../../hooks/use-tag-autocomplete";
import { cn } from "../../lib/utils";

/**
 * Category colors mirroring the booru tag types, keyed by the CSV `type` column.
 *
 * These are intentionally literal palette values rather than theme tokens: the
 * color encodes the booru category, and users coming from a1111 tagcomplete read
 * these hues as meaning (character = red, copyright = amber, and so on). Theming
 * them would break that recognition. Same precedent as AgentEditor's icon colors.
 */
const CATEGORY_COLORS: Record<number, string> = {
  "-1": "text-[var(--muted-foreground)]",
  0: "text-[var(--foreground)]",
  1: "text-rose-400",
  3: "text-amber-400",
  4: "text-emerald-400",
  5: "text-sky-400",
  7: "text-violet-400",
  8: "text-violet-400",
};

interface TagSuggestionPopupProps {
  matches: TagMatch[];
  activeIndex: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Caret offset the popup should anchor to. */
  caret: number;
  onSelect: (match: TagMatch) => void;
  onHover: (index: number) => void;
  /** Called when the user presses outside the list and the field. */
  onDismiss: () => void;
}

/** Popup width in px. Kept in sync with the class below so clamping can use it. */
const POPUP_WIDTH = 320;
/** Vertical space assumed before the popup has been measured. */
const POPUP_FALLBACK_HEIGHT = 240;

/**
 * Measures the caret's on-screen position inside a textarea.
 *
 * A textarea cannot report caret coordinates directly, so this mirrors the
 * element's computed text styles onto a hidden div, copies the text up to the
 * caret into it, and reads the marker span's offset. This is the standard
 * technique and is accurate as long as the mirrored box matches exactly.
 */
function measureCaretOffset(textarea: HTMLTextAreaElement, caret: number): { top: number; left: number } {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");

  const properties = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontFamily",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "textIndent",
    "whiteSpace",
    "wordSpacing",
    "wordBreak",
  ] as const;

  for (const property of properties) {
    mirror.style[property] = computed[property];
  }

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";

  mirror.textContent = textarea.value.slice(0, caret);

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  // The mirror is border-box sized like the textarea, so subtract its own
  // border to land on the content origin.
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
  const borderTop = parseFloat(computed.borderTopWidth) || 0;

  const left = marker.offsetLeft - textarea.scrollLeft + borderLeft;
  const top = marker.offsetTop - textarea.scrollTop + borderTop;

  document.body.removeChild(mirror);

  return { top, left };
}

export function TagSuggestionPopup({
  matches,
  activeIndex,
  textareaRef,
  caret,
  onSelect,
  onHover,
  onDismiss,
}: TagSuggestionPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number; maxWidth: number } | null>(null);

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
      const offset = measureCaretOffset(textarea, caret);
      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      // The popup is measured once it exists. `offsetWidth`/`offsetHeight` reflect
      // border-box, so the clamp uses the same geometry the browser lays out.
      const popupHeight = popupRef.current?.offsetHeight || POPUP_FALLBACK_HEIGHT;
      const popupWidth = popupRef.current?.offsetWidth || POPUP_WIDTH;
      const bounds = clippingRectOf(textarea);

      const caretTop = rect.top + offset.top;
      const spaceBelow = bounds.bottom - (caretTop + lineHeight);
      const spaceAbove = caretTop - bounds.top;
      const openUpward = spaceBelow < popupHeight && spaceAbove > spaceBelow;

      const rawTop = openUpward ? caretTop - popupHeight - 4 : caretTop + lineHeight + 4;
      // Clamp into the visible band so a short container still shows the list.
      const maxTop = Math.max(bounds.top + 4, bounds.bottom - popupHeight - 4);
      const top = Math.min(Math.max(rawTop, bounds.top + 4), maxTop);

      const rawLeft = rect.left + offset.left;
      // A narrow container (a settings card can be ~280px) cannot fit the popup at
      // its natural width, so clamp against the space actually available instead of
      // letting the list run past the edge. Prefer the caret's line start when the
      // container is wide enough to matter, otherwise pin to its left edge.
      const available = bounds.right - bounds.left - 8;
      const effectiveWidth = Math.min(popupWidth, Math.max(available, 0));
      const maxLeft = Math.max(bounds.left + 4, bounds.right - effectiveWidth - 4);
      const left = Math.min(Math.max(rawLeft, bounds.left + 4), maxLeft);

      setPosition({ top, left, maxWidth: effectiveWidth });
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
      style={{ top: position.top, left: position.left, maxWidth: position.maxWidth }}
    >
      {matches.map((match, index) => (
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
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
            index === activeIndex ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]/60",
          )}
        >
          <span
            className={cn("truncate font-medium", CATEGORY_COLORS[match.tag.category] ?? "text-[var(--foreground)]")}
          >
            {displayTagName(match.tag.name)}
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
      ))}
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
      onSelect={autocomplete.handleSelect}
      onHover={autocomplete.setActiveIndex}
      onDismiss={autocomplete.dismiss}
    />
  );
}

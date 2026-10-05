import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TagMatch } from "../../lib/tag-autocomplete";
import { displayTagName } from "../../lib/tag-autocomplete";
import type { UseTagAutocompleteResult } from "../../hooks/use-tag-autocomplete";
import { cn } from "../../lib/utils";

/**
 * Category colors mirroring the booru tag types, keyed by the CSV `type` column.
 * Values are the dark/light pair used by the a1111 tagcomplete convention.
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
}

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
}: TagSuggestionPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef && typeof textareaRef === "object" ? textareaRef.current : null;
    if (!textarea || matches.length === 0) {
      setPosition(null);
      return;
    }

    const update = () => {
      const rect = textarea.getBoundingClientRect();
      const offset = measureCaretOffset(textarea, caret);
      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;

      // Anchor below the caret line; flip above when there is no room below.
      const spaceBelow = window.innerHeight - (rect.top + offset.top + lineHeight);
      const popupHeight = popupRef.current?.offsetHeight ?? 240;
      const openUpward = spaceBelow < popupHeight && offset.top > popupHeight;

      setPosition({
        top: openUpward
          ? rect.top + offset.top - popupHeight - 4 + window.scrollY
          : rect.top + offset.top + lineHeight + 4 + window.scrollY,
        left: Math.min(rect.left + offset.left + window.scrollX, window.innerWidth - 340),
      });
    };

    update();

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [caret, matches, textareaRef]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const active = popupRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (matches.length === 0 || !position) return null;

  return createPortal(
    <div
      ref={popupRef}
      role="listbox"
      aria-label={t("ui.ui.tagsuggestionpopup.tagSuggestions")}
      className="fixed z-[9999] max-h-60 w-[20rem] overflow-y-auto rounded-lg bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-xl ring-1 ring-[var(--border)]"
      style={{ top: position.top, left: position.left }}
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
            "flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs",
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
    />
  );
}

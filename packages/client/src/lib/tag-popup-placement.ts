/**
 * Placement arithmetic for the tag suggestion popup.
 *
 * Kept out of the component because it is pure geometry over rectangles, which makes
 * it testable without a DOM. The popup is `position: fixed`, so every coordinate here
 * is viewport-relative; `bounds` is the nearest clipping ancestor's visible rect,
 * not the viewport, because a `fixed` element is still clipped by any ancestor that
 * establishes a containing block.
 */

/** Smallest popup height worth showing; below this the list is unusable. */
export const POPUP_MIN_HEIGHT = 96;

/** Gap between the anchor and the popup. */
export const POPUP_GAP = 4;

export interface Rect {
  top: number;
  bottom: number;
  height: number;
}

export interface CaretLineInput {
  /** Caret offset in the field. */
  caret: number;
  /** The field's full value. */
  value: string;
  /** How far the field is scrolled, in px. */
  scrollTop: number;
  /** The field's own viewport rect. */
  rect: Rect;
  /** The clipping ancestor's visible rect. */
  bounds: Rect;
  /** Only the fields read are required, which keeps this testable without a DOM. */
  style: { lineHeight: string; fontSize: string; paddingTop: string };
}

/**
 * The viewport `top` of the line the caret sits on.
 *
 * Only meaningful when the field is taller than its container — that is the case
 * where the field's own box gives no usable anchor. Tag fields are plain wrapped
 * text, so the line index is just the newlines before the caret; a mirror element
 * would cost a layout on every keystroke for no extra accuracy.
 */
export function caretLineTopOf({ caret, value, scrollTop, rect, bounds, style }: CaretLineInput): number {
  if (rect.height <= bounds.height) return rect.top;

  const before = value.slice(0, caret);
  let line = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before.charCodeAt(index) === 10) line += 1;
  }

  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 18;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  // Allow for how far the field has been scrolled, then keep the result inside the
  // field so a caret scrolled out of view still anchors somewhere sensible.
  const raw = rect.top + paddingTop + line * lineHeight - scrollTop;
  return Math.min(Math.max(raw, rect.top), Math.max(rect.bottom - lineHeight, rect.top));
}

export interface PlacePopupInput {
  /** The clipping ancestor's visible rect. */
  bounds: Rect;
  /** The field's own viewport rect. */
  rect: Rect;
  /** Output of `caretLineTopOf`. */
  caretLineTop: number;
  /** The popup's measured height. */
  popupHeight: number;
  /** Gap between anchor and popup. */
  gap?: number;
}

/**
 * Chooses the popup's `top` and granted height.
 *
 * Normally the popup hangs just below the whole field: caret anchoring covers the
 * text being edited whenever the field is more than a line or two tall, because the
 * list starts on the caret's row and grows down over the rest.
 *
 * A field **taller than its clipping container** breaks that anchoring. `bounds` is
 * then the container, the field is flush with its top, so there is no room above to
 * flip into and no room below to fit — and every position inside the container is
 * also inside the field's box. In that case the caret's line becomes the anchor, and
 * the flip is re-decided against it, because the field's top is not a useful
 * reference. This is what keeps the list off the text being typed in a tall inline
 * field scrolled to the top of a settings drawer.
 */
export function placePopup({ bounds, rect, caretLineTop, popupHeight, gap = POPUP_GAP }: PlacePopupInput): {
  top: number;
  availableHeight: number;
} {
  const fieldOverflowsContainer = rect.height > bounds.height;

  // Flipping above is only safe when the popup genuinely fits there. Testing
  // `spaceAbove > spaceBelow` alone is not enough: a tall field leaves almost no room
  // above it, so the flip fired and was then clamped straight back down over the
  // field, reintroducing the overlap this anchoring exists to prevent.
  const spaceBelow = bounds.bottom - rect.bottom;
  const spaceAbove = rect.top - bounds.top;
  const openUpward = spaceBelow < popupHeight && spaceAbove >= popupHeight + gap;

  const anchorTop = fieldOverflowsContainer ? caretLineTop : rect.top;
  const roomAbove = anchorTop - bounds.top;
  const roomBelow = fieldOverflowsContainer ? bounds.bottom - caretLineTop : spaceBelow;
  const upward = fieldOverflowsContainer ? roomBelow < popupHeight && roomAbove >= roomBelow : openUpward;

  // Whatever room the chosen side actually has. The popup is capped to it rather than
  // clamped, so a short container scrolls the list instead of pushing it back across
  // the field.
  const availableHeight = Math.min(popupHeight, Math.max((upward ? roomAbove : roomBelow) - gap, POPUP_MIN_HEIGHT));

  const anchorBottom = fieldOverflowsContainer ? caretLineTop : rect.bottom;
  const rawTop = upward ? anchorTop - availableHeight - gap : anchorBottom + gap;

  // Clamp into the visible band so a short container still shows the list.
  const maxTop = Math.max(bounds.top + gap, bounds.bottom - availableHeight - gap);
  const top = Math.min(Math.max(rawTop, bounds.top + gap), maxTop);

  return { top, availableHeight };
}

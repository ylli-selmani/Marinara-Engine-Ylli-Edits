/**
 * Placement regression for the tag suggestion popup.
 *
 * The bug this pins: a field taller than its clipping container rendered the list
 * entirely inside the field's own box, covering the text being edited and squeezed to
 * the minimum height. It was reported with exact coordinates (a 780px field in a
 * 640px drawer, field y=260..1040, drawer 260..900, popup landing at y=800..896) and
 * is reproduced here as arithmetic.
 */
import assert from "node:assert/strict";

const { caretLineTopOf, placePopup, POPUP_MIN_HEIGHT } =
  await import("../../packages/client/src/lib/tag-popup-placement.js");

interface Box {
  top: number;
  bottom: number;
  height: number;
}

const box = (top: number, bottom: number): Box => ({ top, bottom, height: bottom - top });

/** A textarea style that yields a 18px line and the given top padding. */
const style = (lineHeight = "18px", paddingTop = "8px") => ({ lineHeight, fontSize: "14px", paddingTop });

// --- The reported failure ----------------------------------------------------
// Viewport is 900 tall; the settings drawer body starts at 260, so the clipping
// band is 260..900 and the 780px field inside it overflows it.
const drawer = box(260, 900);
const tallField = box(260, 1040);
const POPUP_HEIGHT = 240;

{
  const caretLineTop = caretLineTopOf({
    caret: 0,
    value: "chibi",
    scrollTop: 0,
    rect: tallField,
    bounds: drawer,
    style: style(),
  });

  const { top, availableHeight } = placePopup({
    bounds: drawer,
    rect: tallField,
    caretLineTop,
    popupHeight: POPUP_HEIGHT,
  });

  // The regression: the list must not cover the line the caret is on.
  assert.ok(
    top >= caretLineTop || top + availableHeight <= caretLineTop,
    `popup must not cover the caret's line (top=${top}, caretLine=${caretLineTop}, h=${availableHeight})`,
  );
  assert.ok(top >= drawer.top, "popup stays inside the clipping container");
  assert.ok(top + availableHeight <= drawer.bottom, "popup does not overflow the clipping container");
  assert.ok(availableHeight > POPUP_MIN_HEIGHT, "a tall field still gets a usable list, not the bare minimum");
}

// The caret's position within a tall field must actually change the outcome,
// otherwise the anchor is not being used.
{
  const place = (value: string, caret: number, scrollTop: number) =>
    placePopup({
      bounds: drawer,
      rect: tallField,
      caretLineTop: caretLineTopOf({ caret, value, scrollTop, rect: tallField, bounds: drawer, style: style() }),
      popupHeight: POPUP_HEIGHT,
    });

  const manyLines = Array.from({ length: 40 }, (_, index) => `tag_${index}`).join("\n");
  const early = place(manyLines, 3, 0);
  const later = place(manyLines, manyLines.indexOf("tag_20"), 0);
  assert.notEqual(early.top, later.top, "a caret further down the field moves the popup");

  const caretLineFor = (value: string, caret: number, scrollTop = 0) =>
    caretLineTopOf({ caret, value, scrollTop, rect: tallField, bounds: drawer, style: style() });
  assert.ok(caretLineFor(manyLines, manyLines.indexOf("tag_20")) > caretLineFor(manyLines, 3), "line probe advances");
}

// --- Ordinary fields keep hanging under the whole field ----------------------
{
  const viewport = box(0, 900);
  const field = box(509, 652);
  const { top, availableHeight } = placePopup({
    bounds: viewport,
    rect: field,
    caretLineTop: field.top,
    popupHeight: POPUP_HEIGHT,
  });

  assert.equal(top, field.bottom + 4, "a normal field anchors below the whole field, not below the caret");
  assert.ok(availableHeight > 0, "a normal field gets a visible list");
}

// --- Near the bottom the list flips above ------------------------------------
{
  const viewport = box(0, 900);
  const field = box(513, 900);
  const { top, availableHeight } = placePopup({
    bounds: viewport,
    rect: field,
    caretLineTop: field.top,
    popupHeight: POPUP_HEIGHT,
  });

  assert.ok(top + availableHeight <= field.top + 1, "the list flips above a field with no room below");
  assert.ok(top >= viewport.top, "the flipped list stays on screen");
}

// --- A short container clamps but stays usable -------------------------------
{
  const container = box(260, 400);
  const field = box(280, 360);
  const { top, availableHeight } = placePopup({
    bounds: container,
    rect: field,
    caretLineTop: field.top,
    popupHeight: POPUP_HEIGHT,
  });

  assert.ok(availableHeight >= POPUP_MIN_HEIGHT, "a short container still shows a usable list");
  assert.ok(top >= container.top && top + availableHeight <= container.bottom, "the list stays inside the container");
}

// --- The line probe ignores scroll direction mistakes ------------------------
{
  // Scrolled far past the caret, the probe must stay inside the field rather than
  // floating above it.
  const lineTop = caretLineTopOf({
    caret: 0,
    value: "one\ntwo",
    scrollTop: 5000,
    rect: tallField,
    bounds: drawer,
    style: style(),
  });
  assert.ok(lineTop >= tallField.top, "a scrolled-away caret still anchors inside the field");

  // A field that does not overflow returns its own top, ignoring the caret.
  const shortField = box(300, 400);
  assert.equal(
    caretLineTopOf({
      caret: 10,
      value: "a\nb\nc",
      scrollTop: 0,
      rect: shortField,
      bounds: drawer,
      style: style(),
    }),
    shortField.top,
    "a field that fits its container is anchored by the field, not the caret",
  );
}

console.log("tag-popup-placement regression passed");

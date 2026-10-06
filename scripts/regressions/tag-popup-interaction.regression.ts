/**
 * Regression for the two popup bugs reported from real use.
 *
 * Bug A: the popup could not grow. It measured its own laid-out height and wrote it
 * back as `maxHeight`, so a one-row popup capped itself at one row forever and only
 * the row list scrolled. The height used for fitting must come from the popup's
 * natural content height, never from its already-constrained box.
 *
 * Bug B: dismissal was cleared only by a text edit, so clicking back into a tag did
 * nothing and the popup looked dead until the user typed.
 */
import assert from "node:assert/strict";

const { isDismissalStillActive } = await import("../../packages/client/src/lib/tag-autocomplete-dismissal.js");
const { placePopup, POPUP_MIN_HEIGHT } = await import("../../packages/client/src/lib/tag-popup-placement.js");

const box = (top: number, bottom: number) => ({ top, bottom, height: bottom - top });

// --- Bug B: dismissal is scoped to a point, not to the whole field -----------
{
  const dismissed = { value: "blonde hair, chibi", caret: 5 };

  // The selection change that immediately follows the dismissal must not reopen.
  assert.equal(
    isDismissalStillActive(dismissed, { value: "blonde hair, chibi", caret: 5 }),
    true,
    "the same caret and text stay dismissed",
  );

  // Clicking into a different tag is intent to see suggestions again.
  assert.equal(
    isDismissalStillActive(dismissed, { value: "blonde hair, chibi", caret: 16 }),
    false,
    "moving the caret into another tag reopens",
  );

  // So is moving within the same tag, and so is an edit.
  assert.equal(
    isDismissalStillActive(dismissed, { value: "blonde hair, chibi", caret: 2 }),
    false,
    "caret move reopens",
  );
  assert.equal(isDismissalStillActive(dismissed, { value: "blonde hai", caret: 5 }), false, "an edit reopens");

  // A field that was never dismissed is never suppressed.
  assert.equal(
    isDismissalStillActive(null, { value: "anything", caret: 3 }),
    false,
    "no dismissal means not suppressed",
  );

  // The earlier behaviour: any edit cleared suppression, but nothing else did. That
  // is what made clicking back into a tag do nothing.
  const oldBehaviour = (caretMoved: boolean, edited: boolean) => !edited;
  assert.equal(oldBehaviour(true, false), true, "the old rule kept the list closed after a caret move (the bug)");
}

// --- Bug A: the popup must be free to grow ----------------------------------
{
  // Viewport with 800px below the field: the popup has room for its full height.
  const bounds = box(0, 900);
  const field = box(100, 200);

  // A natural content height of 240 must yield a 240 popup, NOT the 40 a one-row
  // box would have reported.
  const grown = placePopup({ bounds, rect: field, caretLineTop: field.top, popupHeight: 240 });
  assert.equal(grown.availableHeight, 240, "a tall list gets its full height when there is room");

  // The same field with a one-row list stays small, which is correct.
  const small = placePopup({ bounds, rect: field, caretLineTop: field.top, popupHeight: 40 });
  assert.equal(small.availableHeight, 40, "a short list stays short");

  // Growing must never be blocked by the previous size, so the two calls are
  // independent: the second is not capped to the first.
  assert.ok(grown.availableHeight > small.availableHeight, "the popup grows when the list grows");

  // Near the bottom of a roomy container, the popup flips above the field rather
  // than being capped to a previous smaller height.
  const roomy = box(0, 900);
  const lowField = box(600, 700);
  const flipped = placePopup({ bounds: roomy, rect: lowField, caretLineTop: lowField.top, popupHeight: 240 });
  assert.equal(flipped.availableHeight, 240, "a low field still gets the full height when there is room above");
  assert.ok(flipped.top + flipped.availableHeight <= lowField.top + 1, "the flipped popup sits above the field");

  // In a container too short for even the minimum, the popup takes the minimum and
  // is clamped inside the container. Overlapping the field is unavoidable there —
  // the alternative is not showing the list at all.
  const tiny = box(0, 300);
  const tinyField = box(240, 300);
  const clamped = placePopup({ bounds: tiny, rect: tinyField, caretLineTop: tinyField.top, popupHeight: 240 });
  assert.equal(clamped.availableHeight, POPUP_MIN_HEIGHT, "a container shorter than the minimum grants the minimum");
  assert.ok(clamped.top >= tiny.top, "the clamped popup stays inside its container");
  assert.ok(clamped.top + clamped.availableHeight <= tiny.bottom, "the clamped popup does not overflow");
}

// --- Bug A, the arithmetic that caused it -----------------------------------
{
  // Demonstrates the feedback loop the fix removes. With the old code the input
  // height was the popup's own offsetHeight, so once capped it stayed capped.
  const oldStyleCap = (offsetHeight: number) => Math.min(offsetHeight, 240);
  assert.equal(oldStyleCap(40), 40, "measuring the constrained box returns the constrained height");
  assert.equal(oldStyleCap(oldStyleCap(oldStyleCap(40))), 40, "and it never recovers, however often it re-runs");
}

console.log("tag-popup-interaction regression passed");

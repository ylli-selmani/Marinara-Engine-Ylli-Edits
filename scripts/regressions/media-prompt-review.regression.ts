// ──────────────────────────────────────────────
// Regression: server mirror of "Expose media prompts before sending" (#7794)
// ──────────────────────────────────────────────
// The review toggle lives in the client's synced `ui` app setting. Server-initiated
// generation (images inside a chat turn, tracker portraits) has no request body to
// read it from, so the server keeps a mirror next to the media-queue toggle. Pinned
// here: the default is off, only an explicit boolean `true` turns it on, unrelated
// `ui` keys and malformed values leave it off, and every later write (or removal)
// replaces the value.
import assert from "node:assert/strict";

const { applyMediaReviewUiSettingsValue, shouldReviewMediaPrompts } = await import(
  "../../packages/server/src/services/media/media-review-settings.js"
);

const ui = (value: Record<string, unknown>) => JSON.stringify(value);

// Before any settings are read the toggle is off, matching the client default.
assert.equal(shouldReviewMediaPrompts(), false, "review must default to off");

applyMediaReviewUiSettingsValue(ui({ reviewImagePromptsBeforeSend: true }));
assert.equal(shouldReviewMediaPrompts(), true, "explicit true turns review on");

applyMediaReviewUiSettingsValue(ui({ reviewImagePromptsBeforeSend: false }));
assert.equal(shouldReviewMediaPrompts(), false, "explicit false turns review off");

// Another `ui` consumer must not be able to turn review on.
applyMediaReviewUiSettingsValue(ui({ queueImageGenerationRequests: true }));
assert.equal(shouldReviewMediaPrompts(), false, "an unrelated ui key leaves review off");

// Only a real boolean is a decision; strings and numbers are not settings.
for (const value of ["true", 1, null, undefined] as const) {
  applyMediaReviewUiSettingsValue(JSON.stringify({ reviewImagePromptsBeforeSend: true }));
  applyMediaReviewUiSettingsValue(ui({ reviewImagePromptsBeforeSend: value }));
  assert.equal(shouldReviewMediaPrompts(), false, `non-boolean value ${String(value)} must leave review off`);
}

// Bad or absent settings data falls back to off instead of throwing.
for (const value of [null, "", "{not json", JSON.stringify([true]), JSON.stringify("true")] as const) {
  applyMediaReviewUiSettingsValue(ui({ reviewImagePromptsBeforeSend: true }));
  applyMediaReviewUiSettingsValue(value);
  assert.equal(shouldReviewMediaPrompts(), false, `value ${String(value)} must fall back to off`);
}

// Every write replaces the previous decision, including removal of the whole object.
applyMediaReviewUiSettingsValue(ui({ reviewImagePromptsBeforeSend: true }));
assert.equal(shouldReviewMediaPrompts(), true);
applyMediaReviewUiSettingsValue(null);
assert.equal(shouldReviewMediaPrompts(), false, "removing the ui settings turns review off");

console.log("media-prompt-review regression: ok");

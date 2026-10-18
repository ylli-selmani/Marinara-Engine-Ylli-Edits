// ──────────────────────────────────────────────
// Media: "Expose media prompts before sending"
// ──────────────────────────────────────────────
//
// The review toggle lives in the client's synced `ui` app setting. UI-initiated
// routes get it in the request body, but server-initiated generation (images
// produced inside a chat turn, tracker portraits) never sees a request body, so
// mirror the value here the same way the media queue toggle is mirrored in
// image-generation-queue.ts.

/** Off unless the synced `ui` settings say otherwise: the client default is off. */
let reviewMediaPromptsBeforeSend = false;

/**
 * Mirror the user's "Expose media prompts before sending" toggle from the synced
 * `ui` app setting (null = key removed). Only an explicit `true` turns it on.
 */
export function applyMediaReviewUiSettingsValue(value: string | null): void {
  let parsed: unknown = null;
  if (value) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  const flag =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).reviewImagePromptsBeforeSend
      : undefined;
  reviewMediaPromptsBeforeSend = flag === true;
}

/** Load the toggle at startup; app-settings writes keep it current afterwards. */
export async function loadMediaReviewUiSettings(storage: { get(key: string): Promise<string | null> }) {
  applyMediaReviewUiSettingsValue(await storage.get("ui"));
}

/** True when the user wants to approve every media prompt before it is sent. */
export function shouldReviewMediaPrompts(): boolean {
  return reviewMediaPromptsBeforeSend;
}

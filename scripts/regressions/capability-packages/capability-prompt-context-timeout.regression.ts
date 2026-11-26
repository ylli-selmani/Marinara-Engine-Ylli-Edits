/**
 * Capability API 1.839: a prompt-context contributor may ask for a longer deadline (for one model call over its
 * retrieval candidates), clamped between the 2 s default and 15 s. One that asks for nothing keeps 2 s.
 */
import assert from "node:assert/strict";
import {
  CONTRIBUTOR_MAX_TIMEOUT_MS,
  CONTRIBUTOR_TIMEOUT_MS,
  collectCapabilityPromptContext,
  registerCapabilityPromptContext,
  resolveContributorTimeout,
} from "../../../packages/server/src/services/capability-packages/capability-prompt-context.service.js";

assert.equal(resolveContributorTimeout(undefined), CONTRIBUTOR_TIMEOUT_MS);
assert.equal(resolveContributorTimeout(Number.NaN), CONTRIBUTOR_TIMEOUT_MS);
assert.equal(resolveContributorTimeout(500), CONTRIBUTOR_TIMEOUT_MS, "can't ask for less than the default");
assert.equal(resolveContributorTimeout(4_000.7), 4_000);
assert.equal(resolveContributorTimeout(60_000), CONTRIBUTOR_MAX_TIMEOUT_MS);

const slow = (text: string) => () =>
  new Promise<string>((resolve) => {
    setTimeout(() => resolve(text), CONTRIBUTOR_TIMEOUT_MS + 300);
  });

const releaseDefault = registerCapabilityPromptContext("default-deadline", slow("too late"));
const releaseLonger = registerCapabilityPromptContext("longer-deadline", slow("librarian picks"), {
  timeoutMs: CONTRIBUTOR_TIMEOUT_MS + 1_500,
});
try {
  const result = await collectCapabilityPromptContext({ chatId: "chat-1", chatMeta: {}, mode: "roleplay" });
  assert.deepEqual(result.packageBlocks, [{ packageId: "longer-deadline", text: "librarian picks" }]);
} finally {
  releaseDefault();
  releaseLonger();
}

console.log("capability-prompt-context-timeout regression passed");

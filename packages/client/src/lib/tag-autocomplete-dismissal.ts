/**
 * When a dismissed tag list is allowed to reopen.
 *
 * Split out of the hook because it is a pure decision over (dismissed-at, current)
 * and because getting it wrong is invisible in a unit test but very visible to a
 * user: the popup looks dead until they type.
 */

/** The field state a dismissal was recorded against. */
export interface DismissalPoint {
  /** Field text at the moment of dismissal. */
  value: string;
  /** Caret offset at the moment of dismissal. */
  caret: number;
}

/**
 * True when a dismissed list should stay closed.
 *
 * Suppression is scoped to the exact caret and text it was dismissed at. The list
 * reopens as soon as either changes, so clicking into a different tag — or anywhere
 * else in the field — offers suggestions again, while the selection change that
 * immediately follows a dismissal does not bounce the list back open.
 *
 * Clearing suppression only on a text edit was the earlier behaviour, and it made
 * the popup stop responding to clicks entirely until the user typed something.
 */
export function isDismissalStillActive(
  dismissedAt: DismissalPoint | null,
  current: { value: string; caret: number },
): boolean {
  if (!dismissedAt) return false;
  return dismissedAt.value === current.value && dismissedAt.caret === current.caret;
}

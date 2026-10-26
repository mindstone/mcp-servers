/**
 * Index arithmetic for moving a tab (a Docs tab or a Sheets sheet) to a new
 * position among its siblings.
 *
 * Both Docs `updateDocumentTabProperties.index` and Sheets
 * `updateSheetProperties.index` count positions *before* the moved item is
 * removed from its current place. Moving a tab forward within the same parent
 * therefore needs one more than the final position (moving A in [A, B, C] to
 * position 1 means index 2; index 1 would be a no-op). Moves backwards, and
 * moves to a different parent, use the final position unchanged.
 *
 * `targetPosition` is the 0-based position the tab should end up at among its
 * destination siblings (not counting the tab itself).
 */
export function computeMoveApiIndex(args: {
  sameParent: boolean;
  currentIndex: number;
  targetPosition: number;
}): number {
  const { sameParent, currentIndex, targetPosition } = args;
  return sameParent && currentIndex < targetPosition ? targetPosition + 1 : targetPosition;
}

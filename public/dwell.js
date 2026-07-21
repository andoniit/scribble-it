// Dwell-to-select: hold the cursor over a control and it activates.
// Nothing about the hand shape changes at the moment of commit, so the
// cursor can't drift off target the way it does when a pinch pulls the
// fingertip aside.

export const DWELL_MS = 700;
export const DWELL_TOLERANCE = 34; // px of wander allowed before restarting

export function createDwell({
  dwellMs = DWELL_MS,
  tolerance = DWELL_TOLERANCE,
  isEligible = () => true,
  onProgress = () => {},
  onSelect = (el) => el.click(),
  now = () => performance.now(),
} = {}) {
  let target = null;
  let start = 0;
  let anchor = null;
  let fired = false;

  function cancel() {
    target = null;
    anchor = null;
    fired = false;
    onProgress(0);
  }

  function update(el, x, y) {
    if (!el || !isEligible(el)) {
      if (target) cancel();
      return;
    }

    if (el !== target) {
      target = el;
      start = now();
      anchor = { x, y };
      fired = false;
      onProgress(0);
      return;
    }

    if (fired) return; // already selected — move away and back to repeat

    // the hand must stay reasonably still, so merely passing over a
    // control on the way somewhere else never triggers it
    if (Math.hypot(x - anchor.x, y - anchor.y) > tolerance) {
      start = now();
      anchor = { x, y };
      onProgress(0);
      return;
    }

    const progress = Math.min(1, (now() - start) / dwellMs);
    onProgress(progress);
    if (progress >= 1) {
      fired = true;
      onProgress(0);
      onSelect(target);
    }
  }

  return { update, cancel };
}

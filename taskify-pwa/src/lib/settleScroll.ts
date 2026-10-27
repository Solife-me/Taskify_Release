/**
 * Scrolls a container so a target position sticks, even while the content above it is still
 * being measured. Virtualized lists place unmeasured rows by estimate, so a single jump lands in
 * the wrong place once real heights arrive (and a remounting virtualizer can reset the scroll).
 *
 * Each animation frame it reads the target and the current position:
 * - while the position moves on its own (a smooth scroll in progress), it waits;
 * - once the position is still and off target, it corrects it;
 * - when the position has matched the target for two frames, it reports success.
 *
 * It stops, reporting failure, when the user starts scrolling (`userInterrupted`) or after
 * `maxFrames`. Returns a function that cancels it without reporting.
 */
export function settleScroll({
  target,
  current,
  scrollTo,
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (id) => window.cancelAnimationFrame(id),
  userInterrupted = () => false,
  maxFrames = 120,
  onDone,
}: {
  /** Where the container should be scrolled to; null while it is not known yet. */
  target: () => number | null;
  current: () => number;
  scrollTo: (top: number) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  userInterrupted?: () => boolean;
  maxFrames?: number;
  onDone?: (settled: boolean) => void;
}): () => void {
  let frameId: number | null = null;
  let frames = 0;
  let stableFrames = 0;
  let last: number | null = null;

  const finish = (settled: boolean) => {
    frameId = null;
    onDone?.(settled);
  };

  const tick = () => {
    frames += 1;
    if (userInterrupted() || frames > maxFrames) {
      finish(false);
      return;
    }
    const position = current();
    const moving = last !== null && Math.abs(position - last) >= 1;
    last = position;
    const goal = moving ? null : target();
    if (goal !== null) {
      if (Math.abs(position - goal) < 1) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          finish(true);
          return;
        }
      } else {
        stableFrames = 0;
        scrollTo(goal);
        last = goal;
      }
    } else {
      stableFrames = 0;
    }
    frameId = requestFrame(tick);
  };

  frameId = requestFrame(tick);
  return () => {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
  };
}

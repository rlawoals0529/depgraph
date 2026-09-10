// Vendored from yozora/js/motion.tsx. Refresh with `node scripts/vendor.mjs` there,
// never edit here.
/**
 * The two bits of motion these pages actually want, written out rather than installed.
 *
 * A motion library is fifty kilobytes to do this, and what it buys you is the
 * fade-and-slide that every generated page already has. What follows is the part that is
 * worth having: a figure that counts to its value so you can see it change, and a reveal
 * that arrives in the order the content is read.
 *
 * Both stop dead under `prefers-reduced-motion`. Not "shorter" - off, landing on the
 * final value immediately, because for some people this is a symptom trigger rather than
 * a preference.
 */
import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Ease-out cubic: fast first, settling at the end.
 *
 * A number that decelerates reads as arriving somewhere. A linear one reads as a loading
 * bar, which says the value is not final yet, and here it always is.
 */
export const easeOut = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Where a count from `from` to `to` has got to, `elapsed` into `duration`. */
export function tickTo(from: number, to: number, elapsed: number, duration: number): number {
  // A target that is not a number is a caller's bug, and the worst place to surface it is
  // by writing "NaN" into the page. Hold the last good value instead.
  if (!Number.isFinite(to)) return Number.isFinite(from) ? from : 0;
  if (!Number.isFinite(from)) return to;
  if (!(duration > 0) || elapsed >= duration) return to;
  if (elapsed <= 0) return from;
  return from + (to - from) * easeOut(elapsed / duration);
}

/**
 * A figure that counts to its target.
 *
 * Counting from whatever was on screen, not from zero, so a value that changes by a
 * little moves by a little. Restarting from zero on every update turns a small correction
 * into a slot machine.
 */
export function useTicker(value: number, duration = 650): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const began = from.current;
    const step = (now: number) => {
      const elapsed = now - start;
      const next = tickTo(began, value, elapsed, duration);
      setShown(next);
      if (elapsed < duration) frame.current = requestAnimationFrame(step);
      else from.current = value;
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [value, duration]);

  return shown;
}

/**
 * The style for one item in a staggered reveal.
 *
 * The delay is capped, because a stagger that keeps growing means the last row of a long
 * list arrives seconds after the first and the page feels broken rather than considered.
 * Everything past the cap arrives together, which is what you want: the stagger is there
 * to show reading order, not to be counted.
 */
export function stagger(index: number, step = 26, cap = 340): React.CSSProperties {
  if (prefersReducedMotion()) return {};
  return { animationDelay: `${Math.min(index * step, cap)}ms` };
}

/**
 * A figure that counts to its value.
 *
 * Rendered through `toFixed` at a fixed number of decimals so the width does not change
 * as it counts. Combined with the tabular figures base.css sets, the number stays put
 * while it moves, which is the difference between a counter and a jitter.
 */
export function Ticker({
  value,
  decimals = 0,
  suffix = "",
  duration,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  duration?: number;
}) {
  const shown = useTicker(value, duration);
  return <>{shown.toFixed(decimals)}{suffix}</>;
}

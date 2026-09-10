// Vendored from yozora/js/motion.test.ts. Refresh with `node scripts/vendor.mjs` there,
// never edit here.
import { describe, expect, it } from "vitest";
import { easeOut, tickTo, stagger } from "./motion.js";

describe("easeOut", () => {
  it("runs from 0 to 1", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  it("decelerates: more than half the distance is covered in the first half", () => {
    // This is the property that makes a number read as arriving rather than loading.
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it("clamps rather than overshooting", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
  });
});

describe("tickTo", () => {
  it("starts at from and finishes exactly on to", () => {
    expect(tickTo(0, 100, 0, 600)).toBe(0);
    expect(tickTo(0, 100, 600, 600)).toBe(100);
    // Landing near the target is not landing on it. A counter that stops at 99.97 and
    // renders "100" is fine until the day it renders "99.97".
    expect(tickTo(0, 100, 5000, 600)).toBe(100);
  });

  it("moves monotonically towards the target", () => {
    let last = -Infinity;
    for (let t = 0; t <= 600; t += 25) {
      const v = tickTo(0, 100, t, 600);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it("counts down as well as up", () => {
    expect(tickTo(100, 0, 300, 600)).toBeLessThan(100);
    expect(tickTo(100, 0, 600, 600)).toBe(0);
  });

  it("a zero or negative duration lands immediately instead of dividing by zero", () => {
    expect(tickTo(0, 42, 0, 0)).toBe(42);
    expect(tickTo(0, 42, 10, -5)).toBe(42);
  });

  it("never returns NaN, whichever bound is broken", () => {
    // One NaN reaching a DOM text node shows the reader the word NaN, which is the worst
    // possible place to report a caller's bug.
    expect(tickTo(NaN, 42, 10, 600)).toBe(42);
    expect(tickTo(0, NaN, 10, 600)).toBe(0);
    expect(tickTo(NaN, NaN, 10, 600)).toBe(0);
  });
});

describe("stagger", () => {
  it("delays each item a little more than the last", () => {
    expect(stagger(0).animationDelay).toBe("0ms");
    expect(stagger(1).animationDelay).toBe("26ms");
    expect(stagger(3).animationDelay).toBe("78ms");
  });

  it("caps, so a long list does not trail in for seconds", () => {
    // Item 200 must not arrive five seconds after item one.
    expect(stagger(200).animationDelay).toBe("340ms");
    expect(stagger(13).animationDelay).toBe("338ms");
    expect(stagger(14).animationDelay).toBe("340ms");
  });
});

import { expect, test } from "@playwright/test";
import { describeFailures, probeContrast } from "./contrast-probe.js";

/**
 * Both halves of the palette, measured where the colours land.
 *
 * This app vendors a PAIR - one dark palette and one light - switched by the reader's own
 * preference rather than by a picker. So there is no attribute to set and no list to sweep:
 * the two "palettes" are the two colour schemes, and applying one means emulating it.
 *
 * The light half is the one that goes unlooked-at, which is exactly why it is measured.
 */

const SCHEMES = [{ id: "dark" }, { id: "light" }] as const;

test("no text is below AA contrast, in either colour scheme", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();

  const probe = await probeContrast(page, [...SCHEMES], {
    apply: async (p, scheme) => p.emulateMedia({ colorScheme: scheme as "dark" | "light" }),
  });

  // A selector that stopped matching would make this pass by measuring nothing.
  expect(probe.styles).toBeGreaterThan(5);
  // And both halves have to have actually painted. One means the media query never applied
  // and the light palette was never looked at.
  expect(probe.distinctPalettes, "one of the two colour schemes painted nothing of its own").toBe(SCHEMES.length);

  expect(probe.failures, describeFailures(probe.failures)).toEqual([]);
});

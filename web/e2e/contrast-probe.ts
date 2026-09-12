// Vendored from yozora/js/contrast-probe.ts. Refresh with `node scripts/vendor.mjs` there,
// never edit here.
import type { Page } from "@playwright/test";

/**
 * Measure every piece of visible text on the page, in every palette, against the surface it
 * is actually painted on.
 *
 * A palette check that reads the token files can only say the tokens are fine. What fails is
 * never the token on its own: it is a --dim that clears --bg sitting on a chip painted
 * --raised, or an option in a picker whose label was scoped to the palette it offers rather
 * than the one on screen. Only a browser knows where a colour landed.
 *
 * Call it once per distinct STATE of the page, not once per page. A state with a table, a
 * chart or a result in it has surfaces the empty state does not, and neither is a subset of
 * the other.
 *
 *   const probe = await probeContrast(page);
 *   expect(probe.styles).toBeGreaterThan(9);          // it measured something
 *   expect(probe.failures, describeFailures(probe.failures)).toEqual([]);
 */

export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

/** Colours settle over 140ms. Sampling sooner reads a value mid-transition, and every such
 *  reading is a false failure - which is how this first "found" thirteen of them. */
const SETTLE = 450;

export interface Reading {
  theme: string;
  cls: string;
  text: string;
  ratio: number;
  need: number;
  size: number;
}

export interface Probe {
  failures: Reading[];
  measured: number;
  /** Deduplicated text styles seen in the first palette, so a caller can refuse an empty run. */
  styles: number;
  samples: string[];
  /** `TAG.class` of each of those, so a caller can name an element that must have been seen. */
  classes: string[];
  /**
   * How many of the palettes actually painted something different.
   *
   * Evidence that applying a palette did anything at all. Without it a sweep that silently
   * fails to switch - the wrong `apply` for how this page loads its palettes, or a scoped
   * stylesheet that stopped being scoped - measures one palette however many times and
   * reports that as full coverage.
   *
   * A FINGERPRINT per palette, not a count of grounds: one palette paints several surfaces,
   * so "more than one ground" is satisfied by a sweep that never switched. Ask for a number
   * near the number of palettes.
   */
  distinctPalettes: number;
}

export interface ProbeOptions {
  /**
   * What is behind the page.
   *
   * Almost every page paints an opaque ground of its own, and then this never comes up. A
   * page that does not - a desktop widget floating over somebody's wallpaper - is read
   * against whatever is behind it, and the only honest answer is to measure the extremes.
   * White is the browser's own default canvas, so it is the default here.
   */
  backdrop?: string;
  /**
   * How a palette gets applied.
   *
   * Setting `data-theme` on the root is how a page with all fifteen palettes in one scoped
   * stylesheet switches, which is most of them. A consumer that ships one file per palette
   * and loads one at a time has no attribute to set, and the default silently does nothing
   * there - every palette measures identical numbers and the sweep is one palette fifteen
   * times, reported as fifteen.
   */
  apply?: (page: Page, theme: string) => Promise<void>;
}

const setDataTheme = async (page: Page, theme: string) => {
  await page.evaluate((id) => document.documentElement.setAttribute("data-theme", id), theme);
};

/**
 * @param themes the palettes to sweep, from the generated manifest.
 *
 * Passed rather than imported, because not every consumer keeps the manifest in the same
 * place and a probe that reaches for `../src/theme/palettes.json` cannot be used by one that
 * does not have it.
 */
export async function probeContrast(
  page: Page,
  themes: readonly { id: string }[],
  { backdrop = "#ffffff", apply = setDataTheme }: ProbeOptions = {},
): Promise<Probe> {
  const failures: Reading[] = [];
  let measured = 0;
  let styles = 0;
  let samples: string[] = [];
  let classes: string[] = [];
  const fingerprints = new Set<string>();

  for (const theme of themes) {
    await apply(page, theme.id);
    await page.waitForTimeout(SETTLE);

    const rows = await page.evaluate((behind: string) => {
      const seen = new Set<string>();
      const out: { cls: string; text: string; color: string; bg: string; opacity: number; size: number; weight: string }[] = [];
      // Chromium serialises a color-mix() to `color(srgb r g b)`, not to rgb(). Matching only
      // rgb() here treated a mixed background as transparent and walked past it to the wrong
      // ground - and matching only rgb() on the FOREGROUND made the whole check pass on text
      // deliberately dimmed to 2:1, which is how the hole was found.
      const alphaOf = (c: string): number | null => {
        const rgb = c.match(/rgba?\(([^)]+)\)/);
        if (rgb) return rgb[1]!.split(/[,\s/]+/).filter(Boolean).map(Number)[3] ?? 1;
        const srgb = c.match(/color\(\s*srgb\s+([^)]+)\)/);
        if (srgb) return srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number)[3] ?? 1;
        return null;
      };
      /** Every opacity between the element and the ground it is read against, multiplied. */
      const fadeOf = (el: Element): number => {
        let n: Element | null = el;
        let fade = 1;
        while (n) {
          fade *= Number(getComputedStyle(n).opacity || 1);
          const c = getComputedStyle(n).backgroundColor;
          const a = alphaOf(c);
          if (n !== el && a !== null && a > 0.99) break;
          n = n.parentElement;
        }
        return fade;
      };
      const rgbOf = (c: string): [number, number, number, number] | null => {
        const rgb = c.match(/rgba?\(([^)]+)\)/);
        if (rgb) {
          const p = rgb[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
          return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
        }
        const srgb = c.match(/color\(\s*srgb\s+([^)]+)\)/);
        if (srgb) {
          const p = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
          return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1];
        }
        return null;
      };
      const composite = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));
      /*
       * The ground these glyphs are actually read on, composited from the backdrop forward.
       *
       * Stopping at the first OPAQUE ancestor was the first version, and it is right only
       * while one exists. A panel at 85% over a desktop wallpaper is the ground, and walking
       * past it to the body measured the wrong thing in both directions: it reported failures
       * on text that is fine and passed text that is not.
       */
      const groundOf = (el: Element): string => {
        const stack: [number, number, number, number][] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = rgbOf(getComputedStyle(n).backgroundColor);
          if (c && c[3] > 0.001) stack.push(c);
          if (c && c[3] > 0.999) break;
        }
        let ground = rgbOf(behind) ?? [255, 255, 255, 1];
        for (const layer of stack.reverse()) ground = [...composite(layer, ground), 1] as [number, number, number, number];
        return `rgb(${ground[0]}, ${ground[1]}, ${ground[2]})`;
      };
      for (const el of document.querySelectorAll("body *")) {
        const text = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent!.trim())
          .join(" ")
          .trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        /*
         * checkVisibility(), not a display/visibility pair.
         *
         * A closed <details> hides its contents with content-visibility rather than with
         * display, and the pair above says nothing about that - so a button inside one was
         * measured as if it were on the page. Worse, Chromium does not run style updates in
         * a content-visibility-hidden subtree, so its computed colour is whatever it was
         * when the subtree was last rendered: switching palette left the element reporting
         * the PREVIOUS palette's colour against the current background, and the mismatch
         * read as a contrast failure that nobody could see or fix.
         */
        /*
         * opacityProperty, because the default does not check it.
         *
         * A tooltip that lives at `opacity: 0` until hover is not on the page, and measuring
         * it gives 1:1 against its own ground - a finding about text nobody can see, on a
         * control that works. Two of those came out of one widget's dock labels.
         *
         * This is not the same as the disabled exemption below: a disabled control IS
         * visible and is exempt by rule; this one is simply not being shown.
         */
        if (!el.checkVisibility({ opacityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        /*
         * WCAG 1.4.3 exempts text that is part of an inactive control, and it has to be
         * exempted here too: a disabled button is dimmed on purpose, so holding it to 4.5
         * would mean either failing every page that has one or never dimming one again.
         */
        if (el.closest(":disabled, [aria-disabled='true']")) continue;
        // SVG text is painted by `fill`, and reading `color` there measures a colour the
        // glyphs were never drawn in.
        const inSvg = (el as SVGElement).ownerSVGElement != null;
        const color = inSvg && cs.fill !== "none" ? cs.fill : cs.color;
        const key = `${el.tagName}.${el.getAttribute("class")}|${color}|${cs.fontSize}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          cls: `${el.tagName}.${el.getAttribute("class") ?? ""}`,
          text: text.slice(0, 30),
          color,
          bg: groundOf(el),
          // Opacity on an ancestor fades the text as surely as an alpha in its own colour,
          // and a computed `color` does not carry it. Without this, a block set to 0.6 is
          // measured at the contrast it would have had if somebody had not faded it.
          opacity: fadeOf(el),
          size: parseFloat(cs.fontSize),
          weight: cs.fontWeight,
        });
      }
      return out;
    }, backdrop);

    if (!styles) {
      styles = rows.length;
      samples = rows.map((r) => r.text);
      classes = rows.map((r) => r.cls);
    }

    // Every colour this palette painted, in one string. Two palettes that produce the same
    // one are the same palette, whatever the loop thinks it applied.
    fingerprints.add(rows.map((r) => `${r.color}|${r.bg}`).sort().join(";"));

    for (const row of rows) {
      const fg = parse(row.color);
      const bg = parse(row.bg);
      // A colour this cannot read is a hole in the measurement, not a row to skip quietly.
      // Skipping is what let a 2:1 caption through: the browser had serialised its colour in
      // a notation the parser did not know, and an unreadable colour counted as no finding.
      if (!fg || !bg) throw new Error(`unreadable colour "${row.color}" on "${row.bg}" at ${row.cls}`);
      measured++;
      const alpha = fg[3] * row.opacity;
      const flat = alpha < 1 ? blend([fg[0], fg[1], fg[2], alpha], bg) : [fg[0], fg[1], fg[2]];
      const ratio = contrast(flat, [bg[0], bg[1], bg[2]]);
      const large = row.size >= 24 || (row.size >= 18.66 && Number(row.weight) >= 700);
      const need = large ? AA_LARGE : AA_TEXT;
      if (ratio + 1e-9 < need) {
        failures.push({ theme: theme.id, cls: row.cls, text: row.text, ratio, need, size: row.size });
      }
    }
  }

  return { failures, measured, styles, samples, classes, distinctPalettes: fingerprints.size };
}

export const describeFailures = (f: Reading[]): string =>
  f.map((r) => `${r.theme} ${r.cls} ${r.size}px "${r.text}" ${r.ratio.toFixed(2)}:1 needs ${r.need}`).join("\n");

/** Both notations Chromium serialises a computed colour in: rgb() and color(srgb …). */
function parse(value: string): [number, number, number, number] | null {
  const rgb = value.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const p = rgb[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
  }
  // color-mix() and any colour written in a wide-gamut space come back like this, with the
  // channels in 0..1 rather than 0..255.
  const srgb = value.match(/color\(\s*srgb\s+([^)]+)\)/);
  if (srgb) {
    const p = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
    return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p.length > 3 ? p[3]! : 1];
  }
  return null;
}

const channel = (c: number) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const luminance = ([r, g, b]: number[]) =>
  0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A translucent foreground is really the colour you get after it is composited. */
const blend = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));

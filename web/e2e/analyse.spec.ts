import { test, expect, type Page } from "@playwright/test";
import { DUPLICATES, LICENSES, SIZE, TREE, WHY } from "./fixtures.js";

const API = "http://127.0.0.1:8100";
/** The page uses the API only when told to. */
const LIVE = `/?api=${encodeURIComponent(API)}`;

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Point the page at the API, and answer every endpoint.
 *
 * `?api=` is how the page is told to use a live engine: without it the build answers from
 * the crawls shipped with it, and these tests are about the live path. One build serves both,
 * which is why both can be tested without building twice.
 */
async function stubApi(page: Page) {
  await page.route(`${API}/crawl/**`, (r) => r.fulfill(json({ ok: true })));
  await page.route(`${API}/size/**`, (r) => r.fulfill(json(SIZE)));
  await page.route(`${API}/duplicates/**`, (r) => r.fulfill(json(DUPLICATES)));
  await page.route(`${API}/licenses/**`, (r) => r.fulfill(json(LICENSES)));
  await page.route(`${API}/tree/**`, (r) => r.fulfill(json(TREE)));
  await page.route(`${API}/why/**`, (r) => r.fulfill(json(WHY)));
}

test("shows nothing but the form until you ask", async ({ page }) => {
  await stubApi(page);
  await page.goto(LIVE);
  await expect(page.getByRole("heading", { name: "Package" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost" })).toBeHidden();
});

test("separates what is installed from how many ways it is reached", async ({ page }) => {
  await stubApi(page);
  await page.goto(LIVE);
  await page.getByRole("button", { name: "Analyse" }).click();

  await expect(page.getByRole("heading", { name: "Cost" })).toBeVisible();

  // The distinction the whole tool exists to make: 232 paths, but only 72 things to install.
  const cost = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Cost" }) });
  await expect(cost.getByText("72", { exact: true })).toBeVisible();
  await expect(cost.getByText("232", { exact: true })).toBeVisible();
  await expect(cost.getByText("2.11 MB")).toBeVisible();
  await expect(cost.getByText("5.03 MB")).toBeVisible();
  // 5274140 / 2212659 = 2.38, and the page must round it the same way rather than restate it.
  await expect(cost.getByText("2.4×")).toBeVisible();
});

test("counts the unknown-size caveat in packages, the unit everything else uses", async ({ page }) => {
  await stubApi(page);
  await page.goto(LIVE);
  await page.getByRole("button", { name: "Analyse" }).click();

  // This once read 53, because it counted paths while every other figure counted packages,
  // which inflated the tool's own caveat by 2.8x. It is 19 of 72, not 53 of 232.
  await expect(page.getByText(/no size for/)).toContainText("19");
  await expect(page.getByText(/no size for/)).not.toContainText("53");
});

test("explains why a package is present as a path, not a claim", async ({ page }) => {
  await stubApi(page);
  await page.goto(LIVE);
  await page.getByRole("button", { name: "Analyse" }).click();
  await page.getByRole("button", { name: "Explain" }).click();

  const chips = page.locator(".chip");
  await expect(chips.filter({ hasText: "express@4.21.2" })).toBeVisible();
  await expect(chips.filter({ hasText: "send@0.19.0" })).toBeVisible();
  await expect(chips.filter({ hasText: "ms@2.1.3" })).toBeVisible();
});

test("an API error is shown, and does not leave a half-built page behind", async ({ page }) => {
  await page.route(`${API}/crawl/**`, (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"express@4.21.2 has not been crawled"}' }),
  );
  await page.goto(LIVE);
  await page.getByRole("button", { name: "Analyse" }).click();

  // The API's own message, which is the one that says what to do next. A generic
  // "request failed" throws away the only useful part.
  await expect(page.locator(".err")).toContainText("4.21.2");
  await expect(page.getByRole("heading", { name: "Cost" })).toBeHidden();
});

test("a stale result is cleared when the next analyse fails", async ({ page }) => {
  await stubApi(page);
  await page.goto(LIVE);
  await page.getByRole("button", { name: "Analyse" }).click();
  await expect(page.getByRole("heading", { name: "Cost" })).toBeVisible();

  await page.unroute(`${API}/crawl/**`);
  await page.route(`${API}/crawl/**`, (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"the registry is down"}' }),
  );
  await page.getByRole("textbox", { name: "Package name" }).fill("lodash");
  await page.getByRole("button", { name: "Analyse" }).click();

  await expect(page.locator(".err")).toContainText("registry is down");
  // Numbers left on screen after a failed refresh read as this package's numbers, and
  // they belong to the previous one.
  await expect(page.getByRole("heading", { name: "Cost" })).toBeHidden();
});

test("the server under test is this app, not another app on the same port", async ({ page }) => {
  await page.goto("/");
  /*
   * playwright.config.ts reuses a server that is already listening, so a port two projects
   * share means one project's running preview quietly answers the other's tests. That has
   * happened here twice, and once it produced a completely green run against the wrong page.
   * Ports are unique now; this is what catches the next way it goes wrong.
   */
  await expect(page).toHaveTitle(/^depgraph/);
});

/**
 * The default path: no engine, real crawls shipped with the page.
 *
 * These run against the SAME build as the tests above. One build serves both, chosen at
 * runtime by `?api=`, so the page that gets deployed is the page that gets tested.
 */
test("with no engine it answers from crawls shipped with it, and says so first", async ({ page }) => {
  // Every request is a failure here: the whole claim is that nothing reaches a network.
  const requests: string[] = [];
  await page.goto("/");
  page.on("request", (r) => {
    if (new URL(r.url()).host !== new URL(page.url()).host) requests.push(r.url());
  });

  // Before any number is read, not under it: a precomputed figure taken for a live one is
  // the page's fault rather than the reader's.
  const provenance = page.locator(".provenance");
  await expect(provenance).toBeVisible();
  await expect(provenance).toContainText("Precomputed");
  await expect(provenance).toContainText(/run on \d{4}-\d{2}-\d{2}/);
  const order = await page.evaluate(() => {
    const p = document.querySelector(".provenance")!;
    const first = document.querySelector("section.panel")!;
    return (p.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(order, "the provenance sits below the form").toBe(true);

  await page.getByRole("button", { name: "Analyse" }).click();
  await expect(page.getByRole("heading", { name: "Cost" })).toBeVisible();

  // Real numbers from a real crawl, not the trimmed fixtures the stubbed tests use.
  const packages = Number(await page.locator(".metric").filter({ hasText: "packages" }).locator("b").first().innerText());
  expect(packages).toBeGreaterThan(50);
  expect(requests, `it reached the network: ${requests.join(", ")}`).toEqual([]);
});

test("a package it does not ship is refused by name, with what it does ship", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Package name" }).fill("left-pad");
  await page.getByRole("textbox", { name: "Exact version" }).fill("1.3.0");
  await page.getByRole("button", { name: "Analyse" }).click();

  // "Failed to fetch" would be a true statement about a server that was never going to be
  // there, and useless. This says what the build has and how to get the rest.
  const error = page.locator(".err");
  await expect(error).toContainText("no crawl for left-pad@1.3.0");
  await expect(error).toContainText("express@4.21.2");
  await expect(error).toContainText("?api=");
});

test("it ships a package that reaches nothing, not only ones that sprawl", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Package name" }).fill("chalk");
  await page.getByRole("textbox", { name: "Exact version" }).fill("5.3.0");
  await page.getByRole("button", { name: "Analyse" }).click();

  // A tool that only ever shows sprawl has not shown you what a clean dependency looks like.
  await expect(page.getByRole("heading", { name: "Cost" })).toBeVisible();
  const packages = Number(await page.locator(".metric").filter({ hasText: "packages" }).locator("b").first().innerText());
  expect(packages).toBe(1);
});

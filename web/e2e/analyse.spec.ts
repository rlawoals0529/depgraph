import { test, expect, type Page } from "@playwright/test";
import { DUPLICATES, LICENSES, SIZE, TREE, WHY } from "./fixtures.js";

const API = "http://127.0.0.1:8100";
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Every endpoint answers, so a test that fails is failing about the page, not the network. */
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
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Package" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost" })).toBeHidden();
});

test("separates what is installed from how many ways it is reached", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
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
  await page.goto("/");
  await page.getByRole("button", { name: "Analyse" }).click();

  // This once read 53, because it counted paths while every other figure counted packages,
  // which inflated the tool's own caveat by 2.8x. It is 19 of 72, not 53 of 232.
  await expect(page.getByText(/no size for/)).toContainText("19");
  await expect(page.getByText(/no size for/)).not.toContainText("53");
});

test("explains why a package is present as a path, not a claim", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
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
  await page.goto("/");
  await page.getByRole("button", { name: "Analyse" }).click();

  // The API's own message, which is the one that says what to do next. A generic
  // "request failed" throws away the only useful part.
  await expect(page.locator(".err")).toContainText("4.21.2");
  await expect(page.getByRole("heading", { name: "Cost" })).toBeHidden();
});

test("a stale result is cleared when the next analyse fails", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
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

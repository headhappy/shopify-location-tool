// Real Express routes, password hashing, sessions and database adapter; mocked Shopify only.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import express from "express";
import { chromium } from "playwright";
import { createBundleRouter } from "../server/bundle-routes.js";
import { hashPassword } from "../server/bundle-auth.js";
import { setup, manager, vid, locationId } from "./bundle-fixtures.js";

const cleanups = [],
  ctx = await setup({ after: (fn) => cleanups.push(fn) }),
  app = express();
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const password = "Browser test password!";
app.use(
  "/api/bundles",
  createBundleRouter({
    ...ctx,
    users: [{ ...manager, passwordHash: await hashPassword(password) }],
    origin,
    secure: false,
  }),
);
app.use(express.static("public"));
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BUNDLE_BROWSER_CHANNEL
    ? { channel: process.env.BUNDLE_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
try {
  await page.goto(origin + "/assembly-history.html");
  await page.getByLabel("Staff ID", { exact: true }).fill(manager.id);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Kit recipes", exact: true }).click();
  await page
    .getByRole("button", { name: "Start with Crown Rolling Kit" })
    .click();
  await page.locator("#recipe-editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("#recipe-components .component").count(), 4);
  assert.equal(await page.locator("#recipe-components .binding").count(), 4);
  await page
    .getByLabel("Who manages this finished stock?")
    .selectOption("physical");
  await page.getByRole("button", { name: "Check & save recipe" }).click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("version 1"),
  );
  await page.getByRole("button", { name: "Test a kit", exact: true }).click();
  await page.locator("#assembly-finished").selectOption(vid(101));
  await page.locator("#assembly-location").selectOption(locationId);
  await page.locator("#assembly-quantity").fill("2");
  await page.locator("#resolve").click();
  await page.locator("#components-panel").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("[data-component-id=tray] option").count(),
    2,
  );
  assert.equal(
    await page.locator("[data-component-id=grinder] option").count(),
    7,
  );
  const scan = page
    .locator("#assembly-components .component")
    .nth(1)
    .getByLabel("Scan barcode or exact SKU");
  await scan.fill("GRINDER_2");
  await scan.press("Enter");
  assert.equal(
    await page.locator("[data-component-id=grinder]").inputValue(),
    vid(302),
  );
  await page.locator("#components-confirmed").check();
  await page.locator("#preview").click();
  await page.locator("#preview-panel").waitFor({ state: "visible" });
  assert.match(await page.locator("#preview-panel").textContent(), /£13.54/);
  assert.match(
    await page.locator("#preview-panel").textContent(),
    /Applied adjustments: 0/,
  );
  await page.screenshot({
    path: "test-results/bundle-desktop.png",
    fullPage: true,
  });
  const saved = await ctx.store.listPreviews();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].components.find((v) => v.id === vid(302)).quantity, 2);
  // Retry same user action retains the idempotency key; no extra snapshot or stock write.
  await page.locator("#preview").click();
  await page.waitForFunction(
    () => !document.getElementById("preview").disabled,
  );
  assert.equal((await ctx.store.listPreviews()).length, 1);
  await page.locator("#assembly-quantity").fill("3");
  assert.equal(await page.locator("#preview-panel").isHidden(), true);
  assert.equal(await page.locator("#components-panel").isHidden(), true);
  // History is readable and exporting uses the actual authenticated server route.
  await page
    .getByRole("button", { name: "Saved tests & export", exact: true })
    .click();
  await page.locator(".history-row").waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "head-happy-preview-history.csv");
  await page.getByRole("button", { name: "View", exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `No page overflow at ${width}px`,
    );
    await page.screenshot({
      path: `test-results/bundle-mobile-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Test saving a generic recipe through the product picker, not just the template.
  await page.getByRole("button", { name: "Kit recipes", exact: true }).click();
  await page.locator("#new-recipe").click();
  await page.locator("#recipe-name").fill("Custom assorted kit");
  await page.locator("#add-finished").click();
  await page.locator("#picker-query").fill("RBK_RC_M1_A1");
  await page.locator("#picker-search button").click();
  await page
    .getByRole("button", { name: /RBK_RC_M1_A1 · Crown V Rolling Kit/ })
    .click();
  await page.locator("#add-component").click();
  const component = page.locator("#recipe-components .component");
  await component
    .getByLabel("Component name", { exact: true })
    .fill("Assorted grinder");
  await component
    .getByLabel("Which items are allowed?")
    .selectOption("product");
  await component.getByLabel("Parent product ID").fill("8327686553754");
  await page.getByRole("button", { name: "Check & save recipe" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("status")
      .textContent.includes("Saved Custom assorted kit"),
  );
  assert.equal((await ctx.store.listRecipes()).length, 2);
  // The new till simulator uses the existing session and never saves an assembly.
  await page.getByRole("link", { name: "Scan a deal · test" }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  const crown = (await ctx.store.listRecipes()).find((r) =>
    r.name.includes("Crown"),
  );
  await page.locator("#deal").selectOption(crown.id);
  await page.locator("#location").selectOption(locationId);
  await page.getByRole("button", { name: "Start scanning" }).click();
  await page.locator("#till").waitFor({ state: "visible" });
  // Submit quickly: the scanner queue must preserve every unit without racing.
  for (const sku of ["RB_RC_M3", "GRINDER_4", "PAPK_RDY", "PAPR_RDY_A1"]) {
    await page.locator("#scan").fill(sku);
    await page.locator("#scan").press("Enter");
  }
  await page.waitForFunction(() =>
    document
      .getElementById("result-title")
      .textContent.includes("1 complete deal"),
  );
  assert.match(
    await page.locator("#totals").textContent(),
    /Test total£14\.99/,
  );
  assert.equal(await page.locator("#basket .basket-line").count(), 4);
  await page
    .getByRole("button", { name: "Remove one PAPK_RDY", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.getElementById("result-title").textContent === "Keep scanning…",
  );
  assert.match(
    await page.locator("#totals").textContent(),
    /Test total£44\.97/,
  );
  await page.getByText("No scanner? Choose an item", { exact: true }).click();
  await page
    .getByRole("button", { name: "Add Randy's Gold papers", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .getElementById("result-title")
      .textContent.includes("1 complete deal"),
  );
  await page.locator("#scan").fill("DOES-NOT-EXIST");
  await page.locator("#scan").press("Enter");
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("not found"),
  );
  assert.equal(await page.locator("#basket .basket-line").count(), 4);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `Deal page fits ${width}px`,
    );
    await page.screenshot({
      path: `test-results/deal-${width}.png`,
      fullPage: true,
    });
  }
  assert.equal((await ctx.store.listPreviews()).length, 1);
  await page.getByRole("button", { name: "Clear basket" }).click();
  await page.waitForFunction(
    () =>
      document.getElementById("result-title").textContent ===
      "Scan your first item",
  );
  await page.locator("#logout").click();
  await page.locator("#login-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  assert.ok(ctx.calls.every((c) => !c.query.includes("mutation")));
  console.log(
    "Browser checks passed: sign-in, Crown template, exact colour binding, scanner input, idempotent preview, stale-input invalidation, history/CSV, generic recipe, logout, desktop and 390/320px mobile. Zero Shopify mutations.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  for (const cleanup of cleanups.reverse()) await cleanup();
}

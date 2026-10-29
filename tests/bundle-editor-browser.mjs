import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import express from "express";
import { chromium } from "playwright";
import { createBundleRouter } from "../server/bundle-routes.js";
import { hashPassword } from "../server/bundle-auth.js";
import { setup, manager, vid } from "./bundle-fixtures.js";

const cleanups = [],
  ctx = await setup({ after: (fn) => cleanups.push(fn) }),
  app = express();
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`,
  password = "Editor test password!";
app.use(
  "/api/bundles",
  createBundleRouter({
    ...ctx,
    origin,
    secure: false,
    users: [{ ...manager, passwordHash: await hashPassword(password) }],
  }),
);
app.use(express.static("public"));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BUNDLE_BROWSER_CHANNEL
    ? { channel: process.env.BUNDLE_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
await mkdir("test-results", { recursive: true });
const search = async (text) => {
  await page.locator("#picker-query").fill(text);
  await page.locator("#picker-search button").click();
};
const confirm = async () => {
  await page.locator("#confirm-picker").click();
  await page.locator("#picker").waitFor({ state: "hidden" });
};
try {
  await page.goto(origin + "/bundle-builder.html");
  await page.getByLabel("Staff ID", { exact: true }).fill(manager.id);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create bundle", exact: true })
    .click();
  assert.equal(await page.locator("#add-components").isDisabled(), true);
  await page
    .getByRole("button", { name: "Select bundle", exact: true })
    .click();
  await search("Crown");
  await page
    .getByRole("radio", { name: "Crown V Rolling Kit", exact: true })
    .check();
  await confirm();
  await page
    .getByRole("button", { name: "Add components", exact: true })
    .click();
  await search("GRINDER");
  await page.locator("#picker-results input").check();
  await confirm();
  assert.match(
    await page.locator("#components").textContent(),
    /All colours · 6 eligible/,
  );
  await page
    .getByRole("button", { name: "Add components", exact: true })
    .click();
  await page.getByRole("button", { name: "SKU family", exact: true }).click();
  await search("RB_RC_M");
  await page.locator("#picker-results input").check();
  await confirm();
  await page
    .getByRole("button", { name: "Add components", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Specific item", exact: true })
    .click();
  await search("PAPK_RDY");
  await page.locator("#picker-results input").check();
  await confirm();
  assert.equal(await page.locator("#components .component-row").count(), 3);
  await page.locator("#components input[type=number]").first().fill("2");
  await page.screenshot({
    path: "test-results/bundle-editor-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save bundle", exact: true }).click();
  await page.locator("#bundle-list-panel").waitFor({ state: "visible" });
  let [saved] = await ctx.store.listRecipes();
  assert.equal(saved.components[0].quantity, 2);
  assert.equal(saved.components[0].rule.type, "product");
  assert.equal(saved.components[1].rule.type, "prefix");
  assert.equal(saved.components[2].rule.variantId, vid(401));
  assert.equal(
    saved.components.every((c) => c.bindingMode === "any"),
    true,
  );
  await page.reload();
  await page.getByRole("button", { name: "Edit bundle", exact: true }).click();
  await page.locator("#components .component-row").nth(2).waitFor();
  assert.equal(await page.locator("#components .component-row").count(), 3);
  // A subsequently added colour joins the product rule on reopen without a new bundle.
  const colour = structuredClone(ctx.rows.find((v) => v.id === vid(301)));
  colour.id = vid(399);
  colour.title = "Mint";
  colour.sku = "GRINDER_MINT";
  ctx.rows.push(colour);
  await page
    .getByRole("button", { name: "Back to bundles", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit bundle", exact: true }).click();
  await page.getByText("All colours · 7 eligible", { exact: true }).waitFor();
  assert.match(
    await page.locator("#components").textContent(),
    /All colours · 7 eligible/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/bundle-editor-phone.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 760 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Editor fits a 320px phone",
  );
  // Editing quantities never loses a saved row, and discard protects the prior definition.
  await page.locator("#components input[type=number]").first().fill("9");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  [saved] = await ctx.store.listRecipes();
  assert.equal(saved.components[0].quantity, 2);
  // Expired credentials clear the workspace; no fallback to public catalogue access.
  await ctx.pool.query("DELETE FROM hh_bundle_sessions");
  await page.reload();
  await page.locator("#login-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#workspace").isHidden(), true);
  assert.equal((await ctx.store.listPreviews()).length, 0);
  assert.equal(
    ctx.calls.some(({ query }) => /\bmutation\b/.test(query)),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Simple editor: product + family + exact SKU, quantities, save/reopen, new colour eligibility, discard, session expiry and phone layout passed.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  for (const fn of cleanups.reverse()) await fn();
}

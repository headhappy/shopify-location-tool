import test from "node:test";
import assert from "node:assert/strict";
import { createDealService, matchDeal, normalizeCart } from "../server/deal-service.js";
import { setup, savedCrown, vid, pid, locationId, manager } from "./bundle-fixtures.js";

const basket = (...ids) => ids.map((n) => ({ variantId: vid(n), quantity: 1 }));
async function fixture(t) {
  const c = await setup(t);
  const recipe = await savedCrown(c);
  const deals = createDealService(c);
  const input = (lines, rest = {}) => ({ recipeVersion: recipe.version, locationId, lines, ...rest });
  const deal = await deals.definition(recipe.id, locationId, recipe.version);
  return { ...c, recipe, deals, input, deal };
}
test("mixed colours recognise one deal without changing physical colour bindings or saving a preview", async (t) => {
  const c = await fixture(t);
  const result = await c.deals.test(c.recipe.id, c.input(basket(203, 304, 401, 402)));
  assert.equal(result.sets, 1);
  assert.equal(result.testTotal, 1499);
  assert.equal(result.regularTotal, 5996);
  assert.equal(result.saving, 4497);
  assert.equal(result.appliedAdjustments, 0);
  assert.equal(result.inventoryWritesEnabled, false);
  assert.equal(result.lines.find((l) => l.id === vid(203)).title, "Green");
  assert.equal(c.deal.groups.find((g) => g.id === "tray").items.length, 4);
  assert.equal(c.deal.groups.find((g) => g.id === "grinder").items.length, 6);
  assert.deepEqual(await c.store.recipe(c.recipe.id), c.recipe);
  assert.deepEqual(await c.store.listPreviews(), []);
  assert.ok(c.calls.every((call) => !/\bmutation\b/.test(call.query)));
});
test("incomplete basket stays full price; adding and removing a required item recalculates", async (t) => {
  const c = await fixture(t);
  const lines = basket(201, 305, 401);
  const incomplete = matchDeal(c.deal, lines);
  assert.equal(incomplete.sets, 0);
  assert.equal(incomplete.saving, 0);
  assert.equal(incomplete.testTotal, 4497);
  assert.equal(incomplete.groups.find((g) => g.id === "silver").nextNeeded, 1);
  assert.equal(matchDeal(c.deal, [...lines, ...basket(402)]).sets, 1);
  assert.equal(matchDeal(c.deal, lines.slice(1)).sets, 0);
});
test("multiple mixed sets consume units once; extras stay regular price in scan order", async (t) => {
  const c = await fixture(t);
  const result = matchDeal(c.deal, basket(201, 203, 206, 301, 304, 401, 401, 402, 402));
  assert.equal(result.sets, 2);
  assert.equal(result.testTotal, 1499 * 3);
  assert.equal(result.lines.find((l) => l.id === vid(206)).extraQuantity, 1);
  assert.equal(result.lines.reduce((sum, l) => sum + l.dealQuantity, 0), 8);
  assert.equal(result.lines.find((l) => l.id === vid(401)).quantity, 2);
});
test("per-deal quantities greater than one use floor counts and show next missing amount", async (t) => {
  const c = await fixture(t);
  c.deal.groups.find((g) => g.id === "gold").quantity = 2;
  const result = matchDeal(c.deal, basket(201, 301, 401, 402));
  assert.equal(result.sets, 0);
  assert.equal(result.groups.find((g) => g.id === "gold").nextNeeded, 1);
});
test("exact barcode, exact SKU and numeric SKU scan; ambiguous codes and names refuse", async (t) => {
  const c = await fixture(t);
  assert.equal((await c.catalog.scan("90000201", locationId)).id, vid(201));
  assert.equal((await c.catalog.scan("RB_RC_M3", locationId)).id, vid(203));
  c.rows.find((v) => v.id === vid(301)).sku = "123456";
  assert.equal((await c.catalog.scan("123456", locationId)).id, vid(301));
  c.rows.find((v) => v.id === vid(302)).barcode = "123456";
  await assert.rejects(c.catalog.scan("123456", locationId), /more than one/);
  await assert.rejects(c.catalog.scan("Black", locationId), /not found/);
});
test("scan appends exactly one unit and rejects unrelated or parent bundle codes", async (t) => {
  const c = await fixture(t);
  const result = await c.deals.test(c.recipe.id, c.input(basket(201), { scan: "RB_RC_M1" }));
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 2);
  await assert.rejects(c.deals.test(c.recipe.id, c.input([], { scan: "RBK_RC_M1_A1" })), /no longer qualifies/);
  await assert.rejects(c.deals.test(c.recipe.id, c.input(basket(999))), /no longer qualifies/);
});
test("eligibility is refreshed: excluded, deleted or archived members cannot be scanned", async (t) => {
  const c = await fixture(t);
  c.rows.find((v) => v.id === vid(301)).product.status = "ARCHIVED";
  await assert.rejects(c.deals.test(c.recipe.id, c.input(basket(301))), /no longer qualifies/);
  c.rows.splice(c.rows.findIndex((v) => v.id === vid(401)), 1);
  await assert.rejects(c.deals.test(c.recipe.id, c.input([])), /not found/);
});
test("overlapping groups are rejected before matching and exclusions can remove an overlap", async (t) => {
  const c = await fixture(t);
  c.deal.groups[1].items.push(c.deal.groups[0].items[0]);
  assert.throws(() => matchDeal(c.deal, []), /more than one component/);
  const recipe = structuredClone(c.recipe);
  recipe.components.find((g) => g.id === "grinder").rule.excludeVariantIds.push(vid(301));
  const changed = await c.store.saveRecipe(recipe, manager, recipe.id, recipe.version);
  await assert.rejects(c.deals.test(recipe.id, c.input(basket(301), { recipeVersion: changed.version })), /no longer qualifies/);
});
test("stock checks use aggregate basket demand, including extras and shared inventory IDs", async (t) => {
  const c = await fixture(t);
  const tray = c.deal.groups[0].items[0];
  tray.available = 1;
  c.deal.groups[0].items[1].inventoryItemId = tray.inventoryItemId;
  c.deal.groups[0].items[1].available = 1;
  const result = matchDeal(c.deal, basket(201, 202, 301, 401, 402));
  assert.equal(result.sets, 1);
  assert.equal(result.stockChecksPassed, false);
  assert.ok(result.warnings.some((w) => w.includes("only 1 available")));
  tray.available = null;
  assert.ok(matchDeal(c.deal, basket(201)).warnings.some((w) => w.includes("not available")));
});
test("untracked and nested bundles refuse; missing stock and draft components warn", async (t) => {
  const c = await fixture(t);
  const item = c.deal.groups[0].items[0];
  item.tracked = false;
  assert.throws(() => matchDeal(c.deal, basket(201)), /individually stocked/);
  item.tracked = true;
  item.requiresComponents = true;
  assert.throws(() => matchDeal(c.deal, basket(201)), /individually stocked/);
  item.requiresComponents = false;
  item.status = "DRAFT";
  assert.equal(matchDeal(c.deal, basket(201)).stockChecksPassed, false);
});
test("price calculation is integer pennies, server sourced, and never adds a surcharge", async (t) => {
  const c = await fixture(t);
  for (const group of c.deal.groups) for (const item of group.items) item.price = "0.10";
  let result = matchDeal(c.deal, basket(201, 301, 401, 402));
  assert.equal(result.testTotal, 40);
  assert.equal(result.saving, 0);
  assert.ok(result.warnings.some((w) => w.includes("cost less individually")));
  c.deal.price = 30;
  result = matchDeal(c.deal, basket(201, 301, 401, 402));
  assert.equal(result.testTotal, 30);
  assert.equal(result.saving, 10);
  const server = await c.deals.test(c.recipe.id, c.input(basket(201, 301, 401, 402), { price: 1, saving: 999999 }));
  assert.equal(server.testTotal, 1499);
});
test("changed recipe version, differing deal prices and multiple parents stop the test", async (t) => {
  const c = await fixture(t);
  await assert.rejects(c.deals.test(c.recipe.id, c.input([], { recipeVersion: 999 })), { status: 409 });
  c.rows.find((v) => v.id === vid(102)).price = "20.00";
  await assert.rejects(c.deals.test(c.recipe.id, c.input([])), /same price/);
  c.rows.find((v) => v.id === vid(102)).price = "14.99";
  c.rows.find((v) => v.id === vid(102)).product.id = pid(999);
  await assert.rejects(c.deals.test(c.recipe.id, c.input([])), /one deal product/);
});
test("invalid cart values, excessive quantities and unsafe prices fail closed", async (t) => {
  const c = await fixture(t);
  for (const quantity of [0, -1, 1.5, "1", null, 1001]) {
    assert.throws(() => normalizeCart([{ variantId: vid(201), quantity }]));
  }
  assert.throws(() => normalizeCart([{ variantId: vid(201), quantity: 600 }, { variantId: vid(201), quantity: 600 }]));
  assert.throws(() => normalizeCart([null]));
  assert.throws(() => normalizeCart({}));
  c.deal.groups[0].items[0].price = "0.001";
  assert.throws(() => matchDeal(c.deal, basket(201)), /price/);
  await assert.rejects(c.deals.test(c.recipe.id, c.input([], { locationId: "gid://shopify/Location/2" })), /active store/);
});

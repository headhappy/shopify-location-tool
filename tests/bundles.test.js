import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createBundleCatalog,
  BUNDLE_VARIANTS_QUERY,
  BUNDLE_NODES_QUERY,
  BUNDLE_LOCATIONS_QUERY,
  BUNDLE_SHOP_QUERY,
} from "../server/bundle-catalog.js";
import { normalizeRecipe } from "../server/bundle-service.js";
import {
  createBundleStore,
  migrateBundles,
  previewCursor,
} from "../server/bundle-store.js";
import { previewsCsv } from "../server/bundle-routes.js";
import { readOnlyBundleGraph } from "../server/bundle-catalog.js";
import {
  setup,
  savedCrown,
  previewInput,
  vid,
  pid,
  locationId,
  manager,
  graphFixture,
} from "./bundle-fixtures.js";

test("Crown resolves the real product and binds each tray colour while grinders remain flexible", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  for (const colour of [1, 2, 3, 6]) {
    const result = await c.service.resolve(r, vid(100 + colour), locationId);
    assert.deepEqual(
      result.components[0].candidates.map((v) => v.id),
      [vid(200 + colour)],
    );
    assert.equal(result.components[1].candidates.length, 6);
  }
  assert.equal(r.components[2].rule.variantId, vid(401));
  assert.equal(r.inventoryOwnership, "unconfirmed");
  assert.ok(c.calls.every((c) => !c.query.includes("mutation")));
});
test("new parent variants become eligible automatically; exclusions and restricted groups stay precise", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  const newVariant = structuredClone(c.rows.find((v) => v.id === vid(301)));
  newVariant.id = vid(307);
  newVariant.sku = "NEW_GRINDER";
  c.rows.push(newVariant);
  r.components[1].rule.excludeVariantIds = [vid(302)];
  const a = await c.service.resolve(r, vid(101), locationId);
  assert.ok(a.components[1].candidates.some((v) => v.id === vid(307)));
  assert.ok(!a.components[1].candidates.some((v) => v.id === vid(302)));
  r.components[1].rule = {
    type: "group",
    variantIds: [vid(301), vid(303)],
    excludeVariantIds: [],
  };
  assert.deepEqual(
    (
      await c.service.resolve(r, vid(101), locationId)
    ).components[1].candidates.map((v) => v.id),
    [vid(301), vid(303)],
  );
});
test("literal prefix cannot accept fuzzy siblings, search operators or arbitrary regular expressions", async (t) => {
  const c = await setup(t),
    r = await c.service.crownTemplate();
  assert.equal(
    (
      await c.catalog.rule({
        type: "prefix",
        value: "RB_RC_M",
        excludeVariantIds: [],
      })
    ).length,
    4,
  );
  for (const value of ["RB_*_M", "RB OR sku:X", ".*", "R", "RB:", "RB?"]) {
    r.components[0].rule.value = value;
    assert.throws(() => normalizeRecipe(r), /literal SKU prefix/);
  }
});
test("exact SKUs reject duplicate, deleted and retargeted variants", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    gold = c.rows.find((v) => v.id === vid(401));
  c.rows.push({ ...gold, id: vid(999) });
  await assert.rejects(
    () => c.service.resolve(r, vid(101), locationId),
    /duplicated/,
  );
  c.rows.pop();
  gold.id = vid(999);
  await assert.rejects(
    () => c.service.resolve(r, vid(101), locationId),
    /different variant/,
  );
  gold.sku = "RENAMED";
  await assert.rejects(
    () => c.service.resolve(r, vid(101), locationId),
    /not found/,
  );
});
test("missing colour bindings, self components, archived finished variants and invalid quantities cannot be saved", async (t) => {
  const c = await setup(t),
    base = await c.service.crownTemplate();
  let r = structuredClone(base);
  delete r.components[0].bindings[vid(101)];
  await assert.rejects(() => c.service.validateForSave(r), /ProductVariant ID/);
  r = structuredClone(base);
  r.components[0].bindings[vid(101)] = vid(301);
  await assert.rejects(() => c.service.validateForSave(r), /outside/);
  r = structuredClone(base);
  r.components[1].rule = { type: "group", variantIds: [vid(101)] };
  await assert.rejects(() => c.service.validateForSave(r), /finished variant/);
  for (const quantity of [0, -1, 1.5, "1", 1001]) {
    r = structuredClone(base);
    r.components[0].quantity = quantity;
    assert.throws(() => normalizeRecipe(r), /whole number/);
  }
  c.rows[0].product.status = "ARCHIVED";
  await assert.rejects(() => c.service.validateForSave(base), /archived/);
});
test("preview snapshots exact quantities, costs, staff, location and proposed deltas without changing stock", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  r.inventoryOwnership = "physical";
  const before = structuredClone(c.rows);
  const p = await c.service.preview(
    r,
    previewInput(r, { quantity: 2 }),
    manager,
  );
  assert.equal(p.totalComponentCost, "13.5400");
  assert.equal(p.unitComponentCost, "6.7700");
  assert.equal(p.indicativeMarginPercent, 54.84);
  assert.equal(p.status, "PREVIEW_ONLY");
  assert.equal(p.inventoryChanged, false);
  assert.equal(p.checksPassed, true);
  assert.equal(p.staff.id, "alex");
  assert.equal(p.finished.proposedDelta, 2);
  assert.ok(
    p.components.every((v) => v.quantity === 2 && v.proposedDelta === -2),
  );
  assert.deepEqual(c.rows, before);
  c.rows.find((v) => v.id === vid(401)).inventoryItem.unitCost.amount = "9.00";
  assert.equal(
    (await c.store.findPreview(p.idempotencyKey)).components.find(
      (v) => v.id === vid(401),
    ).cost.amount,
    "1.3600",
  );
});
test("duplicate submission is idempotent, including concurrent requests; reusing a key for different input fails", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    input = previewInput(r);
  const [a, b] = await Promise.all([
    c.service.preview(r, input, manager),
    c.service.preview(r, input, manager),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await c.store.listPreviews()).length, 1);
  await assert.rejects(
    () => c.service.preview(r, { ...input, quantity: 2 }, manager),
    /different inputs/,
  );
  await assert.rejects(
    () => c.service.preview(r, input, { id: "other", name: "Other" }),
    /different inputs/,
  );
});
test("overlapping groups aggregate demand before checking available stock", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  r.components.push({
    ...structuredClone(r.components[2]),
    id: "extra-gold",
    quantity: 20,
  });
  const input = previewInput(r);
  input.selections.push({ componentId: "extra-gold", variantId: vid(401) });
  const p = await c.service.preview(r, input, manager);
  assert.equal(p.components.find((v) => v.id === vid(401)).quantity, 21);
  assert.ok(p.blockers.some((b) => b.includes("needs 21, only 20")));
});
test("variants sharing an inventory item cannot evade aggregate stock validation", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    silver = c.rows.find((v) => v.id === vid(402)),
    gold = c.rows.find((v) => v.id === vid(401));
  silver.inventoryItem.id = gold.inventoryItem.id;
  silver.inventoryItem.inventoryLevel.quantities[0].quantity = 1;
  gold.inventoryItem.inventoryLevel.quantities[0].quantity = 1;
  const p = await c.service.preview(r, previewInput(r), manager);
  assert.ok(p.blockers.some((b) => b.includes("needs 2, only 1")));
});
test("wrong colour, incomplete confirmation, duplicate or missing selections and forged variants fail", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  await assert.rejects(
    () => c.service.preview(r, previewInput(r, { confirmed: false }), manager),
    /Confirm/,
  );
  let input = previewInput(r);
  input.selections[0].variantId = vid(202);
  await assert.rejects(() => c.service.preview(r, input, manager), /eligible/);
  input = previewInput(r);
  input.selections[1].componentId = "tray";
  await assert.rejects(() => c.service.preview(r, input, manager), /Duplicate/);
  input = previewInput(r);
  input.selections.pop();
  await assert.rejects(
    () => c.service.preview(r, input, manager),
    /one actual variant/,
  );
  await assert.rejects(
    () =>
      c.service.preview(
        r,
        previewInput(r, { locationId: "gid://shopify/Location/2" }),
        manager,
      ),
    /active Shopify/,
  );
});
test("unknown costs, untracked/unstocked items, virtual bundles and unconfirmed ownership are visible blockers", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    gold = c.rows.find((v) => v.id === vid(401));
  gold.inventoryItem.unitCost = null;
  gold.inventoryItem.tracked = false;
  gold.inventoryItem.inventoryLevel = null;
  c.rows[0].requiresComponents = true;
  const p = await c.service.preview(r, previewInput(r), manager);
  assert.equal(p.totalComponentCost, null);
  assert.equal(p.indicativeMarginPercent, null);
  for (const match of [
    /cost is missing/,
    /not tracked/,
    /no available/,
    /virtual bundle/,
    /Bundles.app/,
  ])
    assert.ok(
      p.blockers.some((b) => match.test(b)),
      String(match),
    );
});
test("foreign currency and malformed costs never produce a false zero-cost margin", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    cost = c.rows.find((v) => v.id === vid(401)).inventoryItem.unitCost;
  for (const amount of ["-1", "NaN", "1.00001", "99999999999999999"]) {
    cost.amount = amount;
    const p = await c.service.preview(r, previewInput(r), manager);
    assert.equal(p.totalComponentCost, null);
  }
  cost.amount = "1.00";
  cost.currencyCode = "USD";
  assert.equal(
    (await c.service.preview(r, previewInput(r), manager)).totalComponentCost,
    null,
  );
});
test("optimistic recipe versions preserve audited history and reject stale editors", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  const updated = await c.store.saveRecipe(
    { ...r, name: "Edited" },
    manager,
    r.id,
    1,
  );
  assert.equal(updated.version, 2);
  await assert.rejects(
    () => c.store.saveRecipe(r, manager, r.id, 1),
    /another session/,
  );
  const history = await c.store.recipeHistory(r.id);
  assert.deepEqual(
    history.map((r) => r.version),
    [2, 1],
  );
  assert.equal(history[1].name, r.name);
});
test(
  "real PostgreSQL rolls back a recipe edit if its audit insertion fails",
  { skip: !process.env.BUNDLE_TEST_DATABASE_URL },
  async (t) => {
    const c = await setup(t),
      r = await savedCrown(c);
    await c.pool.query(
      "ALTER TABLE hh_bundle_recipe_history ADD CONSTRAINT test_reject_version CHECK(version < 2)",
    );
    await assert.rejects(
      () =>
        c.store.saveRecipe({ ...r, name: "Must roll back" }, manager, r.id, 1),
      /test_reject_version/,
    );
    assert.equal((await c.store.recipe(r.id)).version, 1);
    assert.equal((await c.store.recipe(r.id)).name, r.name);
    assert.equal((await c.store.recipeHistory(r.id)).length, 1);
  },
);
test("database migration is repeatable, shop-bound, and sessions and recipes survive a new store instance", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c);
  await migrateBundles(c.pool, "example.myshopify.com");
  const next = createBundleStore(c.pool, "example.myshopify.com");
  await next.ready();
  assert.equal((await next.recipe(r.id)).version, 1);
  await assert.rejects(
    () => createBundleStore(c.pool, "wrong.myshopify.com").ready(),
    /not configured/,
  );
});
test("history cursor cannot skip equal timestamps and CSV neutralises formulas while retaining numeric deltas", async (t) => {
  const c = await setup(t),
    r = await savedCrown(c),
    p = await c.service.preview(r, previewInput(r), manager);
  const p2 = {
    ...p,
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash: "other",
  };
  await c.store.savePreview(p2);
  const first = await c.store.listPreviews({ limit: 1 }),
    second = await c.store.listPreviews({
      limit: 1,
      cursor: previewCursor(first[0]),
    });
  assert.equal(second.length, 1);
  assert.notEqual(first[0].id, second[0].id);
  p.components[0].sku = "=SUM(1,2)";
  const csv = previewsCsv([p]);
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"-1","0"/);
  assert.match(csv, /PREVIEW_ONLY/);
  await assert.rejects(
    () => c.store.listPreviews({ cursor: "not-a-cursor" }),
    /Invalid history/,
  );
});
test("catalogue pagination completes and refuses non-advancing cursors and oversized rules", async () => {
  const f = graphFixture();
  let count = 0;
  const catalog = createBundleCatalog(async () => ({
    productVariants: {
      nodes: [f.rows[count++]],
      pageInfo:
        count === 1
          ? { hasNextPage: true, endCursor: "next" }
          : { hasNextPage: false },
    },
  }));
  assert.equal((await catalog.lookup("Crown")).length, 2);
  await assert.rejects(
    () =>
      createBundleCatalog(async () => ({
        productVariants: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "same" },
        },
      })).lookup("Crown"),
    /did not advance/,
  );
  await assert.rejects(
    () =>
      createBundleCatalog(async () => ({
        productVariants: {
          nodes: Array(5001).fill(f.rows[0]),
          pageInfo: { hasNextPage: false },
        },
      })).lookup("Crown"),
    /too broad/,
  );
});
test("generated Shopify operations are read-only and request location-specific quantities", () => {
  for (const query of [
    BUNDLE_VARIANTS_QUERY,
    BUNDLE_NODES_QUERY,
    BUNDLE_LOCATIONS_QUERY,
    BUNDLE_SHOP_QUERY,
  ])
    assert.doesNotMatch(query, /\bmutation\b/);
  assert.match(
    BUNDLE_VARIANTS_QUERY,
    /inventoryLevel\(locationId: \$locationId\)/,
  );
  assert.match(BUNDLE_NODES_QUERY, /unitCost/);
});

test("an ordinary recipe edit cannot silently rebind a reassigned exact SKU", async (t) => {
  const c = await setup(t),
    recipe = await savedCrown(c);
  c.rows.find((v) => v.id === vid(401)).id = vid(999);
  const edited = structuredClone(recipe);
  edited.name = "Only renamed";
  // Even omitting or forging the browser's pin cannot override the stored ID.
  delete edited.components[2].rule.variantId;
  await assert.rejects(
    () => c.service.validateForSave(edited, recipe),
    /different variant/,
  );
  edited.components[2].rule.variantId = vid(999);
  await assert.rejects(
    () => c.service.validateForSave(edited, recipe),
    /different variant/,
  );
});

test("the bundle transport refuses mutations and unreviewed queries before reaching Shopify", async () => {
  let calls = 0;
  const graph = readOnlyBundleGraph(async () => {
    calls++;
    return {};
  });
  assert.throws(
    () =>
      graph(
        "mutation { inventoryAdjustQuantities { userErrors { message } } }",
      ),
    /reviewed Shopify read/,
  );
  assert.throws(
    () => graph("query { customers(first: 10) { nodes { id } } }"),
    /reviewed Shopify read/,
  );
  await graph(BUNDLE_SHOP_QUERY);
  assert.equal(calls, 1);
});

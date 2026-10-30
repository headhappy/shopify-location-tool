import test from "node:test";
import assert from "node:assert/strict";
import { setup, savedCrown, manager, pid, vid } from "./bundle-fixtures.js";
import {
  createBundleCatalog,
  BUNDLE_PRODUCTS_QUERY,
} from "../server/bundle-catalog.js";
import { normalizeComponentRule } from "../server/bundle-service.js";

test("simple bundle saves one product with dynamic families and exact components, and reopens unchanged", async (t) => {
  const c = await setup(t),
    old = await c.service.crownTemplate();
  const input = {
    ...old,
    bundleProductId: pid(16090289471869),
    components: old.components.map((v) => ({
      ...v,
      bindingMode: "any",
      bindings: {},
    })),
  };
  const normalized = await c.service.validateForSave(input);
  const saved = await c.store.saveRecipe(normalized, manager);
  assert.deepEqual(
    (await c.store.recipe(saved.id)).components,
    normalized.components,
  );
  assert.equal(saved.components[0].bindingMode, "any");
  const newGrinder = structuredClone(c.rows.find((v) => v.id === vid(301)));
  newGrinder.id = vid(399);
  newGrinder.sku = "GRINDER_NEW";
  newGrinder.title = "New colour";
  c.rows.push(newGrinder);
  const choices = await c.catalog.rule(saved.components[1].rule);
  assert.equal(choices.length, 7);
  assert.equal((await c.store.recipeHistory(saved.id)).length, 1);
  assert.equal(
    c.calls.some(({ query }) => /\bmutation\b/.test(query)),
    false,
  );
});

test("simple bundle rejects different output parents, sibling self-components and overlapping families", async (t) => {
  const c = await setup(t),
    original = await c.service.crownTemplate();
  const input = { ...original, bundleProductId: pid(16090289471869) };
  await assert.rejects(
    c.service.validateForSave({ ...input, bundleProductId: pid(20) }),
    /one bundle product/,
  );
  const sibling = {
    id: "self",
    name: "Sibling",
    quantity: 1,
    rule: { type: "exact_sku", value: "RBK_RC_M2_A1" },
  };
  await assert.rejects(
    c.service.validateForSave({
      ...input,
      finishedVariantIds: [vid(101)],
      components: [sibling],
    }),
    /cannot also be a component/,
  );
  const duplicate = { ...input.components[1], id: "duplicate" };
  await assert.rejects(
    c.service.validateForSave({
      ...input,
      components: [...input.components, duplicate],
    }),
    /already qualifies/,
  );
  // Existing physical assembly records retain their old semantics and history.
  const old = await savedCrown(c);
  assert.equal(old.components[0].bindingMode, "by_finished");
});

test("product search is literal, paginated and read-only, including draft bundle products", async () => {
  const calls = [],
    catalog = createBundleCatalog(async (query, variables) => {
      calls.push({ query, variables });
      return {
        products: {
          nodes: [
            {
              id: pid(1),
              title: "Bundle",
              status: "DRAFT",
              variantsCount: { count: 2 },
              variants: { nodes: [{ sku: "KIT_1" }] },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "next-page" },
        },
      };
    });
  const result = await catalog.products(
    "box OR status:archived",
    "previous-page",
  );
  assert.equal(calls[0].query, BUNDLE_PRODUCTS_QUERY);
  assert.match(calls[0].variables.query, /title:"OR"/);
  assert.match(calls[0].variables.query, /title:"status:archived"/);
  assert.equal(calls[0].variables.after, "previous-page");
  assert.equal(result.nextCursor, "next-page");
  assert.equal(result.products[0].variantCount, 2);
  await assert.rejects(
    catalog.products("box", "x".repeat(1001)),
    /Invalid search page/,
  );
});

test("component picker normalization rejects query syntax and requires explicit membership", () => {
  assert.deepEqual(
    normalizeComponentRule({ type: "prefix", value: "BOX_1_*" }),
    { type: "prefix", value: "BOX_1_", excludeVariantIds: [] },
  );
  assert.throws(
    () => normalizeComponentRule({ type: "prefix", value: "BOX OR sku:*" }),
    /literal SKU prefix/,
  );
  assert.throws(
    () => normalizeComponentRule({ type: "group", variantIds: [] }),
    /at least one/,
  );
  assert.throws(
    () => normalizeComponentRule({ type: "product", value: "arbitrary" }),
    /Product/,
  );
});

import { newDb } from "pg-mem";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createBundleStore, migrateBundles } from "../server/bundle-store.js";
import { createBundleCatalog } from "../server/bundle-catalog.js";
import { createBundleService } from "../server/bundle-service.js";
export const vid = (n) => `gid://shopify/ProductVariant/${n}`;
export const pid = (n) => `gid://shopify/Product/${n}`;
export const locationId = "gid://shopify/Location/1";
export const manager = { id: "alex", name: "Alex", role: "manager" };
export function variantsFixture() {
  const v = (id, sku, product, title, cost = "1.0000", available = 20) => ({
    id: vid(id),
    sku,
    title,
    barcode: `90000${id}`,
    price: "14.99",
    requiresComponents: false,
    product: {
      id: pid(product),
      title: sku.startsWith("RBK") ? "Crown V Rolling Kit" : sku,
      status: sku.startsWith("RBK") ? "DRAFT" : "ACTIVE",
    },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      tracked: true,
      unitCost: { amount: cost, currencyCode: "GBP" },
      inventoryLevel: {
        id: `level-${id}`,
        quantities: [{ name: "available", quantity: available }],
      },
    },
  });
  return [
    ...[1, 2, 3, 6].map((n) =>
      v(
        100 + n,
        `RBK_RC_M${n}_A1`,
        16090289471869,
        ["", "Black", "Blue", "Green", "", "", "Plain Wood"][n],
        "0",
        0,
      ),
    ),
    ...[1, 2, 3, 6].map((n) =>
      v(
        200 + n,
        `RB_RC_M${n}`,
        20,
        ["", "Black", "Blue", "Green", "", "", "Plain Wood"][n],
        "3.5000",
      ),
    ),
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      v(
        300 + n,
        `GRINDER_${n}`,
        8327686553754,
        ["", "Black", "Blue", "Green", "Red", "Orange", "Purple"][n],
        "0.7500",
      ),
    ),
    v(401, "PAPK_RDY", 40, "Gold", "1.3600"),
    v(402, "PAPR_RDY_A1", 41, "Silver", "1.1600"),
  ];
}
export function graphFixture(rows = variantsFixture()) {
  const calls = [];
  const graph = async (query, variables = {}) => {
    calls.push({ query, variables });
    if (/\bmutation\b/.test(query))
      throw new Error("TEST FAILURE: a Shopify mutation was attempted");
    if (query.includes("query BundleShop"))
      return {
        shop: { currencyCode: "GBP", taxesIncluded: true },
        currentAppInstallation: {
          accessScopes: [
            { handle: "read_products" },
            { handle: "read_inventory" },
            { handle: "read_locations" },
          ],
        },
      };
    if (query.includes("query BundleLocations"))
      return {
        locations: {
          nodes: [
            { id: locationId, name: "Dundee", isActive: true },
            {
              id: "gid://shopify/Location/2",
              name: "Inactive",
              isActive: false,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      };
    if (query.includes("query BundleNodes"))
      return {
        nodes: variables.ids.map((id) =>
          structuredClone(rows.find((v) => v.id === id) || null),
        ),
      };
    if (query.includes("query BundleProducts")) {
      const term =
        variables.query.match(/title:"([^"]+)"/)?.[1]?.toLowerCase() || "";
      const products = [
        ...new Map(rows.map((v) => [v.product.id, v.product])).values(),
      ].filter((p) =>
        rows.some(
          (v) =>
            v.product.id === p.id &&
            `${p.title} ${v.sku}`.toLowerCase().includes(term),
        ),
      );
      return {
        products: {
          nodes: products.map((p) => ({
            ...p,
            variantsCount: {
              count: rows.filter((v) => v.product.id === p.id).length,
            },
            variants: {
              nodes: rows
                .filter((v) => v.product.id === p.id)
                .slice(0, 1)
                .map((v) => ({ sku: v.sku })),
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    return {
      productVariants: {
        nodes: structuredClone(rows),
        pageInfo: { hasNextPage: false },
      },
    };
  };
  return { graph, calls, rows };
}
export async function setup(t) {
  let pool;
  if (process.env.BUNDLE_TEST_DATABASE_URL) {
    // Real Postgres CI uses a fresh schema per test; never touches app tables.
    const schema = `test_bundle_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({
      connectionString: process.env.BUNDLE_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: process.env.BUNDLE_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
  } else {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    t.after(() => pool.end());
  }
  await migrateBundles(pool, "example.myshopify.com");
  const store = createBundleStore(pool, "example.myshopify.com");
  const fixture = graphFixture(),
    catalog = createBundleCatalog(fixture.graph),
    service = createBundleService({ catalog, store });
  return { pool, store, catalog, service, ...fixture };
}
export async function savedCrown(ctx) {
  return ctx.store.saveRecipe(await ctx.service.crownTemplate(), manager);
}
export function previewInput(recipe, overrides = {}) {
  return {
    recipeVersion: recipe.version,
    finishedVariantId: vid(101),
    locationId,
    quantity: 1,
    confirmed: true,
    idempotencyKey: randomUUID(),
    selections: [
      { componentId: "tray", variantId: vid(201) },
      { componentId: "grinder", variantId: vid(301) },
      { componentId: "gold", variantId: vid(401) },
      { componentId: "silver", variantId: vid(402) },
    ],
    ...overrides,
  };
}

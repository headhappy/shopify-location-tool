/* ---------- index.js ---------- */
/*  Head Happy Stock Control + Locations + Short Sales – Express backend

    Existing location tool:
    1. POST /lookup-variant   – finds variant(s) by barcode
    2. POST /update-location  – writes stock.location metafield

    Stock-control endpoints:
    3. GET  /health
    4. GET  /api/locations
    5. GET  /api/shopify-stock.json
    6. GET  /api/shopify-stock.csv
    7. GET  /api/shopify-stock-by-location.json
    8. GET  /api/shopify-stock-by-location.csv

    Short sales endpoints (uses read_orders and the default recent-order access):
    9.  GET /api/shopify-sales.json
    10. GET /api/shopify-sales.csv

    Note:
    - Stock endpoints use variant.inventoryQuantity, so total stock can work with basic
      read_products access.
    - Location-level stock needs read_inventory + read_locations.
    - Sales endpoints currently return 1d / 7d / 30d only. 90d / 180d are placeholders
      until long-range order access is approved or a local history cache is added.
*/

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOPIFY_SHOP; // your-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // shpat_xxx
const API = process.env.SHOPIFY_API_VERSION || "2024-07";

if (!SHOP || !TOKEN) {
  console.error("❌ Set SHOPIFY_SHOP & SHOPIFY_ACCESS_TOKEN in env.");
  process.exit(1);
}

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

/* ---------- helpers ---------- */
async function shopifyGraph(query, variables = {}) {
  const response = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.errors) {
    throw new Error(JSON.stringify(payload.errors));
  }
  return payload.data;
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function rowsToCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows
    .map((row) => columns.map((col) => csvEscape(row[col])).join(","))
    .join("\n");
  return body ? `${header}\n${body}` : header;
}

function sendCsv(res, filename, rows, columns) {
  const csv = rowsToCsv(rows, columns);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + csv);
}

function normalise(value) {
  return String(value ?? "").trim().toLowerCase();
}

function includesNeedle(value, needle) {
  if (!needle) return true;
  return normalise(value).includes(normalise(needle));
}

function availableFromInventoryLevel(levelNode) {
  const quantities = levelNode?.quantities || [];
  const available = quantities.find((q) => q.name === "available");
  return Number(available?.quantity ?? 0);
}

function buildVariantSearchQuery({ sku, barcode }) {
  const parts = [];
  if (sku) parts.push(`sku:${sku}`);
  if (barcode) parts.push(`barcode:${barcode}`);
  return parts.join(" AND ");
}

function filterStockRows(rows, reqQuery) {
  const skuContains = reqQuery.skuContains || "";
  const productContains = reqQuery.productContains || "";
  const inStockOnly = reqQuery.inStockOnly === "1" || reqQuery.inStockOnly === "true";

  return rows.filter((row) => {
    if (skuContains && !includesNeedle(row.SKU, skuContains)) return false;
    if (productContains && !includesNeedle(row.Product, productContains)) return false;
    if (inStockOnly && Number(row.Available || 0) <= 0) return false;
    return true;
  });
}

const STOCK_COLUMNS = [
  "Product",
  "Variant",
  "SKU",
  "Barcode",
  "Vendor",
  "Tags",
  "ProductStatus",
  "Tracked",
  "Available",
  "Location",
  "LocationId",
  "InventoryItemId",
  "VariantId",
  "ProductId",
  "Price",
  "Handle",
];

async function getLocations() {
  const query = `
    query locations($first: Int!) {
      locations(first: $first) {
        edges { node { id name isActive } }
      }
    }`;
  const data = await shopifyGraph(query, { first: 100 });
  return data.locations.edges.map((edge) => edge.node);
}

async function getVariantStockTotal({ search = "", tag = "", vendor = "", status = "ACTIVE" } = {}) {
  const query = `
    query variantStockTotal($first: Int!, $after: String, $query: String) {
      productVariants(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            sku
            barcode
            price
            inventoryQuantity
            product {
              id
              title
              handle
              vendor
              status
              tags
            }
          }
        }
      }
    }`;

  const rows = [];
  let after = null;
  let page = 0;
  const variantQuery = search ? search : null;

  do {
    page += 1;
    const data = await shopifyGraph(query, { first: 250, after, query: variantQuery });
    const connection = data.productVariants;

    for (const edge of connection.edges) {
      const variant = edge.node;
      const product = variant.product || {};
      const tags = Array.isArray(product.tags) ? product.tags : [];

      if (status && status !== "ALL" && product.status !== status) continue;
      if (tag && !tags.some((t) => normalise(t) === normalise(tag))) continue;
      if (vendor && normalise(product.vendor) !== normalise(vendor)) continue;

      rows.push({
        Product: product.title || "",
        Variant: variant.title === "Default Title" ? "" : variant.title || "",
        SKU: variant.sku || "",
        Barcode: variant.barcode || "",
        Vendor: product.vendor || "",
        Tags: tags.join("|"),
        ProductStatus: product.status || "",
        Tracked: "",
        InventoryItemId: "",
        VariantId: variant.id || "",
        ProductId: product.id || "",
        LocationId: "",
        Location: "TOTAL",
        Available: Number(variant.inventoryQuantity ?? 0),
        Price: variant.price || "",
        Handle: product.handle || "",
      });
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 100) throw new Error("Pagination safety stop hit after 100 pages.");
  } while (after);

  return rows;
}

async function getVariantStockByLocation({
  search = "",
  tag = "",
  vendor = "",
  locationId = "",
  status = "ACTIVE",
} = {}) {
  const query = `
    query variantStockByLocation($first: Int!, $after: String, $query: String) {
      productVariants(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            sku
            barcode
            price
            inventoryQuantity
            product { id title handle vendor status tags }
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 50) {
                edges {
                  node {
                    id
                    quantities(names: ["available"]) { name quantity }
                    location { id name }
                  }
                }
              }
            }
          }
        }
      }
    }`;

  const rows = [];
  let after = null;
  let page = 0;
  const variantQuery = search ? search : null;

  do {
    page += 1;
    const data = await shopifyGraph(query, { first: 250, after, query: variantQuery });
    const connection = data.productVariants;

    for (const edge of connection.edges) {
      const variant = edge.node;
      const product = variant.product || {};
      const tags = Array.isArray(product.tags) ? product.tags : [];

      if (status && status !== "ALL" && product.status !== status) continue;
      if (tag && !tags.some((t) => normalise(t) === normalise(tag))) continue;
      if (vendor && normalise(product.vendor) !== normalise(vendor)) continue;

      const inventoryLevels = variant.inventoryItem?.inventoryLevels?.edges || [];
      for (const levelEdge of inventoryLevels) {
        const level = levelEdge.node;
        const loc = level.location || {};
        if (locationId && loc.id !== locationId) continue;

        rows.push({
          Product: product.title || "",
          Variant: variant.title === "Default Title" ? "" : variant.title || "",
          SKU: variant.sku || "",
          Barcode: variant.barcode || "",
          Vendor: product.vendor || "",
          Tags: tags.join("|"),
          ProductStatus: product.status || "",
          Tracked: variant.inventoryItem?.tracked ? "TRUE" : "FALSE",
          InventoryItemId: variant.inventoryItem?.id || "",
          VariantId: variant.id || "",
          ProductId: product.id || "",
          LocationId: loc.id || "",
          Location: loc.name || "",
          Available: availableFromInventoryLevel(level),
          Price: variant.price || "",
          Handle: product.handle || "",
        });
      }
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 100) throw new Error("Pagination safety stop hit after 100 pages.");
  } while (after);

  return rows;
}

/* ---------- sales helpers ---------- */

function startOfDayUtc(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function isoDaysAgo(days) {
  const d = startOfDayUtc();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function addQty(map, sku, qty) {
  if (!sku) return;
  map[sku] = (map[sku] || 0) + qty;
}

async function fetchOrdersSince(sinceIso) {
  const query = `
    query ordersSince($first: Int!, $after: String, $query: String!) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            createdAt
            lineItems(first: 250) {
              edges {
                node {
                  quantity
                  variant { sku }
                }
              }
            }
          }
        }
      }
    }`;

  const allOrders = [];
  let after = null;
  let page = 0;

  do {
    page += 1;
    const data = await shopifyGraph(query, {
      first: 100,
      after,
      query: `created_at:>=${sinceIso}`,
    });

    const connection = data.orders;
    for (const edge of connection.edges) {
      allOrders.push(edge.node);
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 100) throw new Error("Orders pagination safety stop hit after 100 pages.");
  } while (after);

  return allOrders;
}

function buildShortSalesMaps(orders) {
  const now = new Date();

  const sales1d = {};
  const sales7 = {};
  const sales30 = {};

  for (const order of orders) {
    const createdAt = new Date(order.createdAt);
    const ageDays = (now.getTime() - createdAt.getTime()) / 86400000;

    for (const itemEdge of order.lineItems?.edges || []) {
      const item = itemEdge.node;
      const sku = String(item?.variant?.sku || "").trim();
      const qty = Number(item?.quantity || 0);

      if (!sku || !qty) continue;

      if (ageDays <= 30) addQty(sales30, sku, qty);
      if (ageDays <= 7) addQty(sales7, sku, qty);
      if (ageDays <= 1) addQty(sales1d, sku, qty);
    }
  }

  return { sales1d, sales7, sales30 };
}

function salesMapsToRows(maps) {
  const skuSet = new Set([
    ...Object.keys(maps.sales1d || {}),
    ...Object.keys(maps.sales7 || {}),
    ...Object.keys(maps.sales30 || {}),
  ]);

  return Array.from(skuSet)
    .sort((a, b) => a.localeCompare(b))
    .map((sku) => ({
      SKU: sku,
      QtySold_1d: maps.sales1d[sku] || 0,
      QtySold_7d: maps.sales7[sku] || 0,
      QtySold_30d: maps.sales30[sku] || 0,
      QtySold_90d: "",
      QtySold_180d: "",
    }));
}

const SALES_COLUMNS = [
  "SKU",
  "QtySold_1d",
  "QtySold_7d",
  "QtySold_30d",
  "QtySold_90d",
  "QtySold_180d",
];

/* ---------- health ---------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Head Happy Stock Control + Locations",
    shop: SHOP,
    apiVersion: API,
    time: new Date().toISOString(),
  });
});

/* ---------- locations: requires read_locations ---------- */
app.get("/api/locations", async (req, res) => {
  try {
    const locations = await getLocations();
    res.json({ locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Location lookup failed",
      detail: err.message,
      fix: "Add read_locations to the Shopify custom app scopes, reinstall the app, then update SHOPIFY_ACCESS_TOKEN in Render.",
    });
  }
});

/* ---------- live Shopify total stock JSON: read_products fallback ---------- */
app.get("/api/shopify-stock.json", async (req, res) => {
  try {
    const rows = await getVariantStockTotal({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      status: req.query.status || "ACTIVE",
    });
    const filtered = filterStockRows(rows, req.query);
    res.json({
      meta: {
        app: "Head Happy Stock Control + Locations",
        mode: "TOTAL_INVENTORY_QUANTITY",
        shop: SHOP,
        apiVersion: API,
        generatedAt: new Date().toISOString(),
        rowCount: filtered.length,
        filters: req.query,
        note: "This uses variant.inventoryQuantity and does not split by Shopify location.",
      },
      rows: filtered,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stock export failed", detail: err.message });
  }
});

/* ---------- live Shopify total stock CSV: read_products fallback ---------- */
app.get("/api/shopify-stock.csv", async (req, res) => {
  try {
    const rows = await getVariantStockTotal({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      status: req.query.status || "ACTIVE",
    });
    const filtered = filterStockRows(rows, req.query);
    sendCsv(res, "shopify-stock.csv", filtered, STOCK_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stock CSV export failed", detail: err.message });
  }
});

/* ---------- location-level stock JSON: requires read_inventory ---------- */
app.get("/api/shopify-stock-by-location.json", async (req, res) => {
  try {
    const rows = await getVariantStockByLocation({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      locationId: req.query.locationId || "",
      status: req.query.status || "ACTIVE",
    });
    const filtered = filterStockRows(rows, req.query);
    res.json({
      meta: {
        app: "Head Happy Stock Control + Locations",
        mode: "BY_LOCATION",
        shop: SHOP,
        apiVersion: API,
        generatedAt: new Date().toISOString(),
        rowCount: filtered.length,
        filters: req.query,
      },
      rows: filtered,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Location-level stock export failed",
      detail: err.message,
      fix: "Add read_inventory and read_locations to the Shopify custom app scopes, reinstall the app, then update SHOPIFY_ACCESS_TOKEN in Render.",
    });
  }
});

/* ---------- location-level stock CSV: requires read_inventory ---------- */
app.get("/api/shopify-stock-by-location.csv", async (req, res) => {
  try {
    const rows = await getVariantStockByLocation({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      locationId: req.query.locationId || "",
      status: req.query.status || "ACTIVE",
    });
    const filtered = filterStockRows(rows, req.query);
    sendCsv(res, "shopify-stock-by-location.csv", filtered, STOCK_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Location-level stock CSV export failed",
      detail: err.message,
      fix: "Add read_inventory and read_locations to the Shopify custom app scopes, reinstall the app, then update SHOPIFY_ACCESS_TOKEN in Render.",
    });
  }
});

/* ---------- short sales JSON: recent windows only ---------- */
app.get("/api/shopify-sales.json", async (req, res) => {
  try {
    const since30 = isoDaysAgo(30);
    const orders = await fetchOrdersSince(since30);
    const maps = buildShortSalesMaps(orders);
    const rows = salesMapsToRows(maps);

    res.json({
      meta: {
        app: "Head Happy Stock Control + Locations",
        mode: "SHORT_SALES_WINDOWS",
        shop: SHOP,
        apiVersion: API,
        generatedAt: new Date().toISOString(),
        orderCount: orders.length,
        rowCount: rows.length,
        availableWindows: ["1d", "7d", "30d"],
        unavailableWindows: ["90d", "180d"],
        note: "90d and 180d are not returned here yet. Keep using your existing long-range CSVs until read_all_orders is approved or a history cache is added.",
      },
      maps: {
        sales1d: maps.sales1d,
        sales7: maps.sales7,
        sales30: maps.sales30,
        sales90: null,
        sales180: null,
      },
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Sales export failed",
      detail: err.message,
    });
  }
});

/* ---------- short sales CSV: recent windows only ---------- */
app.get("/api/shopify-sales.csv", async (req, res) => {
  try {
    const since30 = isoDaysAgo(30);
    const orders = await fetchOrdersSince(since30);
    const maps = buildShortSalesMaps(orders);
    const rows = salesMapsToRows(maps);

    sendCsv(res, "shopify-sales-short.csv", rows, SALES_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Sales CSV export failed",
      detail: err.message,
    });
  }
});

/* ---------- lookup variant by barcode ---------- */
app.post("/lookup-variant", async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: "Barcode required" });

  try {
    const query = `
      query ($q: String!) {
        productVariants(first: 20, query: $q) {
          edges {
            node {
              id
              title
              barcode
              product { title }
              metafield(namespace: "stock", key: "location") { value }
            }
          }
        }
      }`;
    const data = await shopifyGraph(query, { q: buildVariantSearchQuery({ barcode }) });
    const hits = data.productVariants.edges.map((e) => e.node);

    if (hits.length === 0) return res.status(404).json({ error: "No variant matches" });

    if (hits.length === 1) {
      const v = hits[0];
      return res.json({
        variant: { id: v.id },
        productTitle: v.product.title,
        currentLocation: v.metafield?.value || "",
      });
    }

    res.json({
      variants: hits.map((v) => ({
        id: v.id,
        title: `${v.product.title} – ${v.title}`,
        currentLocation: v.metafield?.value || "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
});

/* ---------- write variant location metafield ---------- */
app.post("/update-location", async (req, res) => {
  const { variantId, locationValue } = req.body;
  if (!variantId || locationValue === undefined) {
    return res.status(400).json({ error: "variantId & locationValue required" });
  }

  try {
    const mut = `
      mutation setLoc($id: ID!, $val: String!) {
        metafieldsSet(metafields: [{
          ownerId: $id,
          namespace: "stock",
          key: "location",
          type: "single_line_text_field",
          value: $val
        }]) { userErrors { field message } }
      }`;
    const r = await shopifyGraph(mut, { id: variantId, val: locationValue });
    if (r.metafieldsSet.userErrors.length) {
      throw new Error(r.metafieldsSet.userErrors[0].message);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Save failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Head Happy Stock Control + Locations listening on http://localhost:${PORT}`);
});

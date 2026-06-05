import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { graphWithDevDashboardAuth } from "./dev-dashboard-auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || "2024-07";

if (!SHOP || !TOKEN) {
  console.error("❌ Set SHOPIFY_SHOP & SHOPIFY_ACCESS_TOKEN in Render env vars.");
  process.exit(1);
}

// Allow the local Head Happy HTML tools to fetch the API from file://, localhost, or Render.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

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
  if (!response.ok) throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`);
  if (payload.errors) throw new Error(JSON.stringify(payload.errors));
  return payload.data;
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function rowsToCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map(row => columns.map(col => csvEscape(row[col])).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}

function sendCsv(res, filename, rows, columns) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + rowsToCsv(rows, columns));
}

function normalise(value) {
  return String(value ?? "").trim().toLowerCase();
}

function availableFromInventoryLevel(levelNode) {
  const available = (levelNode?.quantities || []).find(q => q.name === "available");
  return Number(available?.quantity ?? 0);
}

function buildVariantSearchQuery({ sku, barcode }) {
  const parts = [];
  if (sku) parts.push(`sku:${sku}`);
  if (barcode) parts.push(`barcode:${barcode}`);
  return parts.join(" AND ");
}

function filterStockRows(rows, query) {
  const skuContains = String(query.skuContains || "").trim().toLowerCase();
  const productContains = String(query.productContains || "").trim().toLowerCase();
  const inStockOnly = query.inStockOnly === "1" || query.inStockOnly === "true";
  return rows.filter(row => {
    if (skuContains && !String(row.SKU || "").toLowerCase().includes(skuContains)) return false;
    if (productContains && !String(row.Product || "").toLowerCase().includes(productContains)) return false;
    if (inStockOnly && Number(row.Available || 0) <= 0) return false;
    return true;
  });
}

const STOCK_COLUMNS = [
  "Product", "Variant", "SKU", "Barcode", "Vendor", "Tags", "ProductStatus", "Tracked",
  "Available", "Location", "LocationId", "InventoryItemId", "VariantId", "ProductId", "Price", "Handle",
];

const SALES_COLUMNS = ["SKU", "QtySold_1d", "QtySold_7d", "QtySold_30d", "QtySold_90d", "QtySold_180d"];

async function getLocations() {
  const query = `query locations($first: Int!) { locations(first: $first) { edges { node { id name isActive } } } }`;
  const data = await shopifyGraph(query, { first: 100 });
  return data.locations.edges.map(edge => edge.node);
}

async function getVariantStockTotal({ search = "", tag = "", vendor = "", status = "ACTIVE" } = {}) {
  const query = `
    query variantStockTotal($first: Int!, $after: String, $query: String) {
      productVariants(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title sku barcode price inventoryQuantity
            product { id title handle vendor status tags }
          }
        }
      }
    }`;

  const rows = [];
  let after = null;
  let page = 0;
  do {
    page += 1;
    const data = await shopifyGraph(query, { first: 250, after, query: search || null });
    const connection = data.productVariants;
    for (const edge of connection.edges) {
      const variant = edge.node;
      const product = variant.product || {};
      const tags = Array.isArray(product.tags) ? product.tags : [];
      if (status && status !== "ALL" && product.status !== status) continue;
      if (tag && !tags.some(t => normalise(t) === normalise(tag))) continue;
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
        Available: Number(variant.inventoryQuantity ?? 0),
        Location: "TOTAL",
        LocationId: "",
        InventoryItemId: "",
        VariantId: variant.id || "",
        ProductId: product.id || "",
        Price: variant.price || "",
        Handle: product.handle || "",
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 200) throw new Error("Variant pagination safety stop hit after 200 pages.");
  } while (after);
  return rows;
}

async function getVariantStockByLocation({ search = "", tag = "", vendor = "", locationId = "", status = "ACTIVE" } = {}) {
  const query = `
    query variantStockByLocation($first: Int!, $after: String, $query: String) {
      productVariants(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title sku barcode price inventoryQuantity
            product { id title handle vendor status tags }
            inventoryItem {
              id tracked
              inventoryLevels(first: 50) {
                edges { node { id quantities(names: ["available"]) { name quantity } location { id name } } }
              }
            }
          }
        }
      }
    }`;

  const rows = [];
  let after = null;
  let page = 0;
  do {
    page += 1;
    const data = await shopifyGraph(query, { first: 250, after, query: search || null });
    const connection = data.productVariants;
    for (const edge of connection.edges) {
      const variant = edge.node;
      const product = variant.product || {};
      const tags = Array.isArray(product.tags) ? product.tags : [];
      if (status && status !== "ALL" && product.status !== status) continue;
      if (tag && !tags.some(t => normalise(t) === normalise(tag))) continue;
      if (vendor && normalise(product.vendor) !== normalise(vendor)) continue;
      for (const levelEdge of variant.inventoryItem?.inventoryLevels?.edges || []) {
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
          Available: availableFromInventoryLevel(level),
          Location: loc.name || "",
          LocationId: loc.id || "",
          InventoryItemId: variant.inventoryItem?.id || "",
          VariantId: variant.id || "",
          ProductId: product.id || "",
          Price: variant.price || "",
          Handle: product.handle || "",
        });
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 200) throw new Error("Variant location pagination safety stop hit after 200 pages.");
  } while (after);
  return rows;
}

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

async function fetchOrdersSince(sinceIso) {
  const query = `
    query ordersSince($first: Int!, $after: String, $query: String!) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id createdAt
            lineItems(first: 250) { edges { node { quantity variant { sku } } } }
          }
        }
      }
    }`;

  const allOrders = [];
  let after = null;
  let page = 0;
  do {
    page += 1;
    const data = await graphWithDevDashboardAuth(API, query, {
      first: 100,
      after,
      query: `created_at:>=${sinceIso}`,
    });
    const connection = data.orders;
    for (const edge of connection.edges) allOrders.push(edge.node);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (page > 200) throw new Error("Orders pagination safety stop hit after 200 pages.");
  } while (after);
  return allOrders;
}

function addQty(map, sku, qty) {
  if (!sku) return;
  map[sku] = (map[sku] || 0) + qty;
}

function buildShortSalesMaps(orders) {
  const now = new Date();
  const sales1d = {};
  const sales7 = {};
  const sales30 = {};
  for (const order of orders) {
    const ageDays = (now.getTime() - new Date(order.createdAt).getTime()) / 86400000;
    for (const edge of order.lineItems?.edges || []) {
      const sku = String(edge.node?.variant?.sku || "").trim();
      const qty = Number(edge.node?.quantity || 0);
      if (!sku || !qty) continue;
      if (ageDays <= 30) addQty(sales30, sku, qty);
      if (ageDays <= 7) addQty(sales7, sku, qty);
      if (ageDays <= 1) addQty(sales1d, sku, qty);
    }
  }
  return { sales1d, sales7, sales30 };
}

function salesMapsToRows(maps) {
  const skuSet = new Set([...Object.keys(maps.sales1d), ...Object.keys(maps.sales7), ...Object.keys(maps.sales30)]);
  return Array.from(skuSet).sort((a, b) => a.localeCompare(b)).map(sku => ({
    SKU: sku,
    QtySold_1d: maps.sales1d[sku] || 0,
    QtySold_7d: maps.sales7[sku] || 0,
    QtySold_30d: maps.sales30[sku] || 0,
    QtySold_90d: "",
    QtySold_180d: "",
  }));
}

function salesErrorPayload(err) {
  const detail = err?.message || String(err);
  const payload = { error: "Sales export failed", detail };
  if (detail.includes("ACCESS_DENIED") || detail.includes("Access denied for orders field")) {
    payload.fix = "The Head Happy Sales Sync app needs read_orders approved on the installed store, or the token source still lacks that scope.";
  }
  return payload;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Head Happy Stock Control + Locations",
    shop: SHOP,
    apiVersion: API,
    cors: true,
    time: new Date().toISOString(),
  });
});

app.get("/api/locations", async (req, res) => {
  try {
    res.json({ locations: await getLocations() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Location lookup failed", detail: err.message });
  }
});

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
      meta: { app: "Head Happy Stock Control + Locations", mode: "TOTAL_INVENTORY_QUANTITY", shop: SHOP, apiVersion: API, generatedAt: new Date().toISOString(), rowCount: filtered.length, filters: req.query },
      rows: filtered,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stock export failed", detail: err.message });
  }
});

app.get("/api/shopify-stock.csv", async (req, res) => {
  try {
    const rows = await getVariantStockTotal({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      status: req.query.status || "ACTIVE",
    });
    sendCsv(res, "shopify-stock.csv", filterStockRows(rows, req.query), STOCK_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stock CSV export failed", detail: err.message });
  }
});

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
    res.json({ meta: { app: "Head Happy Stock Control + Locations", mode: "BY_LOCATION", shop: SHOP, apiVersion: API, generatedAt: new Date().toISOString(), rowCount: filtered.length, filters: req.query }, rows: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Location-level stock export failed", detail: err.message });
  }
});

app.get("/api/shopify-stock-by-location.csv", async (req, res) => {
  try {
    const rows = await getVariantStockByLocation({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      locationId: req.query.locationId || "",
      status: req.query.status || "ACTIVE",
    });
    sendCsv(res, "shopify-stock-by-location.csv", filterStockRows(rows, req.query), STOCK_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Location-level stock CSV export failed", detail: err.message });
  }
});

app.get("/api/shopify-sales.json", async (req, res) => {
  try {
    const orders = await fetchOrdersSince(isoDaysAgo(30));
    const maps = buildShortSalesMaps(orders);
    const rows = salesMapsToRows(maps);
    res.json({
      meta: { app: "Head Happy Stock Control + Locations", mode: "SHORT_SALES_WINDOWS", shop: SHOP, apiVersion: API, generatedAt: new Date().toISOString(), orderCount: orders.length, rowCount: rows.length, availableWindows: ["1d", "7d", "30d"], unavailableWindows: ["90d", "180d"], note: "90d and 180d are not returned here yet. Upload 90/180 manually for now." },
      maps: { sales1d: maps.sales1d, sales7: maps.sales7, sales30: maps.sales30, sales90: null, sales180: null },
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.get("/api/shopify-sales.csv", async (req, res) => {
  try {
    const orders = await fetchOrdersSince(isoDaysAgo(30));
    const rows = salesMapsToRows(buildShortSalesMaps(orders));
    sendCsv(res, "shopify-sales-short.csv", rows, SALES_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.post("/lookup-variant", async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: "Barcode required" });
  try {
    const query = `
      query ($q: String!) {
        productVariants(first: 20, query: $q) {
          edges { node { id title barcode product { title } metafield(namespace: "stock", key: "location") { value } } }
        }
      }`;
    const data = await shopifyGraph(query, { q: buildVariantSearchQuery({ barcode }) });
    const hits = data.productVariants.edges.map(e => e.node);
    if (!hits.length) return res.status(404).json({ error: "No variant matches" });
    if (hits.length === 1) {
      const v = hits[0];
      return res.json({ variant: { id: v.id }, productTitle: v.product.title, currentLocation: v.metafield?.value || "" });
    }
    res.json({ variants: hits.map(v => ({ id: v.id, title: `${v.product.title} – ${v.title}`, currentLocation: v.metafield?.value || "" })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
});

app.post("/update-location", async (req, res) => {
  const { variantId, locationValue } = req.body;
  if (!variantId || locationValue === undefined) return res.status(400).json({ error: "variantId & locationValue required" });
  try {
    const mutation = `
      mutation setLoc($id: ID!, $val: String!) {
        metafieldsSet(metafields: [{ ownerId: $id, namespace: "stock", key: "location", type: "single_line_text_field", value: $val }]) {
          userErrors { field message }
        }
      }`;
    const result = await shopifyGraph(mutation, { id: variantId, val: locationValue });
    if (result.metafieldsSet.userErrors.length) throw new Error(result.metafieldsSet.userErrors[0].message);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Save failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Head Happy Stock Control + Locations listening on http://localhost:${PORT}`);
});

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { graphWithDevDashboardAuth } from "./dev-dashboard-auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOPIFY_SHOP; // legacy/location-token shop domain
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // legacy/location-token access token
const API = process.env.SHOPIFY_API_VERSION || "2024-07";

// ShopifyQL is used for sales velocity because the Orders API can be limited to ~60 days.
// 2025-10+ exposes shopifyqlQuery in Admin GraphQL.
const SHOPIFYQL_API = process.env.SHOPIFYQL_API_VERSION || "2025-10";

if (!SHOP || !TOKEN) {
  console.error("❌ Set SHOPIFY_SHOP & SHOPIFY_ACCESS_TOKEN in Render env vars.");
  process.exit(1);
}

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
const YESTERDAY_SALES_COLUMNS = ["SKU", "Product", "Price", "Sold"];
const YESTERDAY_SALES_RAW_COLUMNS = ["SKU", "Product", "Price", "Sold"];

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

function clampSalesDays(value) {
  const n = Number(value || 180);
  if (!Number.isFinite(n)) return 180;
  return Math.max(1, Math.min(365, Math.round(n)));
}

function addQty(map, sku, qty) {
  if (!sku || !qty) return;
  map[sku] = (map[sku] || 0) + qty;
}

function emptySalesMaps() {
  return { sales1d: {}, sales7: {}, sales30: {}, sales90: {}, sales180: {} };
}

function salesMapsToRows(maps) {
  const skuSet = new Set([
    ...Object.keys(maps.sales1d || {}),
    ...Object.keys(maps.sales7 || {}),
    ...Object.keys(maps.sales30 || {}),
    ...Object.keys(maps.sales90 || {}),
    ...Object.keys(maps.sales180 || {}),
  ]);
  return Array.from(skuSet).sort((a, b) => a.localeCompare(b)).map(sku => ({
    SKU: sku,
    QtySold_1d: maps.sales1d[sku] || 0,
    QtySold_7d: maps.sales7[sku] || 0,
    QtySold_30d: maps.sales30[sku] || 0,
    QtySold_90d: maps.sales90[sku] || 0,
    QtySold_180d: maps.sales180[sku] || 0,
  }));
}

function sumMap(map) {
  return Object.values(map || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function salesErrorPayload(err) {
  const detail = err?.message || String(err);
  const payload = { error: "Sales export failed", detail };
  if (detail.includes("shopifyqlQuery")) {
    payload.fix = "Set SHOPIFYQL_API_VERSION=2025-10 or later, and make sure the Dev Dashboard app has read_reports approved.";
  } else if (detail.includes("ACCESS_DENIED") || detail.includes("Access denied")) {
    payload.fix = "The Dev Dashboard app needs read_reports approved for ShopifyQL sales analytics.";
  }
  return payload;
}

/* ---------- ShopifyQL sales source ---------- */

async function runShopifyQL(shopifyql) {
  const query = `
    query ShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData {
          columns { name dataType displayName }
          rows
        }
        parseErrors
      }
    }`;

  const data = await graphWithDevDashboardAuth(SHOPIFYQL_API, query, { query: shopifyql });
  const result = data?.shopifyqlQuery;
  const parseErrors = result?.parseErrors || [];
  if (Array.isArray(parseErrors) && parseErrors.length) {
    throw new Error(`ShopifyQL parse error: ${JSON.stringify(parseErrors)}`);
  }
  if (!result?.tableData) {
    throw new Error(`ShopifyQL returned no tableData for query: ${shopifyql}`);
  }
  return result.tableData;
}

function rowCell(row, columns, name) {
  if (Array.isArray(row)) {
    const idx = columns.findIndex(col => col.name === name || col.displayName === name);
    return idx >= 0 ? row[idx] : undefined;
  }
  if (row && typeof row === "object") {
    return row[name] ?? row[columns.find(col => col.name === name)?.displayName];
  }
  return undefined;
}

async function fetchShopifyQLSoldMap(days) {
  const limit = 2500;
  let offset = 0;
  let pages = 0;
  let rowsSeen = 0;
  const map = {};
  let stoppedAtZero = false;

  while (true) {
    const shopifyql = [
      "FROM inventory",
      "SHOW inventory_units_sold",
      "GROUP BY product_variant_sku",
      `SINCE -${days}d`,
      "UNTIL today",
      "ORDER BY inventory_units_sold DESC",
      `LIMIT ${limit}`,
      `OFFSET ${offset}`,
    ].join(" ");

    const table = await runShopifyQL(shopifyql);
    const columns = table.columns || [];
    const rows = table.rows || [];
    pages += 1;
    rowsSeen += rows.length;

    let lastQty = 0;
    for (const row of rows) {
      const sku = String(rowCell(row, columns, "product_variant_sku") || "").trim();
      const qty = Number(rowCell(row, columns, "inventory_units_sold") || 0);
      lastQty = qty;
      if (!sku || qty <= 0) continue;
      map[sku] = qty;
    }

    if (rows.length < limit || lastQty <= 0) {
      stoppedAtZero = lastQty <= 0;
      break;
    }

    offset += limit;
    if (pages >= 10) {
      throw new Error(`ShopifyQL pagination safety stop hit for ${days}d sales`);
    }
  }

  return { map, pages, rowsSeen, totalQty: sumMap(map), stoppedAtZero };
}

async function fetchShopifyQLYesterdayNetSales() {
  const limit = 1000;
  let offset = 0;
  let pages = 0;
  let rowsSeen = 0;
  const map = {};
  const rawRows = [];
  const aggregatedBySku = new Map();

  while (true) {
    const shopifyql = [
      "FROM sales",
      "SHOW net_items_sold",
      "WHERE line_type = 'product'",
      "GROUP BY product_title, product_variant_sku, product_variant_price WITH TOTALS",
      "SINCE yesterday",
      "UNTIL yesterday",
      "ORDER BY product_variant_sku ASC",
      `LIMIT ${limit}`,
      `OFFSET ${offset}`,
    ].join(" ");

    const table = await runShopifyQL(shopifyql);
    const columns = table.columns || [];
    const rows = table.rows || [];
    pages += 1;
    rowsSeen += rows.length;

    for (const row of rows) {
      const productTitle = String(rowCell(row, columns, "product_title") || "").trim();
      const sku = String(rowCell(row, columns, "product_variant_sku") || "").trim();
      const price = rowCell(row, columns, "product_variant_price");
      const qty = Number(rowCell(row, columns, "net_items_sold") || 0);

      // WITH TOTALS can produce a summary row without a SKU. Skip it and calculate totals from SKU rows.
      if (!sku || qty <= 0) continue;

      addQty(map, sku, qty);

      const rawRow = {
        SKU: sku,
        Product: productTitle,
        Price: price ?? "",
        Sold: qty,
      };
      rawRows.push(rawRow);

      const existing = aggregatedBySku.get(sku);
      if (!existing) {
        aggregatedBySku.set(sku, { ...rawRow });
      } else {
        existing.Sold += qty;
        if (!existing.Product && productTitle) existing.Product = productTitle;
        if (String(existing.Price) !== String(price ?? "")) existing.Price = "Multiple";
      }
    }

    if (rows.length < limit) break;

    offset += limit;
    if (pages >= 10) {
      throw new Error("ShopifyQL pagination safety stop hit for yesterday net sales");
    }
  }

  const rows = Array.from(aggregatedBySku.values()).sort((a, b) => String(a.SKU).localeCompare(String(b.SKU)));
  rawRows.sort((a, b) => String(a.SKU).localeCompare(String(b.SKU)));

  return {
    meta: {
      app: "Head Happy Stock Control + Locations",
      mode: "SHOPIFYQL_YESTERDAY_NET_SALES",
      source: "shopifyql.sales.net_items_sold",
      shop: SHOP,
      apiVersion: API,
      shopifyqlApiVersion: SHOPIFYQL_API,
      generatedAt: new Date().toISOString(),
      query: "FROM sales SHOW net_items_sold WHERE line_type = 'product' GROUP BY product_title, product_variant_sku, product_variant_price WITH TOTALS SINCE yesterday UNTIL yesterday ORDER BY product_variant_sku ASC",
      window: "SINCE yesterday UNTIL yesterday",
      rowCount: rows.length,
      rawRowCount: rawRows.length,
      totalQty: sumMap(map),
      diagnostics: {
        pages,
        rowsSeen,
      },
      note: "This endpoint is for the daily printout. It matches Shopify Analytics previous-day net item sales, not the rolling inventory_units_sold velocity windows.",
    },
    map,
    rows,
    rawRows,
  };
}

async function buildSalesPayload(days = 180) {
  const requestedDays = clampSalesDays(days);
  const windows = [1, 7, 30];
  if (requestedDays >= 90) windows.push(90);
  if (requestedDays >= 180) windows.push(180);

  const maps = emptySalesMaps();
  const diagnostics = {};

  for (const windowDays of windows) {
    const key = windowDays === 1 ? "sales1d" : `sales${windowDays}`;
    const result = await fetchShopifyQLSoldMap(windowDays);
    maps[key] = result.map;
    diagnostics[key] = {
      days: windowDays,
      skuCount: Object.keys(result.map).length,
      totalQty: result.totalQty,
      pages: result.pages,
      rowsSeen: result.rowsSeen,
      stoppedAtZero: result.stoppedAtZero,
    };
  }

  const rows = salesMapsToRows(maps);
  const availableWindows = windows.map(w => (w === 1 ? "1d" : `${w}d`));

  return {
    meta: {
      app: "Head Happy Stock Control + Locations",
      mode: requestedDays >= 180 ? "SHOPIFYQL_LONG_SALES_WINDOWS" : "SHOPIFYQL_SALES_WINDOWS",
      source: "shopifyql.inventory.inventory_units_sold",
      shop: SHOP,
      apiVersion: API,
      shopifyqlApiVersion: SHOPIFYQL_API,
      generatedAt: new Date().toISOString(),
      requestedDays,
      rowCount: rows.length,
      availableWindows,
      unavailableWindows: ["90d", "180d"].filter(w => !availableWindows.includes(w)),
      totals: {
        QtySold_1d: sumMap(maps.sales1d),
        QtySold_7d: sumMap(maps.sales7),
        QtySold_30d: sumMap(maps.sales30),
        QtySold_90d: sumMap(maps.sales90),
        QtySold_180d: sumMap(maps.sales180),
      },
      diagnostics,
      note: "Sales generated from ShopifyQL inventory_units_sold by SKU. This avoids the Orders API 60-day order-history clamp. Use /api/shopify-yesterday-sales.json for exact previous calendar-day net items sold.",
    },
    maps,
    rows,
  };
}

/* ---------- routes ---------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Head Happy Stock Control + Locations",
    shop: SHOP,
    apiVersion: API,
    shopifyqlApiVersion: SHOPIFYQL_API,
    salesSource: "shopifyql.inventory.inventory_units_sold",
    yesterdaySalesEndpoint: "/api/shopify-yesterday-sales.json",
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
    res.json(await buildSalesPayload(req.query.days || 180));
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.get("/api/shopify-sales.csv", async (req, res) => {
  try {
    const payload = await buildSalesPayload(req.query.days || 180);
    sendCsv(res, `shopify-sales-${payload.meta.requestedDays}d.csv`, payload.rows, SALES_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.get("/api/shopify-yesterday-sales.json", async (req, res) => {
  try {
    res.json(await fetchShopifyQLYesterdayNetSales());
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.get("/api/shopify-yesterday-sales.csv", async (req, res) => {
  try {
    const payload = await fetchShopifyQLYesterdayNetSales();
    sendCsv(res, "shopify-yesterday-sales.csv", payload.rows, YESTERDAY_SALES_COLUMNS);
  } catch (err) {
    console.error(err);
    res.status(500).json(salesErrorPayload(err));
  }
});

app.get("/api/shopify-yesterday-sales-raw.csv", async (req, res) => {
  try {
    const payload = await fetchShopifyQLYesterdayNetSales();
    sendCsv(res, "shopify-yesterday-sales-raw.csv", payload.rawRows, YESTERDAY_SALES_RAW_COLUMNS);
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

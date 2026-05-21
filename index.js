/* ----------  index.js  ---------- */
/*  Head Happy Stock Control + Locations – Express backend
    Existing location tool:
    1. POST /lookup-variant   – finds variant(s) by barcode
    2. POST /update-location  – writes stock.location metafield

    Stock-control additions:
    3. GET  /health
    4. GET  /api/locations
    5. GET  /api/shopify-stock.json
    6. GET  /api/shopify-stock.csv

    These stock endpoints are read-only. They are intended to replace the
    manual Stocky low-stock export as the live Shopify stock feed for Restocky.
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
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await r.json();
  if (!r.ok) {
    throw new Error(`Shopify HTTP ${r.status}: ${JSON.stringify(payload)}`);
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
  const body = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
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

async function getLocations() {
  const query = `
    query locations($first: Int!) {
      locations(first: $first) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }`;
  const data = await shopifyGraph(query, { first: 100 });
  return data.locations.edges.map((edge) => edge.node);
}

async function getAllVariantStock({ search = "", tag = "", vendor = "", locationId = "", status = "ACTIVE" } = {}) {
  const query = `
    query variantStock($first: Int!, $after: String, $query: String) {
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
      const levels = inventoryLevels.length
        ? inventoryLevels.map((levelEdge) => levelEdge.node)
        : [{ location: { id: "", name: "" }, quantities: [{ name: "available", quantity: variant.inventoryQuantity ?? 0 }] }];

      for (const level of levels) {
        const loc = level.location || {};
        if (locationId && loc.id !== locationId) continue;

        const available = availableFromInventoryLevel(level);
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
          Available: available,
          Price: variant.price || "",
          Handle: product.handle || "",
        });
      }
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;

    // Basic protection against accidental runaway requests.
    if (page > 100) throw new Error("Pagination safety stop hit after 100 pages.");
  } while (after);

  return rows;
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

/* ---------- locations ---------- */
app.get("/api/locations", async (req, res) => {
  try {
    const locations = await getLocations();
    res.json({ locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Location lookup failed", detail: err.message });
  }
});

/* ---------- live Shopify stock JSON ---------- */
app.get("/api/shopify-stock.json", async (req, res) => {
  try {
    const rows = await getAllVariantStock({
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
    res.status(500).json({ error: "Stock export failed", detail: err.message });
  }
});

/* ---------- live Shopify stock CSV ---------- */
app.get("/api/shopify-stock.csv", async (req, res) => {
  try {
    const rows = await getAllVariantStock({
      search: req.query.search || "",
      tag: req.query.tag || "",
      vendor: req.query.vendor || "",
      locationId: req.query.locationId || "",
      status: req.query.status || "ACTIVE",
    });
    const filtered = filterStockRows(rows, req.query);
    const csv = rowsToCsv(filtered, STOCK_COLUMNS);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="shopify-stock.csv"');
    res.send("\uFEFF" + csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stock CSV export failed", detail: err.message });
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

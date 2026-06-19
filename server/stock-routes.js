import { normalise, sendCsv } from "./shopify-client.js";

const STOCK_COLUMNS = [
  "Product", "Variant", "SKU", "Barcode", "Vendor", "Tags", "ProductStatus", "Tracked",
  "Available", "DisplayLocation", "ShelfLocation", "LOC2", "Location", "LocationId",
  "InventoryItemId", "VariantId", "ProductId", "Price", "Handle",
];

function availableFromLevel(level) {
  return Number((level?.quantities || []).find(q => q.name === "available")?.quantity ?? 0);
}

function filterRows(rows, query) {
  const sku = normalise(query.skuContains);
  const product = normalise(query.productContains);
  const inStockOnly = query.inStockOnly === "1" || query.inStockOnly === "true";
  return rows.filter(row => {
    if (sku && !normalise(row.SKU).includes(sku)) return false;
    if (product && !normalise(row.Product).includes(product)) return false;
    if (inStockOnly && Number(row.Available || 0) <= 0) return false;
    return true;
  });
}

function baseRow(variant, product) {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  return {
    Product: product.title || "",
    Variant: variant.title === "Default Title" ? "" : variant.title || "",
    SKU: variant.sku || "",
    Barcode: variant.barcode || "",
    Vendor: product.vendor || "",
    Tags: tags.join("|"),
    ProductStatus: product.status || "",
    DisplayLocation: product.displayLocMetafield?.value || "",
    ShelfLocation: variant.locationMetafield?.value || "",
    LOC2: product.loc2Metafield?.value || "",
    VariantId: variant.id || "",
    ProductId: product.id || "",
    Price: variant.price || "",
    Handle: product.handle || "",
  };
}

async function stockRows(shopifyGraph, options = {}, byLocation = false) {
  const query = `
    query StockRows($first: Int!, $after: String, $query: String) {
      productVariants(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title sku barcode price inventoryQuantity
          locationMetafield: metafield(namespace: "stock", key: "location") { value }
          product {
            id title handle vendor status tags
            displayLocMetafield: metafield(namespace: "custom", key: "display_loc") { value }
            loc2Metafield: metafield(namespace: "custom", key: "location") { value }
          }
          inventoryItem {
            id tracked
            inventoryLevels(first: 50) {
              nodes { id quantities(names: ["available"]) { name quantity } location { id name } }
            }
          }
        }
      }
    }`;

  const rows = [];
  let after = null;
  let pages = 0;
  do {
    pages += 1;
    const data = await shopifyGraph(query, { first: 250, after, query: options.search || null });
    const connection = data.productVariants;
    for (const variant of connection.nodes || []) {
      const product = variant.product || {};
      const tags = Array.isArray(product.tags) ? product.tags : [];
      if (options.status && options.status !== "ALL" && product.status !== options.status) continue;
      if (options.tag && !tags.some(tag => normalise(tag) === normalise(options.tag))) continue;
      if (options.vendor && normalise(product.vendor) !== normalise(options.vendor)) continue;
      const common = baseRow(variant, product);

      if (!byLocation) {
        rows.push({ ...common, Tracked: "", Available: Number(variant.inventoryQuantity ?? 0), Location: "TOTAL", LocationId: "", InventoryItemId: variant.inventoryItem?.id || "" });
        continue;
      }
      for (const level of variant.inventoryItem?.inventoryLevels?.nodes || []) {
        if (options.locationId && level.location?.id !== options.locationId) continue;
        rows.push({ ...common, Tracked: variant.inventoryItem?.tracked ? "TRUE" : "FALSE", Available: availableFromLevel(level), Location: level.location?.name || "", LocationId: level.location?.id || "", InventoryItemId: variant.inventoryItem?.id || "" });
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (pages > 200) throw new Error("Stock pagination safety stop hit");
  } while (after);
  return rows;
}

export function registerStockRoutes(app, { shopifyGraph, shop, apiVersion }) {
  app.get("/api/locations", async (_req, res) => {
    try {
      const data = await shopifyGraph(`query { locations(first: 100) { nodes { id name isActive } } }`);
      res.json({ locations: data.locations.nodes || [] });
    } catch (error) { res.status(500).json({ error: "Location lookup failed", detail: error.message }); }
  });

  for (const format of ["json", "csv"]) {
    app.get(`/api/shopify-stock.${format}`, async (req, res) => {
      try {
        const rows = filterRows(await stockRows(shopifyGraph, { search:req.query.search || "", tag:req.query.tag || "", vendor:req.query.vendor || "", status:req.query.status || "ACTIVE" }), req.query);
        if (format === "csv") return sendCsv(res, "shopify-stock.csv", rows, STOCK_COLUMNS);
        res.json({ meta:{ app:"Head Happy Stock Control + Locations", mode:"TOTAL_INVENTORY_QUANTITY", shop, apiVersion, generatedAt:new Date().toISOString(), rowCount:rows.length, filters:req.query }, rows });
      } catch (error) { res.status(500).json({ error:"Stock export failed", detail:error.message }); }
    });

    app.get(`/api/shopify-stock-by-location.${format}`, async (req, res) => {
      try {
        const rows = filterRows(await stockRows(shopifyGraph, { search:req.query.search || "", tag:req.query.tag || "", vendor:req.query.vendor || "", locationId:req.query.locationId || "", status:req.query.status || "ACTIVE" }, true), req.query);
        if (format === "csv") return sendCsv(res, "shopify-stock-by-location.csv", rows, STOCK_COLUMNS);
        res.json({ meta:{ app:"Head Happy Stock Control + Locations", mode:"BY_LOCATION", shop, apiVersion, generatedAt:new Date().toISOString(), rowCount:rows.length, filters:req.query }, rows });
      } catch (error) { res.status(500).json({ error:"Location-level stock export failed", detail:error.message }); }
    });
  }
}

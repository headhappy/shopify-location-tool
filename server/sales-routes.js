import { graphWithDevDashboardAuth } from "../dev-dashboard-auth.js";
import { sendCsv } from "./shopify-client.js";

const SALES_COLUMNS = ["SKU", "QtySold_1d", "QtySold_7d", "QtySold_30d", "QtySold_90d", "QtySold_180d"];
const YESTERDAY_COLUMNS = ["SKU", "Product", "Price", "Sold"];

function rowCell(row, columns, name) {
  if (Array.isArray(row)) {
    const index = columns.findIndex(col => col.name === name || col.displayName === name);
    return index >= 0 ? row[index] : undefined;
  }
  if (row && typeof row === "object") return row[name] ?? row[columns.find(col => col.name === name)?.displayName];
  return undefined;
}

function sumMap(map) {
  return Object.values(map || {}).reduce((total, value) => total + Number(value || 0), 0);
}

async function runShopifyQL(apiVersion, queryText) {
  const query = `
    query ShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData { columns { name dataType displayName } rows }
        parseErrors
      }
    }`;
  const data = await graphWithDevDashboardAuth(apiVersion, query, { query: queryText });
  const result = data?.shopifyqlQuery;
  if (result?.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${JSON.stringify(result.parseErrors)}`);
  if (!result?.tableData) throw new Error(`ShopifyQL returned no tableData for query: ${queryText}`);
  return result.tableData;
}

async function soldMap(apiVersion, days) {
  const limit = 2500;
  let offset = 0;
  let pages = 0;
  let rowsSeen = 0;
  let stoppedAtZero = false;
  const map = {};
  while (true) {
    const q = ["FROM inventory", "SHOW inventory_units_sold", "GROUP BY product_variant_sku", `SINCE -${days}d`, "UNTIL today", "ORDER BY inventory_units_sold DESC", `LIMIT ${limit}`, `OFFSET ${offset}`].join(" ");
    const table = await runShopifyQL(apiVersion, q);
    const rows = table.rows || [];
    const columns = table.columns || [];
    pages += 1;
    rowsSeen += rows.length;
    let lastQty = 0;
    for (const row of rows) {
      const sku = String(rowCell(row, columns, "product_variant_sku") || "").trim();
      const qty = Number(rowCell(row, columns, "inventory_units_sold") || 0);
      lastQty = qty;
      if (sku && qty > 0) map[sku] = qty;
    }
    if (rows.length < limit || lastQty <= 0) { stoppedAtZero = lastQty <= 0; break; }
    offset += limit;
    if (pages >= 10) throw new Error(`ShopifyQL pagination safety stop hit for ${days}d sales`);
  }
  return { map, pages, rowsSeen, totalQty:sumMap(map), stoppedAtZero };
}

async function yesterdaySales(apiVersion, meta) {
  const limit = 1000;
  let offset = 0;
  let pages = 0;
  let rowsSeen = 0;
  const rawRows = [];
  const aggregate = new Map();
  while (true) {
    const q = ["FROM sales", "SHOW net_items_sold", "WHERE line_type = 'product'", "GROUP BY product_title, product_variant_sku, product_variant_price WITH TOTALS", "SINCE yesterday", "UNTIL yesterday", "ORDER BY product_variant_sku ASC", `LIMIT ${limit}`, `OFFSET ${offset}`].join(" ");
    const table = await runShopifyQL(apiVersion, q);
    const rows = table.rows || [];
    const columns = table.columns || [];
    pages += 1;
    rowsSeen += rows.length;
    for (const row of rows) {
      const product = String(rowCell(row, columns, "product_title") || "").trim();
      const sku = String(rowCell(row, columns, "product_variant_sku") || "").trim();
      const price = rowCell(row, columns, "product_variant_price") ?? "";
      const sold = Number(rowCell(row, columns, "net_items_sold") || 0);
      if (!sku || sold <= 0) continue;
      const item = { SKU:sku, Product:product, Price:price, Sold:sold };
      rawRows.push(item);
      const existing = aggregate.get(sku);
      if (!existing) aggregate.set(sku, { ...item });
      else {
        existing.Sold += sold;
        if (!existing.Product && product) existing.Product = product;
        if (String(existing.Price) !== String(price)) existing.Price = "Multiple";
      }
    }
    if (rows.length < limit) break;
    offset += limit;
    if (pages >= 10) throw new Error("ShopifyQL pagination safety stop hit for yesterday sales");
  }
  const rows = [...aggregate.values()].sort((a,b) => a.SKU.localeCompare(b.SKU));
  rawRows.sort((a,b) => a.SKU.localeCompare(b.SKU));
  return {
    meta:{ ...meta, mode:"SHOPIFYQL_YESTERDAY_NET_SALES", source:"shopifyql.sales.net_items_sold", generatedAt:new Date().toISOString(), window:"SINCE yesterday UNTIL yesterday", rowCount:rows.length, rawRowCount:rawRows.length, totalQty:rows.reduce((n,r)=>n+r.Sold,0), diagnostics:{pages,rowsSeen} },
    rows,
    rawRows,
    map:Object.fromEntries(rows.map(row => [row.SKU,row.Sold])),
  };
}

function clampDays(value) {
  const n = Number(value || 180);
  return Number.isFinite(n) ? Math.max(1, Math.min(365, Math.round(n))) : 180;
}

async function salesWindows(apiVersion, meta, requested) {
  const days = clampDays(requested);
  const windows = [1,7,30];
  if (days >= 90) windows.push(90);
  if (days >= 180) windows.push(180);
  const maps = { sales1d:{}, sales7:{}, sales30:{}, sales90:{}, sales180:{} };
  const diagnostics = {};
  for (const window of windows) {
    const key = window === 1 ? "sales1d" : `sales${window}`;
    const result = await soldMap(apiVersion, window);
    maps[key] = result.map;
    diagnostics[key] = { days:window, skuCount:Object.keys(result.map).length, totalQty:result.totalQty, pages:result.pages, rowsSeen:result.rowsSeen, stoppedAtZero:result.stoppedAtZero };
  }
  const skus = new Set(Object.values(maps).flatMap(map => Object.keys(map)));
  const rows = [...skus].sort().map(SKU => ({ SKU, QtySold_1d:maps.sales1d[SKU]||0, QtySold_7d:maps.sales7[SKU]||0, QtySold_30d:maps.sales30[SKU]||0, QtySold_90d:maps.sales90[SKU]||0, QtySold_180d:maps.sales180[SKU]||0 }));
  return { meta:{ ...meta, mode:days>=180?"SHOPIFYQL_LONG_SALES_WINDOWS":"SHOPIFYQL_SALES_WINDOWS", source:"shopifyql.inventory.inventory_units_sold", generatedAt:new Date().toISOString(), requestedDays:days, rowCount:rows.length, availableWindows:windows.map(w=>`${w}d`), totals:{ QtySold_1d:sumMap(maps.sales1d), QtySold_7d:sumMap(maps.sales7), QtySold_30d:sumMap(maps.sales30), QtySold_90d:sumMap(maps.sales90), QtySold_180d:sumMap(maps.sales180) }, diagnostics }, maps, rows };
}

function errorPayload(error) {
  return { error:"Sales export failed", detail:error?.message || String(error) };
}

export function registerSalesRoutes(app, { shop, apiVersion, shopifyqlApiVersion }) {
  const meta = { app:"Head Happy Stock Control + Locations", shop, apiVersion, shopifyqlApiVersion };
  app.get("/api/shopify-sales.json", async (req,res) => { try { res.json(await salesWindows(shopifyqlApiVersion,meta,req.query.days)); } catch(error) { res.status(500).json(errorPayload(error)); } });
  app.get("/api/shopify-sales.csv", async (req,res) => { try { const payload=await salesWindows(shopifyqlApiVersion,meta,req.query.days); sendCsv(res,`shopify-sales-${payload.meta.requestedDays}d.csv`,payload.rows,SALES_COLUMNS); } catch(error) { res.status(500).json(errorPayload(error)); } });
  app.get("/api/shopify-yesterday-sales.json", async (_req,res) => { try { res.json(await yesterdaySales(shopifyqlApiVersion,meta)); } catch(error) { res.status(500).json(errorPayload(error)); } });
  app.get("/api/shopify-yesterday-sales.csv", async (_req,res) => { try { const payload=await yesterdaySales(shopifyqlApiVersion,meta); sendCsv(res,"shopify-yesterday-sales.csv",payload.rows,YESTERDAY_COLUMNS); } catch(error) { res.status(500).json(errorPayload(error)); } });
  app.get("/api/shopify-yesterday-sales-raw.csv", async (_req,res) => { try { const payload=await yesterdaySales(shopifyqlApiVersion,meta); sendCsv(res,"shopify-yesterday-sales-raw.csv",payload.rawRows,YESTERDAY_COLUMNS); } catch(error) { res.status(500).json(errorPayload(error)); } });
}

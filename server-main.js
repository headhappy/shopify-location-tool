import express from "express";
import dotenv from "dotenv";
import { createShopifyGraph } from "./server/shopify-client.js";
import { registerStockRoutes } from "./server/stock-routes.js";
import { registerSalesRoutes } from "./server/sales-routes.js";
import { registerLocationUpdaterRoutes } from "./server/location-updater-routes.js";

dotenv.config();

const app=express();
const PORT=process.env.PORT || 3000;
const SHOP=process.env.SHOPIFY_SHOP;
const TOKEN=process.env.SHOPIFY_ACCESS_TOKEN;
const API=process.env.SHOPIFY_API_VERSION || "2024-07";
const SHOPIFYQL_API=process.env.SHOPIFYQL_API_VERSION || "2025-10";

if(!SHOP || !TOKEN){
  console.error("❌ Set SHOPIFY_SHOP & SHOPIFY_ACCESS_TOKEN in Render env vars.");
  process.exit(1);
}

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, X-Requested-With");
  res.setHeader("Access-Control-Max-Age","86400");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit:"20mb" }));
app.use("/vendor/bwip-js",express.static("node_modules/bwip-js/dist"));
app.use(express.static("public"));

const shopifyGraph=createShopifyGraph({ shop:SHOP,token:TOKEN,apiVersion:API });
registerStockRoutes(app,{ shopifyGraph,shop:SHOP,apiVersion:API });
registerSalesRoutes(app,{ shop:SHOP,apiVersion:API,shopifyqlApiVersion:SHOPIFYQL_API });
registerLocationUpdaterRoutes(app,{ shopifyGraph });

app.get("/health",(_req,res)=>res.json({
  ok:true,
  app:"Head Happy Stock Control + Locations",
  shop:SHOP,
  apiVersion:API,
  shopifyqlApiVersion:SHOPIFYQL_API,
  salesSource:"shopifyql.inventory.inventory_units_sold",
  yesterdaySalesEndpoint:"/api/shopify-yesterday-sales.json",
  stockLocationFields:{
    variantDisplayLocation:"DisplayLocation from variant metafield custom.display_loc",
    variantQuickStockLocation:"ShelfLocation from variant metafield stock.location",
    variantStockroomLocation:"LOC2 from variant metafield custom.location"
  },
  updaterFeatures:{
    search:"Barcode, SKU, or product-title contains search",
    displayLocation:"Variant metafield custom.display_loc",
    location:"Variant metafield stock.location",
    loc2:"Variant metafield custom.location",
    displayLocationEndpoint:"/update-display-location",
    locationEndpoint:"/update-location",
    loc2Endpoint:"/update-loc2",
    lod:"Stored in Display LOC as LOCATION (LOD), or LOD if no position is known",
    blankProtection:"Existing values require explicit Clear confirmation"
  },
  labelStation:{
    page:"/label-station.html",
    paper:"40x25mm",
    barcode:"Code 128",
    locationListEndpoint:"/api/labels/locations"
  },
  cors:true,
  time:new Date().toISOString()
}));

app.listen(PORT,()=>console.log(`🚀 Head Happy Stock Control + Locations listening on http://localhost:${PORT}`));

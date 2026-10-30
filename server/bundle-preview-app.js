import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

// A test deployment of the existing module, with no legacy write routes mounted.
export function createBundlePreviewApp({ router, posRouter, posEnabled = false, ready, commit = null }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });
  app.use("/api/bundles", router);
  if (posRouter) app.use('/api/pos-deals',posRouter);
  app.get('/pos-app',(_req,res) => {
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors https://admin.shopify.com https://headhappyhemp.myshopify.com");
    res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Head Happy deals</title><style>body{font:18px system-ui;max-width:640px;margin:40px auto;padding:20px;line-height:1.6}a{color:#007f5f}</style><h1>Build a deal</h1><p>On your till, open the <b>Shopify POS app</b>.</p><ol><li>Tap <b>Build a deal</b>. To add the tile: Add tile → App → Head Happy POS Deals.</li><li>Choose or scan the box and grinder colours.</li><li>Check the complete set, including the papers, then confirm to add it at the deal price.</li><li>Return to the basket, check the total and take payment as usual.</li></ol><p>Matching items already scanned are reused. Shopify deducts the actual component stock only when checkout is completed.</p><p>Edit your bundles in the <a href="/bundle-builder.html" target="_blank" rel="noopener">Bundle Builder</a>. You do not need to open Shopify Admin on your phone to sell a deal.</p></html>`);
  });
  app.get("/health", async (_req, res) => {
    try {
      await ready();
      res.json({
        ok: true,
        app: "Head Happy Bundle Builder test",
        inventoryWritesEnabled: false,
        posDealsEnabled: posEnabled,
        commit,
      });
    } catch {
      res.status(503).json({ ok: false, inventoryWritesEnabled: false });
    }
  });
  app.get("/", (_req, res) => res.redirect("/bundle-builder.html"));
  for (const file of [
    "bundle-builder.html",
    "bundle-builder.js",
    "bundle-builder.css",
    "assembly-history.html",
    "assembly-history.js",
    "assembly-history.css",
    "deal-tester.html",
    "deal-tester.js",
    "deal-tester.css",
  ]) {
    app.get(`/${file}`, (_req, res) =>
      res.sendFile(path.join(publicDirectory, file), { cacheControl: false }),
    );
  }
  // The existing live tools stay available at their original app URL.
  const liveTools = new Set([
    "/index.html",
    "/label-station.html",
    "/api/shopify-stock.csv",
  ]);
  app.get([...liveTools], (req, res) =>
    res.redirect(`https://shopify-location-tool.onrender.com${req.path}`),
  );
  app.use((_req, res) =>
    res
      .status(404)
      .json({
        error: "This test service only exposes Bundle Builder previews.",
      }),
  );
  return app;
}

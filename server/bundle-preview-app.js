import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

// A test deployment of the existing module, with no legacy write routes mounted.
export function createBundlePreviewApp({ router, ready, commit = null }) {
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
  app.get("/health", async (_req, res) => {
    try {
      await ready();
      res.json({
        ok: true,
        app: "Head Happy Bundle Builder test",
        inventoryWritesEnabled: false,
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

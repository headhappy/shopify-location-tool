import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createBundlePreviewApp } from "../server/bundle-preview-app.js";

test("test deployment exposes only the protected builder and refuses legacy writes", async (t) => {
  const router = express.Router();
  router.use((_req, res) => res.status(401).json({ error: "Sign in" }));
  let databaseReady = true;
  const app = createBundlePreviewApp({
    router,
    ready: async () => {
      if (!databaseReady) throw new Error("database unavailable");
    },
    commit: "test-commit",
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + "/api/bundles/recipes")).status, 401);
  for (const path of [
    "/update-display-loc",
    "/clear-variant-location",
    "/inventoryAdjustQuantities",
    "/api/stock-adjust",
  ])
    assert.equal((await fetch(origin + path, { method: "POST" })).status, 404);
  const page = await fetch(origin + "/bundle-builder.html");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal((await fetch(origin + "/server-main.js")).status, 404);
  const health = await (await fetch(origin + "/health")).json();
  assert.equal(health.inventoryWritesEnabled, false);
  assert.equal(health.commit, "test-commit");
  databaseReady = false;
  assert.equal((await fetch(origin + "/health")).status, 503);
});

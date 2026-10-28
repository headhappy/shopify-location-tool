import pg from "pg";
import { createShopifyGraph } from "./shopify-client.js";
import { createBundleCatalog } from "./bundle-catalog.js";
import { createBundleService } from "./bundle-service.js";
import { createBundleStore } from "./bundle-store.js";
import { createBundleRouter } from "./bundle-routes.js";
import { parseStaff } from "./bundle-auth.js";
import { requireValue } from "./bundle-errors.js";

export function registerBundleModule(app, env = process.env) {
  if (env.BUNDLE_BUILDER_ENABLED !== "true") {
    app.use("/api/bundles", (_req, res) =>
      res.status(503).json({
        error:
          "Bundle Builder is disabled. Complete the setup in docs/bundle-builder.md.",
      }),
    );
    return;
  }
  try {
    const runtime = createBundleRuntime(env);
    app.use("/api/bundles", runtime.router);
    return runtime;
  } catch {
    console.error(
      "Bundle Builder configuration is invalid; its API is disabled. See docs/bundle-builder.md.",
    );
    app.use("/api/bundles", (_req, res) =>
      res
        .status(503)
        .json({
          error:
            "Bundle Builder configuration is incomplete. Ask the administrator to check setup.",
        }),
    );
  }
}

export function createBundleRuntime(env = process.env) {
  requireValue(env.BUNDLE_DATABASE_URL, "BUNDLE_DATABASE_URL is required.");
  requireValue(
    /^[a-zA-Z0-9-]+\.myshopify\.com$/.test(env.SHOPIFY_SHOP || "") &&
      env.SHOPIFY_ACCESS_TOKEN,
    "Shopify credentials are required.",
  );
  const configuredOrigin = env.BUNDLE_APP_ORIGIN || env.RENDER_EXTERNAL_URL;
  const origin = new URL(configuredOrigin);
  const local =
    ["localhost", "127.0.0.1"].includes(origin.hostname) &&
    env.NODE_ENV !== "production";
  requireValue(
    origin.origin === configuredOrigin &&
      (origin.protocol === "https:" || (local && origin.protocol === "http:")),
    "Set BUNDLE_APP_ORIGIN to an exact HTTPS origin (no trailing slash).",
  );
  const users = parseStaff(env.BUNDLE_STAFF_USERS);
  const pool = new pg.Pool({
    connectionString: env.BUNDLE_DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  pool.on("error", () => console.error("Bundle database connection failed."));
  const store = createBundleStore(pool, env.SHOPIFY_SHOP);
  const graph = createShopifyGraph({
    shop: env.SHOPIFY_SHOP,
    token: env.SHOPIFY_ACCESS_TOKEN,
    apiVersion: env.BUNDLE_SHOPIFY_API_VERSION || "2026-10",
  });
  const catalog = createBundleCatalog(graph),
    service = createBundleService({ catalog, store });
  const router = createBundleRouter({
    store,
    catalog,
    service,
    users,
    origin: origin.origin,
    secure: !local,
  });
  return { router, pool, store, catalog, service, close: () => pool.end() };
}

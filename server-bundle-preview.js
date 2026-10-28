import "dotenv/config";
import { createBundleRuntime } from "./server/bundle-module.js";
import { createBundlePreviewApp } from "./server/bundle-preview-app.js";
import { migrateBundles } from "./server/bundle-store.js";

let runtime;
try {
  runtime = createBundleRuntime(process.env);
  // Free test services lack a pre-deploy migration hook. The repeatable migration
  // completes before accepting traffic; no memory/file fallback is possible.
  await migrateBundles(runtime.pool, process.env.SHOPIFY_SHOP);
  await runtime.store.ready();
  const app = createBundlePreviewApp({
    router: runtime.router,
    ready: () => runtime.store.ready(),
    commit: process.env.RENDER_GIT_COMMIT || null,
  });
  const server = app.listen(process.env.PORT || 3000, "0.0.0.0", () =>
    console.log(
      "Bundle Builder test service ready; Shopify inventory writes are disabled.",
    ),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () =>
      server.close(async () => {
        await runtime.close();
        process.exit(0);
      }),
    );
} catch {
  console.error(
    "Bundle Builder test startup failed. Check staff accounts, database connection and Shopify credentials. No inventory changes were made.",
  );
  await runtime?.close();
  process.exitCode = 1;
}

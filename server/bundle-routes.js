import express from "express";
import { BundleError, requireValue } from "./bundle-errors.js";
import { createBundleAuth } from "./bundle-auth.js";
import { variantSummary } from "./bundle-service.js";
import { previewCursor } from "./bundle-store.js";
import { createDealService } from "./deal-service.js";

const safeCell = (value) => {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
};
export function previewsCsv(previews) {
  const columns = [
    "PreviewID",
    "Timestamp",
    "Status",
    "InventoryChanged",
    "RecipeID",
    "RecipeVersion",
    "FinishedSKU",
    "FinishedVariantID",
    "FinishedQuantity",
    "ComponentSKU",
    "ComponentVariantID",
    "InventoryItemID",
    "ComponentQuantity",
    "UnitCost",
    "UnitCostCurrency",
    "ExtendedCost",
    "Currency",
    "Location",
    "LocationID",
    "StaffID",
    "ProposedDelta",
    "AppliedDelta",
    "Blockers",
  ];
  const rows = previews.flatMap((p) =>
    p.components.map((c) => [
      p.id,
      p.createdAt,
      p.status,
      "FALSE",
      p.recipeId,
      p.recipeVersion,
      p.finished.sku,
      p.finished.id,
      p.quantity,
      c.sku,
      c.id,
      c.inventoryItemId,
      c.quantity,
      c.cost?.amount,
      c.cost?.currencyCode,
      c.extendedCost,
      p.currency,
      p.location.name,
      p.location.id,
      p.staff.id,
      c.proposedDelta,
      0,
      p.blockers.join(" | "),
    ]),
  );
  return (
    "\uFEFF" +
    [columns, ...rows]
      .map((row) =>
        row
          .map((value) =>
            typeof value === "number" ? `"${value}"` : safeCell(value),
          )
          .join(","),
      )
      .join("\r\n")
  );
}
export function createBundleRouter({
  store,
  catalog,
  service,
  users,
  origin,
  secure = true,
}) {
  const router = express.Router(),
    auth = createBundleAuth({ store, users, origin, secure });
  const run = (fn) => (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  router.use(express.json({ limit: "64kb" }));
  router.use(
    run(async (_req, _res, next) => {
      await store.ready();
      next();
    }),
  );
  router.post(
    "/login",
    run(async (req, res) => res.json(await auth.login(req, res))),
  );
  router.use(
    run(async (req, _res, next) => {
      await auth.authenticate(req);
      next();
    }),
  );
  router.get("/session", (req, res) =>
    res.json({
      staff: req.staff,
      csrf: req.csrf,
      inventoryWritesEnabled: false,
    }),
  );
  const deals = createDealService({ catalog, store });
  router.get("/deals/:id", run(async (req, res) => {
    res.json(await deals.definition(req.params.id, req.query.locationId, Number(req.query.recipeVersion)));
  }));
  router.post("/deals/:id/test", run(async (req, res) => {
    res.json(await deals.test(req.params.id, req.body));
  }));
  router.post(
    "/logout",
    run(async (req, res) => {
      await auth.logout(req, res);
      res.json({ ok: true });
    }),
  );
  router.get(
    "/catalog",
    run(async (_req, res) =>
      res.json({
        ...(await catalog.metadata()),
        locations: await catalog.locations(),
      }),
    ),
  );
  router.get(
    "/variants",
    run(async (req, res) =>
      res.json({
        variants: (await catalog.lookup(req.query.q, req.query.locationId)).map(
          variantSummary,
        ),
      }),
    ),
  );
  router.post(
    "/variants/resolve",
    run(async (req, res) => {
      requireValue(
        Array.isArray(req.body.ids) && req.body.ids.length <= 100,
        "Provide at most 100 variant IDs.",
      );
      res.json({
        variants: (await catalog.nodes(req.body.ids)).map(variantSummary),
      });
    }),
  );
  router.get(
    "/recipes",
    run(async (_req, res) => res.json({ recipes: await store.listRecipes() })),
  );
  router.get(
    "/recipes/:id/history",
    run(async (req, res) =>
      res.json({ history: await store.recipeHistory(req.params.id) }),
    ),
  );
  const manager = (req) =>
    requireValue(
      req.staff.role === "manager",
      "A manager account is required to edit recipes.",
      403,
    );
  router.get(
    "/templates/crown",
    run(async (req, res) => {
      manager(req);
      res.json({ recipe: await service.crownTemplate() });
    }),
  );
  router.post(
    "/recipes",
    run(async (req, res) => {
      manager(req);
      const recipe = await service.validateForSave(req.body.recipe);
      res
        .status(201)
        .json({ recipe: await store.saveRecipe(recipe, req.staff) });
    }),
  );
  router.put(
    "/recipes/:id",
    run(async (req, res) => {
      manager(req);
      requireValue(
        Number.isSafeInteger(req.body.expectedVersion) &&
          req.body.expectedVersion > 0,
        "Recipe version is required.",
      );
      const previous = await store.recipe(req.params.id);
      requireValue(
        previous.version === req.body.expectedVersion,
        "Recipe changed in another session. Reload it before saving.",
        409,
      );
      const recipe = await service.validateForSave(req.body.recipe, previous);
      res.json({
        recipe: await store.saveRecipe(
          recipe,
          req.staff,
          req.params.id,
          req.body.expectedVersion,
        ),
      });
    }),
  );
  router.post(
    "/recipes/:id/resolve",
    run(async (req, res) => {
      const recipe = await store.recipe(req.params.id);
      requireValue(
        req.body.recipeVersion === recipe.version,
        "Recipe changed. Reload recipes before selecting components.",
        409,
      );
      res.json(
        await service.resolve(
          recipe,
          req.body.finishedVariantId,
          req.body.locationId,
        ),
      );
    }),
  );
  router.post(
    "/recipes/:id/preview",
    run(async (req, res) => {
      const recipe = await store.recipe(req.params.id);
      requireValue(
        req.body.recipeVersion === recipe.version,
        "Recipe changed. Reload the components before previewing.",
        409,
      );
      res.json({ preview: await service.preview(recipe, req.body, req.staff) });
    }),
  );
  router.get(
    "/previews",
    run(async (req, res) => {
      const previews = await store.listPreviews({ cursor: req.query.cursor });
      res.json({
        previews,
        nextCursor:
          previews.length === 100 ? previewCursor(previews.at(-1)) : null,
      });
    }),
  );
  router.get(
    "/previews.csv",
    run(async (req, res) => {
      let rows = await store.listPreviews({
        limit: 1000,
        cursor: req.query.cursor,
      });
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set(
        "Content-Disposition",
        'attachment; filename="head-happy-preview-history.csv"',
      );
      res.write(previewsCsv(rows));
      while (rows.length === 1000 && !res.destroyed) {
        rows = await store.listPreviews({
          limit: 1000,
          cursor: previewCursor(rows.at(-1)),
        });
        if (rows.length)
          res.write(
            "\r\n" + previewsCsv(rows).split("\r\n").slice(1).join("\r\n"),
          );
      }
      res.end();
    }),
  );
  // There is deliberately no transaction executor or inventory-write enable switch.
  router.all(
    ["/assemblies", "/assemblies/*", "/reversals", "/reconcile"],
    (_req, res) =>
      res.status(403).json({
        error: "Inventory changes are not implemented in this preview release.",
      }),
  );
  router.use((_req, res) =>
    res.status(404).json({ error: "Bundle endpoint not found." }),
  );
  router.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status =
      error instanceof BundleError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 503;
    if (status === 429) res.set("Retry-After", "600");
    res.status(status).json({
      error:
        error instanceof BundleError
          ? error.message
          : status === 400
            ? "Invalid JSON request."
            : status === 413
              ? "Request is too large."
              : "Bundle data is unavailable. Check database setup and Shopify read permissions, then retry.",
    });
  });
  return router;
}

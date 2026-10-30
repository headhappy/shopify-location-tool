import { createHash, randomUUID } from "node:crypto";
import { gid, integer, shortText, requireValue } from "./bundle-errors.js";

const ids = (values, name, max = 100) => {
  requireValue(
    Array.isArray(values) && values.length <= max,
    `${name} must be a list of at most ${max} variant IDs.`,
  );
  values.forEach((v) => gid(v, "ProductVariant"));
  requireValue(
    new Set(values).size === values.length,
    `${name} contains duplicate IDs.`,
  );
  return values;
};
export function normalizeComponentRule(input) {
  const type = input?.type;
  requireValue(
    ["exact_sku", "product", "prefix", "group"].includes(type),
    "Choose a valid component rule.",
  );
  const rule = {
    type,
    excludeVariantIds: ids(input.excludeVariantIds || [], "Excluded variants"),
  };
  if (type === "group") {
    rule.variantIds = ids(input.variantIds, "Restricted variants");
    requireValue(
      rule.variantIds.length,
      "A restricted group needs at least one variant.",
    );
  } else {
    rule.value = shortText(input.value, "Rule value", 100);
    if (type === "product") {
      if (/^[1-9][0-9]*$/.test(rule.value))
        rule.value = `gid://shopify/Product/${rule.value}`;
      gid(rule.value, "Product");
    }
    if (type === "prefix") {
      rule.value = rule.value.replace(/\*$/, "");
      requireValue(
        /^[a-zA-Z0-9_-]{2,80}$/.test(rule.value),
        "Use a literal SKU prefix (letters, digits, _ or -), optionally ending in *.",
      );
    }
  }
  return rule;
}
export function normalizeRecipe(input) {
  requireValue(input && typeof input === "object", "Recipe is required.");
  const finishedVariantIds = ids(
    input.finishedVariantIds,
    "Finished variants",
    50,
  );
  requireValue(
    finishedVariantIds.length,
    "Choose at least one finished variant.",
  );
  requireValue(
    ["unconfirmed", "physical", "external"].includes(input.inventoryOwnership),
    "Select who manages the finished stock.",
  );
  requireValue(
    Array.isArray(input.components) &&
      input.components.length > 0 &&
      input.components.length <= 30,
    "Add 1 to 30 component groups.",
  );
  const components = input.components.map((c, index) => {
    requireValue(
      c && typeof c === "object",
      "Each component must be an object.",
    );
    const id = shortText(c.id || `component-${index + 1}`, "Component ID", 60);
    requireValue(
      /^[a-zA-Z0-9_-]+$/.test(id),
      "Component IDs may contain only letters, numbers, hyphens and underscores.",
    );
    const rule = normalizeComponentRule(c.rule);
    const type = rule.type;
    const bindingMode = c.bindingMode || "any";
    requireValue(
      ["any", "by_finished"].includes(bindingMode),
      "Invalid finished-colour matching mode.",
    );
    const bindings = {};
    if (bindingMode === "by_finished") {
      for (const finished of finishedVariantIds) {
        bindings[finished] = gid(c.bindings?.[finished], "ProductVariant");
      }
    }
    return {
      id,
      name: shortText(c.name, "Component name"),
      quantity: integer(c.quantity, "Component quantity", 1000),
      rule,
      bindingMode,
      bindings,
    };
  });
  requireValue(
    new Set(components.map((c) => c.id)).size === components.length,
    "Component IDs must be unique.",
  );
  return {
    name: shortText(input.name, "Recipe name"),
    ...(input.bundleProductId
      ? { bundleProductId: gid(input.bundleProductId, "Product") }
      : {}),
    finishedVariantIds,
    inventoryOwnership: input.inventoryOwnership,
    components,
  };
}

export function variantSummary(v) {
  const item = v.inventoryItem;
  const available = item?.inventoryLevel?.quantities?.find(
    (q) => q.name === "available",
  )?.quantity;
  return {
    id: v.id,
    productId: v.product.id,
    productTitle: v.product.title,
    title: v.title,
    sku: v.sku || "",
    barcode: v.barcode || "",
    price: v.price,
    status: v.product.status,
    requiresComponents: v.requiresComponents,
    inventoryItemId: item?.id || null,
    tracked: Boolean(item?.tracked),
    stocked: Boolean(item?.inventoryLevel),
    available: Number.isSafeInteger(available) ? available : null,
    cost: item?.unitCost || null,
  };
}
// Four decimal places preserve Shopify unit costs. Do not convert a missing cost into zero.
function costUnits(amount) {
  if (typeof amount !== "string" || !/^\d+(\.\d{1,4})?$/.test(amount))
    return null;
  const [whole, fraction = ""] = amount.split(".");
  const value = Number(whole) * 10000 + Number(fraction.padEnd(4, "0"));
  return Number.isSafeInteger(value) ? value : null;
}
const decimal = (value) => (value / 10000).toFixed(4);

export function createBundleService({ catalog, store }) {
  async function validateForSave(input, previous = null) {
    const recipe = normalizeRecipe(input);
    const finished = await catalog.nodes(recipe.finishedVariantIds);
    requireValue(
      finished.length === recipe.finishedVariantIds.length &&
        finished.every((v) => v.product.status !== "ARCHIVED"),
      "A finished variant is missing or archived.",
      422,
    );
    if (recipe.bundleProductId) {
      requireValue(
        finished.every((v) => v.product.id === recipe.bundleProductId),
        "Choose variants from one bundle product.",
        422,
      );
    }
    const assigned = new Set();
    for (const component of recipe.components) {
      // Preserve the server's pinned identity on ordinary edits. An unchanged SKU
      // must not silently start referring to a replacement Shopify variant.
      const original = previous?.components.find((c) => c.id === component.id);
      if (
        component.rule.type === "exact_sku" &&
        original?.rule.type === "exact_sku" &&
        original.rule.value === component.rule.value
      ) {
        component.rule.variantId = original.rule.variantId;
      }
      const candidates = await catalog.rule(component.rule);
      requireValue(
        candidates.length > 0,
        `${component.name}: no eligible variants.`,
        422,
      );
      requireValue(
        !candidates.some(
          (v) =>
            recipe.finishedVariantIds.includes(v.id) ||
            (recipe.bundleProductId && v.product.id === recipe.bundleProductId),
        ),
        `${component.name}: a finished variant cannot also be a component.`,
        422,
      );
      if (component.rule.type === "exact_sku")
        component.rule.variantId = candidates[0].id;
      if (recipe.bundleProductId) {
        for (const variant of candidates) {
          requireValue(
            !assigned.has(variant.id),
            `${component.name}: an item already qualifies for another component. Increase that row's quantity or use separate choices.`,
            422,
          );
          assigned.add(variant.id);
        }
      }
      for (const variantId of Object.values(component.bindings))
        requireValue(
          candidates.some((v) => v.id === variantId),
          `${component.name}: a colour binding is outside its eligible group.`,
          422,
        );
    }
    return recipe;
  }
  async function resolve(recipe, finishedVariantId, locationId) {
    gid(finishedVariantId, "ProductVariant");
    gid(locationId, "Location");
    requireValue(
      recipe.finishedVariantIds.includes(finishedVariantId),
      "Finished variant is not part of this recipe.",
    );
    const location = (await catalog.locations()).find(
      (l) => l.id === locationId,
    );
    requireValue(location, "Choose an active Shopify inventory location.", 422);
    const [finished] = await catalog.nodes([finishedVariantId], locationId);
    requireValue(
      finished && finished.product.status !== "ARCHIVED",
      "Finished variant is missing or archived.",
      422,
    );
    const components = [];
    for (const component of recipe.components) {
      let candidates = await catalog.rule(component.rule, locationId);
      candidates = candidates.filter(
        (v) => !recipe.finishedVariantIds.includes(v.id),
      );
      if (component.bindingMode === "by_finished")
        candidates = candidates.filter(
          (v) => v.id === component.bindings[finishedVariantId],
        );
      requireValue(
        candidates.length,
        `${component.name}: no eligible variants for this finished colour.`,
        422,
      );
      components.push({
        ...component,
        candidates: candidates.map(variantSummary),
      });
    }
    return {
      recipeVersion: recipe.version,
      location,
      finished: variantSummary(finished),
      components,
    };
  }
  return {
    validateForSave,
    resolve,
    async crownTemplate() {
      const finishedVariantIds = [],
        bindings = {};
      for (const colour of [1, 2, 3, 6]) {
        const finished = await catalog.exactSku(`RBK_RC_M${colour}_A1`);
        requireValue(
          finished.product.id === "gid://shopify/Product/16090289471869",
          "Crown finished SKU belongs to an unexpected product.",
          422,
        );
        const tray = await catalog.exactSku(`RB_RC_M${colour}`);
        finishedVariantIds.push(finished.id);
        bindings[finished.id] = tray.id;
      }
      return validateForSave({
        name: "Crown V Rolling Kit — Medium",
        finishedVariantIds,
        inventoryOwnership: "unconfirmed",
        components: [
          {
            id: "tray",
            name: "Crown Medium rolling box",
            quantity: 1,
            rule: { type: "prefix", value: "RB_RC_M" },
            bindingMode: "by_finished",
            bindings,
          },
          {
            id: "grinder",
            name: "Head Happy two-piece grinder",
            quantity: 1,
            rule: { type: "product", value: "8327686553754" },
          },
          {
            id: "gold",
            name: "Randy's Gold papers",
            quantity: 1,
            rule: { type: "exact_sku", value: "PAPK_RDY" },
          },
          {
            id: "silver",
            name: "Randy's Silver papers",
            quantity: 1,
            rule: { type: "exact_sku", value: "PAPR_RDY_A1" },
          },
        ],
      });
    },
    async preview(recipe, input, actor) {
      const quantity = integer(input.quantity, "Finished quantity");
      const idempotencyKey = shortText(
        input.idempotencyKey,
        "Preview request ID",
        100,
      );
      requireValue(
        /^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey),
        "Invalid preview request ID.",
      );
      requireValue(
        input.confirmed === true,
        "Confirm all actual components and quantities before previewing.",
      );
      requireValue(
        Array.isArray(input.selections) &&
          input.selections.length === recipe.components.length,
        "Select one actual variant per component group.",
      );
      const selections = input.selections
        .map((s) => {
          requireValue(
            s && typeof s === "object",
            "Each selection must be an object.",
          );
          return {
            componentId: shortText(s.componentId, "Component ID", 60),
            variantId: gid(s.variantId, "ProductVariant"),
          };
        })
        .sort((a, b) => a.componentId.localeCompare(b.componentId));
      requireValue(
        new Set(selections.map((s) => s.componentId)).size ===
          selections.length,
        "Duplicate component selections.",
      );
      const request = {
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        finishedVariantId: input.finishedVariantId,
        locationId: input.locationId,
        quantity,
        selections,
        actor: actor.id,
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex");
      const existing = await store.findPreview(idempotencyKey);
      if (existing) {
        requireValue(
          existing.requestHash === requestHash,
          "This preview request ID was already used for different inputs.",
          409,
        );
        return existing;
      }
      const resolved = await resolve(
        recipe,
        input.finishedVariantId,
        input.locationId,
      );
      const { currency } = await catalog.metadata();
      const blockers = [],
        warnings = [
          "Preview only: no stock was reserved or adjusted. Refresh the preview after any stock or recipe change.",
        ];
      const aggregated = new Map();
      for (const component of resolved.components) {
        const selection = selections.find(
          (s) => s.componentId === component.id,
        );
        const variant = component.candidates.find(
          (v) => v.id === selection?.variantId,
        );
        requireValue(
          variant,
          `${component.name}: select an eligible actual variant.`,
          422,
        );
        const needed = component.quantity * quantity;
        const line = aggregated.get(variant.id) || {
          ...variant,
          quantity: 0,
          groups: [],
        };
        line.quantity += needed;
        line.groups.push({
          id: component.id,
          name: component.name,
          quantity: needed,
        });
        aggregated.set(variant.id, line);
      }
      const lines = [...aggregated.values()];
      // Inventory items, not SKUs, are the actual stock ledger key.
      const itemDemand = new Map();
      for (const line of lines)
        itemDemand.set(
          line.inventoryItemId,
          (itemDemand.get(line.inventoryItemId) || 0) + line.quantity,
        );
      let total = 0,
        costsComplete = true;
      for (const line of lines) {
        if (!line.tracked || !line.inventoryItemId)
          blockers.push(`${line.sku}: inventory is not tracked.`);
        if (!line.stocked || line.available === null)
          blockers.push(
            `${line.sku}: no available inventory level at this location.`,
          );
        else if (line.available < itemDemand.get(line.inventoryItemId))
          blockers.push(
            `${line.sku}: needs ${itemDemand.get(line.inventoryItemId)}, only ${line.available} available.`,
          );
        if (line.requiresComponents)
          blockers.push(`${line.sku}: Shopify marks this as a virtual bundle.`);
        if (
          line.inventoryItemId &&
          line.inventoryItemId === resolved.finished.inventoryItemId
        )
          blockers.push(
            `${line.sku}: component shares the finished product's inventory item.`,
          );
        const units = costUnits(line.cost?.amount);
        if (
          units === null ||
          line.cost?.currencyCode !== currency ||
          !Number.isSafeInteger(units * line.quantity)
        ) {
          costsComplete = false;
          line.extendedCost = null;
          blockers.push(
            `${line.sku}: unit cost is missing, invalid or in a different currency.`,
          );
        } else {
          total += units * line.quantity;
          line.extendedCost = decimal(units * line.quantity);
        }
        line.proposedDelta = -line.quantity;
      }
      if (!Number.isSafeInteger(total)) {
        costsComplete = false;
        blockers.push("Total cost is outside the supported range.");
      }
      const finished = resolved.finished;
      if (!finished.tracked || !finished.stocked || finished.available === null)
        blockers.push(
          "Finished SKU must have tracked stock at the chosen location.",
        );
      if (finished.requiresComponents)
        blockers.push("Finished SKU is a Shopify virtual bundle.");
      if (recipe.inventoryOwnership !== "physical")
        blockers.push(
          "A manager must confirm this finished product is excluded from Bundles.app and other stock automation.",
        );
      const price = costUnits(finished.price);
      const revenue =
        price === null || !Number.isSafeInteger(price * quantity)
          ? null
          : price * quantity;
      if (revenue === null)
        blockers.push("Finished selling price is unavailable.");
      warnings.push(
        "Margin compares Shopify selling price with recorded component costs; VAT, labour, packaging and fees are not adjusted. This is not an accounting gross margin.",
      );
      const snapshot = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "PREVIEW_ONLY",
        inventoryChanged: false,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        recipeName: recipe.name,
        recipeSnapshot: recipe,
        staff: { id: actor.id, name: actor.name },
        location: resolved.location,
        quantity,
        finished: { ...finished, proposedDelta: quantity },
        components: lines,
        selections,
        currency,
        totalComponentCost: costsComplete ? decimal(total) : null,
        unitComponentCost: costsComplete
          ? decimal(Math.round(total / quantity))
          : null,
        sellingValue: revenue === null ? null : decimal(revenue),
        indicativeMarginPercent:
          costsComplete && revenue > 0
            ? Number((((revenue - total) / revenue) * 100).toFixed(2))
            : null,
        blockers: [...new Set(blockers)],
        warnings,
        checksPassed: blockers.length === 0,
        idempotencyKey,
        requestHash,
      };
      return store.savePreview(snapshot);
    },
  };
}

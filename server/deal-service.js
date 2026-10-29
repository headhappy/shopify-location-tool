import { gid, integer, requireValue, shortText } from "./bundle-errors.js";
import { variantSummary } from "./bundle-service.js";

function pennies(value) {
  requireValue(typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value),
    "A price is missing or cannot be used in this GBP test.", 422);
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  requireValue(Number.isSafeInteger(amount) && amount <= 100000000,
    "Price is outside the supported test range.", 422);
  return amount;
}

export function normalizeCart(input) {
  requireValue(Array.isArray(input) && input.length <= 100, "Use at most 100 different items.");
  const cart = new Map();
  for (const line of input) {
    const id = gid(line?.variantId, "ProductVariant");
    const quantity = integer(line.quantity, "Item quantity", 1000);
    cart.set(id, (cart.get(id) || 0) + quantity);
  }
  requireValue([...cart.values()].reduce((a, b) => a + b, 0) <= 1000,
    "Use at most 1,000 items in a test basket.");
  return [...cart].map(([variantId, quantity]) => ({ variantId, quantity }));
}

// One selected deal; eligibility must be disjoint. Stable basket order chooses
// which units receive the deal when the customer has scanned extra colours.
export function matchDeal(deal, input) {
  const cart = normalizeCart(input);
  const members = new Map();
  for (const group of deal.groups) {
    for (const item of group.items) {
      requireValue(!members.has(item.id),
        "An item qualifies for more than one component group. Ask a manager to separate the groups.", 422);
      members.set(item.id, { item, group });
    }
  }
  const lines = cart.map(({ variantId, quantity }) => {
    const member = members.get(variantId);
    requireValue(member, "An item no longer qualifies for this deal. Start a new test.", 422);
    return { ...member.item, groupId: member.group.id, quantity, unitPrice: pennies(member.item.price) };
  });
  const groups = deal.groups.map((group) => {
    const scanned = lines.filter((l) => l.groupId === group.id).reduce((n, l) => n + l.quantity, 0);
    return { id: group.id, name: group.name, required: group.quantity, scanned };
  });
  const sets = Math.min(...groups.map((g) => Math.floor(g.scanned / g.required)));
  const remaining = new Map(groups.map((g) => [g.id, g.required * sets]));
  let regularTotal = 0, matchedTotal = 0;
  const demand = new Map();
  const warnings = new Set();
  for (const line of lines) {
    line.dealQuantity = Math.min(line.quantity, remaining.get(line.groupId));
    remaining.set(line.groupId, remaining.get(line.groupId) - line.dealQuantity);
    line.extraQuantity = line.quantity - line.dealQuantity;
    regularTotal += line.unitPrice * line.quantity;
    matchedTotal += line.unitPrice * line.dealQuantity;
    const key = line.inventoryItemId;
    requireValue(key && line.tracked && !line.requiresComponents,
      "This test needs individually stocked components; a scanned item is untracked or is itself a bundle.", 422);
    const prior = demand.get(key) || { quantity: 0, available: line.available, sku: line.sku };
    prior.quantity += line.quantity;
    prior.available = prior.available === null || line.available === null ? null : Math.min(prior.available, line.available);
    demand.set(key, prior);
    if (line.status !== "ACTIVE") warnings.add(`${line.sku}: this component is not active in Shopify.`);
  }
  for (const item of demand.values()) {
    if (item.available === null) warnings.add(`${item.sku}: stock is not available at this store.`);
    else if (item.quantity > item.available) warnings.add(`${item.sku}: only ${item.available} available at this store.`);
  }
  const dealTotal = deal.price * sets;
  // A fixed-price deal must never silently increase the price of its components.
  const priceFits = sets === 0 || dealTotal <= matchedTotal;
  if (!priceFits) warnings.add("These items cost less individually than the deal price. No deal discount is suggested.");
  const saving = priceFits ? matchedTotal - dealTotal : 0;
  return {
    sets, groups: groups.map((g) => ({ ...g, nextNeeded: Math.max(0, (sets + 1) * g.required - g.scanned) })),
    lines, regularTotal, saving, testTotal: regularTotal - saving,
    warnings: [...warnings], stockChecksPassed: warnings.size === 0,
    inventoryWritesEnabled: false, appliedAdjustments: 0,
  };
}

export function createDealService({ catalog, store }) {
  async function definition(id, locationId, version) {
    const recipe = await store.recipe(id);
    requireValue(recipe.version === version, "This recipe changed. Reload the deal before scanning.", 409);
    gid(locationId, "Location");
    const [metadata, locations, finished] = await Promise.all([
      catalog.metadata(), catalog.locations(), catalog.nodes(recipe.finishedVariantIds),
    ]);
    requireValue(metadata.currency === "GBP", "The first till simulator supports GBP stores only.", 422);
    const location = locations.find((l) => l.id === locationId);
    requireValue(location, "Choose an active store.", 422);
    requireValue(finished.length === recipe.finishedVariantIds.length && finished.length > 0 &&
      finished.every((v) => v.product.status !== "ARCHIVED"), "The deal product is missing or archived.", 422);
    const parent = finished[0].product;
    const price = pennies(finished[0].price);
    requireValue(finished.every((v) => v.product.id === parent.id && pennies(v.price) === price),
      "This simulator needs one deal product with the same price for every listed colour.", 422);
    const groups = [];
    for (const component of recipe.components) {
      // Explicit simulation projection: component families remain eligible across
      // colours. Physical assembly colour bindings are NOT modified or applied.
      const items = (await catalog.rule(component.rule, locationId)).map(variantSummary);
      requireValue(items.length > 0, `${component.name}: no eligible items remain.`, 422);
      requireValue(items.every((v) => v.productId !== parent.id), "The deal product cannot also be a component.", 422);
      groups.push({ id: component.id, name: component.name, quantity: component.quantity, items });
    }
    const deal = { id, version, name: recipe.name, product: { id: parent.id, title: parent.title }, price, currency: "GBP", location, groups };
    matchDeal(deal, []); // Reject overlapping families before the first scan.
    return deal;
  }
  return {
    definition,
    async test(id, input) {
      requireValue(input && typeof input === "object", "A basket is required.");
      const deal = await definition(id, input.locationId, input.recipeVersion);
      let lines = normalizeCart(input.lines);
      if (input.scan !== undefined) {
        const scan = shortText(input.scan, "Barcode or exact SKU", 100);
        const item = await catalog.scan(scan, input.locationId);
        lines = normalizeCart([...lines, { variantId: item.id, quantity: 1 }]);
      }
      return { deal, ...matchDeal(deal, lines) };
    },
  };
}

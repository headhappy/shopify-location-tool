import { gid, requireValue, shortText } from "./bundle-errors.js";

// All operations in this module are reads. The existing client/credentials are reused.
const fields = `id title sku barcode price requiresComponents
  product { id title status }
  inventoryItem { id tracked unitCost { amount currencyCode }
    inventoryLevel(locationId: $locationId) @include(if: $withStock) {
      id quantities(names: ["available"]) { name quantity }
    }
  }`;
export const BUNDLE_VARIANTS_QUERY = `query BundleVariants($query: String!, $after: String, $locationId: ID!, $withStock: Boolean!) {
  productVariants(first: 100, after: $after, query: $query) {
    nodes { ${fields} } pageInfo { hasNextPage endCursor }
  }
}`;
export const BUNDLE_NODES_QUERY = `query BundleNodes($ids: [ID!]!, $locationId: ID!, $withStock: Boolean!) {
  nodes(ids: $ids) { ... on ProductVariant { ${fields} } }
}`;
export const BUNDLE_LOCATIONS_QUERY = `query BundleLocations($after: String) {
  locations(first: 100, after: $after) { nodes { id name isActive } pageInfo { hasNextPage endCursor } }
}`;
export const BUNDLE_SHOP_QUERY = `query BundleShop { shop { currencyCode } currentAppInstallation { accessScopes { handle } } }`;
const quote = (value) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
const stockArgs = (locationId) => ({
  locationId: locationId || "gid://shopify/Location/1",
  withStock: Boolean(locationId),
});

export function createBundleCatalog(graph) {
  async function pages(query, variables, key, max = 5000) {
    const result = [],
      cursors = new Set();
    let after = null;
    do {
      const data = await graph(query, { ...variables, after });
      const connection = data[key];
      requireValue(
        Array.isArray(connection?.nodes) && connection.pageInfo,
        "Shopify returned an incomplete catalogue.",
        502,
      );
      result.push(...connection.nodes);
      requireValue(
        result.length <= max,
        "This rule is too broad. Narrow it before continuing.",
        422,
      );
      if (!connection.pageInfo.hasNextPage) return result;
      after = connection.pageInfo.endCursor;
      requireValue(
        after && !cursors.has(after),
        "Shopify catalogue pagination did not advance.",
        502,
      );
      cursors.add(after);
    } while (true);
  }
  async function search(query, locationId) {
    if (locationId) gid(locationId, "Location");
    return pages(
      BUNDLE_VARIANTS_QUERY,
      { query, ...stockArgs(locationId) },
      "productVariants",
    );
  }
  return {
    async metadata() {
      const data = await graph(BUNDLE_SHOP_QUERY);
      const scopes = new Set(
        data.currentAppInstallation?.accessScopes?.map((s) => s.handle),
      );
      for (const scope of ["products", "inventory", "locations"]) {
        requireValue(
          scopes.has(`read_${scope}`) || scopes.has(`write_${scope}`),
          `Shopify permission read_${scope} is required.`,
          503,
        );
      }
      return { currency: data.shop.currencyCode };
    },
    async locations() {
      return (await pages(BUNDLE_LOCATIONS_QUERY, {}, "locations")).filter(
        (l) => l.isActive,
      );
    },
    async nodes(ids, locationId) {
      ids.forEach((id) => gid(id, "ProductVariant"));
      if (locationId) gid(locationId, "Location");
      const result = [];
      for (let i = 0; i < ids.length; i += 100) {
        const data = await graph(BUNDLE_NODES_QUERY, {
          ids: ids.slice(i, i + 100),
          ...stockArgs(locationId),
        });
        requireValue(
          Array.isArray(data.nodes),
          "Shopify returned no variant data.",
          502,
        );
        result.push(...data.nodes.filter(Boolean));
      }
      return result;
    },
    async lookup(text, locationId) {
      text = shortText(text, "Search", 100);
      if (/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(text))
        return this.nodes([text], locationId);
      if (/^(gid:\/\/shopify\/Product\/)?[1-9][0-9]*$/.test(text)) {
        // Numeric scans can also be barcodes; search both without silently choosing.
        const rows = await search(
          `product_id:${text.split("/").at(-1)} OR barcode:${quote(text)}`,
          locationId,
        );
        return rows.filter(
          (v) =>
            v.product.id ===
              `gid://shopify/Product/${text.split("/").at(-1)}` ||
            v.barcode === text,
        );
      }
      return search(
        `sku:${quote(text)} OR barcode:${quote(text)} OR title:${quote(text)}`,
        locationId,
      );
    },
    async exactSku(sku, locationId) {
      sku = shortText(sku, "SKU", 100);
      const rows = (await search(`sku:${quote(sku)}`, locationId)).filter(
        (v) => v.sku === sku,
      );
      requireValue(
        rows.length === 1,
        rows.length
          ? `SKU ${sku} is duplicated in Shopify; use a restricted variant group instead.`
          : `SKU ${sku} was not found.`,
        422,
      );
      return rows[0];
    },
    async rule(rule, locationId) {
      let rows;
      if (rule.type === "exact_sku") {
        const variant = await this.exactSku(rule.value, locationId);
        requireValue(
          !rule.variantId || variant.id === rule.variantId,
          `SKU ${rule.value} now points to a different variant. Review the recipe.`,
          409,
        );
        rows = [variant];
      } else if (rule.type === "product") {
        rows = (
          await search(`product_id:${rule.value.split("/").at(-1)}`, locationId)
        ).filter((v) => v.product.id === rule.value);
      } else if (rule.type === "prefix") {
        // Prefix is deliberately a safe literal plus an optional final *, never arbitrary regex/search syntax.
        rows = (await search(`sku:${rule.value}*`, locationId)).filter((v) =>
          v.sku?.startsWith(rule.value),
        );
      } else {
        rows = await this.nodes(rule.variantIds, locationId);
        requireValue(
          rows.length === rule.variantIds.length,
          "A restricted variant was deleted or is inaccessible. Review the recipe.",
          422,
        );
      }
      return rows.filter(
        (v) =>
          v.product.status !== "ARCHIVED" &&
          !rule.excludeVariantIds.includes(v.id),
      );
    },
  };
}

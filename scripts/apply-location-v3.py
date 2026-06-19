from pathlib import Path
import re

path = Path('index.js')
s = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    if new in s:
        return
    if old not in s:
        raise RuntimeError(f'Could not find {label}')
    s = s.replace(old, new, 1)

# Add Display LOC to stock exports and both stock queries.
s = s.replace(
    '"Available", "ShelfLocation", "LOC2", "Location",',
    '"Available", "DisplayLocation", "ShelfLocation", "LOC2", "Location",',
)
if 'displayLocMetafield: metafield(namespace: "custom", key: "display_loc")' not in s:
    s = s.replace(
        '              loc2Metafield: metafield(namespace: "custom", key: "location") { value }',
        '              displayLocMetafield: metafield(namespace: "custom", key: "display_loc") { value }\n'
        '              loc2Metafield: metafield(namespace: "custom", key: "location") { value }',
    )

s = s.replace(
    '        Available: Number(variant.inventoryQuantity ?? 0),\n        ShelfLocation:',
    '        Available: Number(variant.inventoryQuantity ?? 0),\n'
    '        DisplayLocation: product.displayLocMetafield?.value || "",\n        ShelfLocation:',
)
s = s.replace(
    '          Available: availableFromInventoryLevel(level),\n          ShelfLocation:',
    '          Available: availableFromInventoryLevel(level),\n'
    '          DisplayLocation: product.displayLocMetafield?.value || "",\n          ShelfLocation:',
)

# Catalogue cache gives true contains matching for product names, variants and SKUs.
cache_marker = 'async function getVariantStockByLocation'
if 'async function findVariantsByContains' not in s:
    marker = '  return rows;\n}\n\nasync function getVariantStockByLocation'
    cache_code = '''  return rows;
}

const LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
let lookupCatalogCache = { expiresAt: 0, rows: [] };

function invalidateLookupCache() {
  lookupCatalogCache = { expiresAt: 0, rows: [] };
}

async function getLookupCatalog() {
  if (Date.now() < lookupCatalogCache.expiresAt && lookupCatalogCache.rows.length) {
    return lookupCatalogCache.rows;
  }
  const rows = await getVariantStockTotal({ status: "ACTIVE" });
  lookupCatalogCache = { expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS, rows };
  return rows;
}

function stockRowToLookupVariant(row) {
  const variantTitle = row.Variant || "";
  const productTitle = row.Product || "";
  return {
    id: row.VariantId || "",
    productId: row.ProductId || "",
    sku: row.SKU || "",
    barcode: row.Barcode || "",
    title: variantTitle ? `${productTitle} – ${variantTitle}` : productTitle,
    productTitle,
    variantTitle,
    currentDisplayLoc: row.DisplayLocation || "",
    currentLocation: row.ShelfLocation || "",
    currentLoc2: row.LOC2 || "",
  };
}

async function findVariantsByContains(term) {
  const needle = normalise(term);
  const rows = await getLookupCatalog();
  return rows.filter(row =>
    normalise(row.Product).includes(needle) ||
    normalise(row.Variant).includes(needle) ||
    normalise(row.SKU).includes(needle) ||
    normalise(row.Barcode) === needle
  ).slice(0, 100).map(stockRowToLookupVariant);
}

async function getVariantStockByLocation'''
    replace_once(marker, cache_code, 'catalogue cache insertion point')

# Advertise the new fields/routes in /health.
health_re = re.compile(
    r'    stockLocationFields: \{.*?\n    \},\n'
    r'    updaterFeatures: \{.*?\n    \},\n',
    re.S,
)
health_new = '''    stockLocationFields: {
      productDisplayLocation: "DisplayLocation from product metafield custom.display_loc",
      variantShelfLocation: "ShelfLocation from variant metafield stock.location",
      productStockroomLocation: "LOC2 from product metafield custom.location",
    },
    updaterFeatures: {
      search: "Barcode, SKU, variant or product-title contains search",
      displayLoc: "Product metafield custom.display_loc",
      location: "Variant metafield stock.location",
      loc2: "Product metafield custom.location",
      lod: "Stored as (LOD) suffix on Display LOC",
      displayLocEndpoint: "/update-display-loc",
      loc2Endpoint: "/update-loc2",
    },
'''
if health_re.search(s):
    s = health_re.sub(health_new, s, count=1)
else:
    # Older health block did not yet have updaterFeatures.
    old = '''    stockLocationFields: {
      variantShelfLocation: "ShelfLocation from variant metafield stock.location",
      productStockroomLocation: "LOC2 from product metafield custom.location",
    },
'''
    replace_once(old, health_new, 'health location fields')

# Replace lookup route with barcode-first plus contains fallback.
lookup_start = s.index('app.post("/lookup-variant"')
lookup_end = s.index('app.post("/update-location"', lookup_start)
lookup_route = r'''app.post("/lookup-variant", async (req, res) => {
  const term = String(req.body?.search || req.body?.barcode || "").trim();
  if (!term) return res.status(400).json({ error: "Barcode or product name required" });

  try {
    let hits = [];
    let matchedBy = "contains";

    // Scanner/barcode queries stay fast. Text containing spaces skips this step.
    if (!/\s/.test(term)) {
      try {
        const query = `
          query ($q: String!) {
            productVariants(first: 20, query: $q) {
              edges {
                node {
                  id title sku barcode
                  locationMetafield: metafield(namespace: "stock", key: "location") { value }
                  product {
                    id title
                    displayLocMetafield: metafield(namespace: "custom", key: "display_loc") { value }
                    loc2Metafield: metafield(namespace: "custom", key: "location") { value }
                  }
                }
              }
            }
          }`;
        const data = await shopifyGraph(query, {
          q: buildVariantSearchQuery({ barcode: term }),
        });
        hits = data.productVariants.edges.map(edge => {
          const v = edge.node;
          const variantTitle = v.title === "Default Title" ? "" : v.title || "";
          return {
            id: v.id,
            productId: v.product?.id || "",
            sku: v.sku || "",
            barcode: v.barcode || "",
            title: variantTitle ? `${v.product?.title || ""} – ${variantTitle}` : v.product?.title || "",
            productTitle: v.product?.title || "",
            variantTitle,
            currentDisplayLoc: v.product?.displayLocMetafield?.value || "",
            currentLocation: v.locationMetafield?.value || "",
            currentLoc2: v.product?.loc2Metafield?.value || "",
          };
        });
        if (hits.length) matchedBy = "barcode";
      } catch (barcodeError) {
        console.warn("Exact barcode lookup skipped:", barcodeError.message);
      }
    }

    if (!hits.length) hits = await findVariantsByContains(term);
    if (!hits.length) return res.status(404).json({ error: "No product or variant matches" });

    if (hits.length === 1) {
      const v = hits[0];
      return res.json({
        matchedBy,
        variant: { id: v.id, sku: v.sku, barcode: v.barcode, title: v.variantTitle },
        product: { id: v.productId },
        productTitle: v.productTitle || v.title,
        currentDisplayLoc: v.currentDisplayLoc,
        currentLocation: v.currentLocation,
        currentLoc2: v.currentLoc2,
      });
    }

    res.json({ matchedBy, variants: hits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
});

'''
s = s[:lookup_start] + lookup_route + s[lookup_end:]

# Cache invalidation after successful writes.
for route, marker in [
    ('/update-location', 'res.json({ success: true });'),
    ('/update-loc2', 'res.json({ success: true });'),
]:
    route_pos = s.find(f'app.post("{route}"')
    if route_pos >= 0:
        response_pos = s.find(marker, route_pos)
        if response_pos >= 0:
            before = s[max(route_pos, response_pos - 80):response_pos]
            if 'invalidateLookupCache();' not in before:
                s = s[:response_pos] + 'invalidateLookupCache();\n    ' + s[response_pos:]

# Add Display LOC writer before LOC2 writer.
if 'app.post("/update-display-loc"' not in s:
    insert_at = s.index('app.post("/update-loc2"')
    display_route = '''app.post("/update-display-loc", async (req, res) => {
  const { productId, displayLocValue } = req.body;
  if (!productId || displayLocValue === undefined) {
    return res.status(400).json({ error: "productId & displayLocValue required" });
  }

  try {
    const mutation = `
      mutation setDisplayLoc($id: ID!, $val: String!) {
        metafieldsSet(metafields: [{
          ownerId: $id,
          namespace: "custom",
          key: "display_loc",
          type: "single_line_text_field",
          value: $val
        }]) { userErrors { field message } }
      }`;
    const result = await shopifyGraph(mutation, { id: productId, val: displayLocValue });
    if (result.metafieldsSet.userErrors.length) throw new Error(result.metafieldsSet.userErrors[0].message);
    invalidateLookupCache();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Display LOC save failed", detail: err.message });
  }
});

'''
    s = s[:insert_at] + display_route + s[insert_at:]

path.write_text(s, encoding='utf-8')
print('Applied Display LOC, LOD and contains-search backend patch.')

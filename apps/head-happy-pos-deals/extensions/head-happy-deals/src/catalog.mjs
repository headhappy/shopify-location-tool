import {PILOT} from './deal.mjs';

export const CATALOG_QUERY = `query CrownPosCheck($ids: [ID!]!, $locationId: ID!, $priceId: ID!) {
  shop { myshopifyDomain currencyCode taxesIncluded }
  priceSource: productVariant(id: $priceId) { id price }
  nodes(ids: $ids) {
    ... on ProductVariant {
      id sku price requiresComponents
      product { id status }
      inventoryItem {
        tracked
        inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } }
      }
    }
  }
}`;

export async function loadCatalog(cart, session, request = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await request('shopify:admin/api/graphql.json', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
      body: JSON.stringify({query: CATALOG_QUERY, variables: {
        ids: cart.lineItems.map((l) => `gid://shopify/ProductVariant/${l.variantId}`),
        locationId: `gid://shopify/Location/${session.locationId}`, priceId: PILOT.priceVariantId,
      }}),
    });
    if (!response.ok) throw new Error('Shopify could not check the products. Check the connection and POS app permissions.');
    const body = await response.json();
    if (body.errors?.length || !body.data) throw new Error('Shopify could not check every product and stock level. Check the app’s read permissions.');
    return body.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The Shopify check timed out. Try again with a working connection.');
    throw error;
  } finally { clearTimeout(timeout); }
}

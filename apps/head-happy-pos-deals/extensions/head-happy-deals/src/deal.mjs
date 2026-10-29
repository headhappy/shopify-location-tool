export const PILOT = Object.freeze({
  shop: 'headhappyhemp.myshopify.com', locationId: 39777796140,
  name: 'Crown Rolling Kit — Medium',
  priceVariantId: 'gid://shopify/ProductVariant/58997323628925', priceCents: 1499, currency: 'GBP',
  discountTitle: 'Crown kit — Head Happy pilot', markerKey: '_headhappy_pos_deal_v1',
});

export const GROUPS = Object.freeze([
  {id: 'box', name: 'Crown Medium box', matches: (v) => /^RB_RC_M[1-9]\d*$/.test(v.sku || '')},
  {id: 'grinder', name: 'Head Happy two-piece grinder', matches: (v) => String(v.productId) === '8327686553754'},
  {id: 'gold', name: 'Randy’s Gold papers', matches: (v) => v.sku === 'PAPK_RDY'},
  {id: 'silver', name: 'Randy’s Silver papers', matches: (v) => v.sku === 'PAPR_RDY_A1'},
]);

export function cents(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}
export const money = (value) => `£${(value / 100).toFixed(2)}`;

// The legacy field can alias one discount in the array. Equal array entries still stack.
export function cartDiscounts(cart) {
  const list = [...(cart.cartDiscounts || [])];
  if (cart.cartDiscount && !list.some((d) => discountKey(d) === discountKey(cart.cartDiscount))) list.push(cart.cartDiscount);
  return list;
}
function discountKey(d) {
  return JSON.stringify([d.discountDescription, d.type, d.amount, d.currency]);
}
export function marker(cart) {
  try {
    const record = JSON.parse(cart.properties?.[PILOT.markerKey] || 'null');
    return record?.version === 1 && typeof record.fingerprint === 'string' && Number.isSafeInteger(record.discountCents) ? record : null;
  } catch { return null; }
}
export function ownsDiscount(cart) {
  const record = marker(cart);
  const discounts = cartDiscounts(cart);
  return Boolean(record && discounts.length === 1 && discounts[0].discountDescription === PILOT.discountTitle
    && discounts[0].type === 'FixedAmount' && cents(discounts[0].amount) === record.discountCents
    && (!discounts[0].currency || discounts[0].currency === PILOT.currency));
}
export function fingerprint(cart, session) {
  return JSON.stringify([session.shopDomain, session.locationId, session.currency, cart.currency, cart.customer?.id ?? null,
    (cart.lineItems || []).map((l) => [l.uuid, l.variantId, l.productId, l.sku, l.quantity, l.price, l.taxable,
      l.sellingPlan?.id ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}
export function inspectCart(cart, session, {allowOwned = false} = {}) {
  const fail = (reason) => ({ok: false, reason, groups: []});
  if (session.shopDomain !== PILOT.shop || session.locationId !== PILOT.locationId) return fail('This pilot is for Head Happy at 31 Cowgate.');
  if (session.currency !== 'GBP' || cart.currency !== 'GBP') return fail('This deal needs a GBP basket.');
  if (cart.editable === false) return fail('Return to the editable basket before applying the deal.');
  const owned = allowOwned && ownsDiscount(cart);
  if (cartDiscounts(cart).length && !owned) return fail('Another basket discount is present. Ask a manager to review it first.');
  const lines = cart.lineItems || [];
  if (lines.length !== 4 || lines.some((l) => l.quantity !== 1)) return fail('Scan one box, one grinder and one of each paper. Use a separate basket for this first test.');
  if (new Set(lines.map((l) => l.uuid)).size !== 4 || new Set(lines.map((l) => l.variantId)).size !== 4) return fail('The basket has duplicate items.');
  const groups = [];
  let subtotalCents = 0;
  let allocatedCents = 0;
  for (const line of lines) {
    if (!line.uuid || !Number.isSafeInteger(line.variantId) || !Number.isSafeInteger(line.productId)
      || line.isGiftCard || line.sellingPlan || line.requiresSellingPlan || line.components?.length) return fail('Use ordinary component products, without subscriptions or another bundle.');
    if ((line.discounts || []).length) return fail('An item already has a discount. Ask a manager to review it first.');
    for (const allocation of line.discountAllocations || []) {
      const amount = cents(allocation.allocatedAmount?.amount);
      if (amount === null || allocation.allocatedAmount?.currencyCode !== 'GBP') return fail('The item discounts could not be checked.');
      allocatedCents += amount;
    }
    const price = cents(line.price);
    if (price === null || price <= 0) return fail('An item price is missing or invalid.');
    const matches = GROUPS.filter((g) => g.matches(line));
    if (matches.length !== 1 || groups.some((g) => g.id === matches[0].id)) return fail('These items do not make one complete Crown kit.');
    groups.push({...matches[0], line});
    subtotalCents += price;
  }
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents <= PILOT.priceCents) return fail('The normal total is not above the deal price. No discount was added.');
  const discountCents = subtotalCents - PILOT.priceCents;
  if ((!owned && allocatedCents !== 0) || (owned && allocatedCents !== 0 && allocatedCents !== discountCents)) return fail('An unexpected discount allocation is present.');
  if (cents(cart.grandTotal) !== (owned ? PILOT.priceCents : subtotalCents)) return fail('The basket total differs from the expected price. Check discounts, prices and tax before continuing.');
  const print = fingerprint(cart, session);
  if (owned && (marker(cart).fingerprint !== print || marker(cart).discountCents !== discountCents)) return fail('The basket changed after applying this deal. Remove the deal and check again.');
  return {ok: true, reason: '', groups, subtotalCents, discountCents, fingerprint: print, applied: owned};
}
export function checkCatalog(data, cart, session) {
  const inspection = inspectCart(cart, session);
  if (!inspection.ok) throw new Error(inspection.reason);
  if (data?.shop?.myshopifyDomain !== PILOT.shop || data.shop.currencyCode !== 'GBP' || data.shop.taxesIncluded !== true) throw new Error('Store currency or tax settings have changed. Ask a manager to review this pilot.');
  if (data.priceSource?.id !== PILOT.priceVariantId || cents(data.priceSource.price) !== PILOT.priceCents) throw new Error('The Crown kit price has changed. Ask a manager to review this pilot.');
  const nodes = new Map((data.nodes || []).filter(Boolean).map((v) => [v.id, v]));
  for (const {line, matches} of inspection.groups) {
    const variant = nodes.get(`gid://shopify/ProductVariant/${line.variantId}`);
    const productId = variant?.product?.id?.split('/').pop();
    if (!variant || variant.product.status !== 'ACTIVE' || String(line.productId) !== productId
      || line.sku !== variant.sku || !matches({sku: variant.sku, productId}) || variant.requiresComponents !== false
      || variant.inventoryItem?.tracked !== true) throw new Error(`Cannot verify ${line.sku || line.title} as a tracked deal component.`);
    if (cents(variant.price) !== cents(line.price)) throw new Error(`The till price for ${line.sku} differs from Shopify. Refresh the basket first.`);
    const available = variant.inventoryItem.inventoryLevel?.quantities?.find((q) => q.name === 'available')?.quantity;
    if (!Number.isSafeInteger(available) || available < 1) throw new Error(`${line.sku} has no available stock at 31 Cowgate.`);
  }
  return inspection;
}

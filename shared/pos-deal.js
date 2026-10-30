// Shared by the POS extension and server. These checks never write inventory.
export const MARKER = '_headhappy_deal_v2';
export const SHOP = 'headhappyhemp.myshopify.com';
export function cents(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result <= 100000000 ? result : null;
}
export const money = (value) => `£${(value / 100).toFixed(2)}`;
function need(ok, message) { if (!ok) throw new Error(message); }
export function cartDiscounts(cart) {
  const list = [...(cart.cartDiscounts || [])];
  if (cart.cartDiscount && !list.some((d) => JSON.stringify(d) === JSON.stringify(cart.cartDiscount))) list.push(cart.cartDiscount);
  return list;
}
export function marker(cart) {
  try {
    const m = JSON.parse(cart.properties?.[MARKER] || 'null');
    return m?.v === 2 && typeof m.title === 'string' && m.title.startsWith('HH deal ') &&
      typeof m.hash === 'string' && Number.isSafeInteger(m.saving) && m.saving > 0 ? m : null;
  } catch { return null; }
}
export function fingerprint(cart, session) {
  const text = JSON.stringify([session.shopDomain, session.locationId, session.currency, cart.currency, cart.customer?.id ?? null,
    (cart.lineItems || []).map(l => [l.uuid, l.variantId, l.productId, l.sku, l.quantity, l.price, l.taxable,
      l.sellingPlan?.id ?? null, l.requiresSellingPlan, l.isGiftCard, l.components, l.properties]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))]);
  // Non-security checksum for stale-basket detection; authentication uses Shopify JWTs.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function ownedLines(cart) {
  const m = marker(cart);
  return m ? (cart.lineItems || []).filter(l => (l.discounts || []).some(d => d.discountDescription === m.title)) : [];
}
export function appliedValid(cart, session) {
  const m = marker(cart);
  if (!m || m.hash !== fingerprint(cart, session) || cartDiscounts(cart).length) return false;
  let saving = 0, regular = 0;
  for (const line of cart.lineItems || []) {
    const price = cents(line.price);
    if (price === null) return false;
    regular += price * line.quantity;
    for (const d of line.discounts || []) {
      if (d.discountDescription !== m.title || d.type !== 'FixedAmount' || cents(d.amount) === null || (d.currency && d.currency !== 'GBP')) return false;
      saving += cents(d.amount) * line.quantity;
    }
  }
  return saving === m.saving && cents(cart.grandTotal) === regular - saving;
}
export function inspectCart(cart, session) {
  need(session.shopDomain === SHOP && Number.isSafeInteger(session.locationId) && session.locationId > 0, 'Open this app in Head Happy Shopify POS.');
  need(session.currency === 'GBP' && cart.currency === 'GBP', 'This deal needs a GBP basket.');
  need(cart.editable !== false, 'Return to the basket before applying the deal.');
  need(!cartDiscounts(cart).length, 'Another basket discount is present. Review it in POS before applying a deal.');
  need(!cart.properties?._headhappy_pos_deal_v1, 'Remove the old Crown pilot discount and its basket before using the updated deal.');
  const lines = cart.lineItems;
  need(Array.isArray(lines) && lines.length > 0 && lines.length <= 100, 'Scan the components first (up to 100 different items).');
  need(new Set(lines.map(l => l.uuid)).size === lines.length, 'The basket has duplicate line identifiers. Refresh it first.');
  let subtotal = 0, count = 0;
  for (const l of lines) {
    need(typeof l.uuid === 'string' && l.uuid.length <= 100 && Number.isSafeInteger(l.variantId) && l.variantId > 0 &&
      Number.isSafeInteger(l.productId) && l.productId > 0 && Number.isSafeInteger(l.quantity) && l.quantity > 0,
      'Use ordinary scanned products with whole quantities.');
    need(!l.isGiftCard && !l.sellingPlan && !l.requiresSellingPlan && !l.components?.length,
      'Gift cards, subscriptions and other nested bundles need a separate basket.');
    need(!(l.discounts || []).length && !(l.discountAllocations || []).length,
      'An item already has a discount. Review it in POS before applying a deal.');
    const price = cents(l.price);
    need(price !== null, 'An item price is missing or invalid.');
    subtotal += price * l.quantity; count += l.quantity;
  }
  need(count <= 1000 && Number.isSafeInteger(subtotal), 'Use at most 1,000 items in this basket.');
  need(cents(cart.grandTotal) === subtotal, 'The basket total differs from its item prices. Check prices, tax and discounts first.');
  return {subtotal, fingerprint: fingerprint(cart, session)};
}

// Native FixedAmount discounts are PER UNIT. Allocate exact pennies across only
// matching product lines, never across unrelated extras. Repeated units of one
// variant share that line's saving. Refuse a total that cannot be represented.
export function allocateDiscount(lines, saving) {
  const total = lines.reduce((n,l) => n + l.price * l.used, 0);
  const base = lines.map(l => Math.floor(saving * l.price * l.used / total / l.quantity));
  for (let retry = 0; retry < 2; retry++) {
    const amounts = base.map(v => Math.max(0, v - retry));
    const left = saving - amounts.reduce((n,v,i) => n + v * lines[i].quantity, 0);
    const paths = Array(left + 1).fill(null); paths[0] = [];
    for (let i = 0; i < lines.length; i++) {
      const q = lines[i].quantity, capacity = lines[i].price - amounts[i];
      const before = paths.slice();
      for (let sum = 0; sum <= left; sum++) if (before[sum]) {
        for (let k = 1; k <= capacity && sum + k * q <= left; k++) {
          if (!paths[sum + k * q]) paths[sum + k * q] = [...before[sum], [i,k]];
        }
      }
    }
    if (paths[left]) {
      for (const [i,k] of paths[left]) amounts[i] += k;
      return lines.map((l,i) => ({uuid:l.uuid, amount:amounts[i]})).filter(l => l.amount > 0);
    }
  }
  throw new Error('These extra quantities prevent an exact penny split. Put the complete deals in their own basket.');
}

export function quoteCart(deal, cart, session) {
  const inspection = inspectCart(cart, session);
  const members = new Map();
  for (const group of deal.groups) for (const item of group.items) {
    need(!members.has(item.id), 'A product qualifies for two groups. Ask a manager to correct the saved bundle.');
    members.set(item.id, {item, group});
  }
  const counts = new Map(deal.groups.map(g => [g.id, 0]));
  const eligible = [];
  for (const line of cart.lineItems) {
    const member = members.get(`gid://shopify/ProductVariant/${line.variantId}`);
    if (!member) continue;
    const {item, group} = member;
    need(item.productId === `gid://shopify/Product/${line.productId}` && item.sku === line.sku && cents(item.price) === cents(line.price),
      `${line.sku}: the till differs from Shopify. Refresh the basket and try again.`);
    need(item.status === 'ACTIVE' && item.tracked && !item.requiresComponents, `${line.sku}: this is not an active, individually stocked component.`);
    counts.set(group.id, counts.get(group.id) + line.quantity);
    eligible.push({...line, price:cents(line.price), groupId:group.id, available:item.available});
  }
  const sets = Math.min(...deal.groups.map(g => Math.floor(counts.get(g.id) / g.quantity)));
  const missing = deal.groups.filter(g => counts.get(g.id) < g.quantity).map(g => `${g.quantity - counts.get(g.id)} × ${g.name}`);
  need(sets > 0, 'Still to scan: ' + missing.join(', '));
  const remaining = new Map(deal.groups.map(g => [g.id, sets * g.quantity]));
  let matchedTotal = 0;
  const demand = new Map();
  for (const l of eligible) {
    l.used = Math.min(l.quantity, remaining.get(l.groupId)); remaining.set(l.groupId, remaining.get(l.groupId) - l.used);
    matchedTotal += l.price * l.used;
    demand.set(l.variantId, (demand.get(l.variantId) || 0) + l.quantity);
  }
  for (const l of eligible) need(Number.isSafeInteger(l.available) && l.available >= demand.get(l.variantId), `${l.sku}: not enough recorded stock at this store.`);
  const saving = matchedTotal - sets * deal.price;
  need(saving > 0, 'These items already cost the same or less than the bundle. No discount is needed.');
  const discounts = allocateDiscount(eligible.filter(l => l.used), saving);
  return {id:deal.id, version:deal.version, name:deal.name, price:deal.price, sets, saving,
    total:inspection.subtotal - saving, fingerprint:inspection.fingerprint, discounts,
    title:`HH deal ${deal.id.slice(0,8)} · ${deal.name.slice(0,45)}`};
}

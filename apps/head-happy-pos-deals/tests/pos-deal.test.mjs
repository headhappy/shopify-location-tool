import test from 'node:test';
import assert from 'node:assert/strict';
import {PILOT, cents, inspectCart, checkCatalog, ownsDiscount, cartDiscounts} from '../extensions/head-happy-deals/src/deal.mjs';
import {createController, waitForCart, watchDeal} from '../extensions/head-happy-deals/src/controller.mjs';
import {loadCatalog} from '../extensions/head-happy-deals/src/catalog.mjs';

const session = {shopDomain: PILOT.shop, locationId: PILOT.locationId, currency: 'GBP'};
function basket() {
  const rows = [
    [45153222328474, 8327727251610, 'RB_RC_M1', 14.99],
    [45284463181978, 8327686553754, 'GA_2PC_HH_B1', 3.50],
    [45153188151450, 8327702904986, 'PAPK_RDY', 2.65],
    [45153191952538, 8327705919642, 'PAPR_RDY_A1', 2.29],
  ];
  return {currency: 'GBP', grandTotal: '23.43', subtotal: '23.43', taxTotal: '3.91', properties: {existing: 'kept'}, cartDiscounts: [],
    lineItems: rows.map(([variantId, productId, sku, price], index) => ({uuid: `line-${index}`, variantId, productId, sku, price,
      quantity: 1, discounts: [], discountAllocations: [], taxable: true, isGiftCard: false, properties: {existing: 'kept'}}))};
}
function catalog(cart = basket()) {
  return {shop: {myshopifyDomain: PILOT.shop, currencyCode: 'GBP', taxesIncluded: true},
    priceSource: {id: PILOT.priceVariantId, price: '14.99'},
    nodes: cart.lineItems.map((line) => ({id: `gid://shopify/ProductVariant/${line.variantId}`, sku: line.sku,
      price: line.price.toFixed(2), requiresComponents: false, product: {id: `gid://shopify/Product/${line.productId}`, status: 'ACTIVE'},
      inventoryItem: {tracked: true, inventoryLevel: {quantities: [{name: 'available', quantity: 5}]}}}))};
}
function fakeApi(start = basket()) {
  const subscribers = new Set();
  const calls = [];
  const api = {calls, current: {value: start, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }},
    change(fn) { fn(api.current.value); for (const fn of subscribers) fn(api.current.value); },
    async addCartProperties(properties) { calls.push('properties'); api.change((c) => Object.assign(c.properties, properties)); },
    async removeCartProperties(keys) { calls.push('removeProperties'); api.change((c) => keys.forEach((key) => delete c.properties[key])); },
    async applyCartDiscount(type, title, amount) { calls.push('apply'); api.change((c) => {
      c.cartDiscounts = [{type, discountDescription: title, amount: Number(amount), currency: 'GBP'}];
      c.grandTotal = ((cents(c.subtotal) - cents(amount)) / 100).toFixed(2);
    }); },
    async removeCartDiscount() { calls.push('remove'); api.change((c) => { c.cartDiscounts = []; c.grandTotal = c.subtotal; }); },
  };
  return api;
}

test('one complete kit saves exactly £8.44 and accepts other eligible colours', () => {
  const cart = basket();
  assert.equal(inspectCart(cart, session).discountCents, 844);
  cart.lineItems[0].sku = 'RB_RC_M3'; cart.lineItems[0].variantId = 45153222459546; cart.lineItems[0].productId = 8327727349914;
  cart.lineItems[1].sku = 'GA_2PC_HH_B4'; cart.lineItems[1].variantId = 45284463313050;
  assert.equal(checkCatalog(catalog(cart), cart, session).ok, true);
});

for (const [name, mutate] of [
  ['missing component', (c) => c.lineItems.pop()],
  ['extra item', (c) => c.lineItems.push({...c.lineItems[0], uuid: 'extra'})],
  ['second kit', (c) => c.lineItems.forEach((l) => {l.quantity = 2;})],
  ['fractional quantity', (c) => {c.lineItems[0].quantity = 0.5;}],
  ['wrong grinder family', (c) => {c.lineItems[1].productId = 123;}],
  ['finished kit instead of box', (c) => {c.lineItems[0].sku = 'RBK_RC_M1_A1';}],
  ['duplicate paper group', (c) => {c.lineItems[3].sku = 'PAPK_RDY';}],
  ['manual line discount', (c) => {c.lineItems[0].discounts = [{amount: 1}];}],
  ['automatic allocation', (c) => {c.lineItems[0].discountAllocations = [{allocatedAmount: {amount: '1.00', currencyCode: 'GBP'}}];}],
  ['cart discount', (c) => {c.cartDiscounts = [{amount: 1, type: 'FixedAmount'}];}],
  ['custom sale', (c) => {delete c.lineItems[0].variantId;}],
  ['nested bundle', (c) => {c.lineItems[0].components = [{}];}],
  ['subscription', (c) => {c.lineItems[0].sellingPlan = {id: 1};}],
  ['non GBP cart', (c) => {c.currency = 'USD';}],
  ['locked checkout', (c) => {c.editable = false;}],
  ['tax-adjusted total', (c) => {c.grandTotal = '28.11';}],
  ['missing price', (c) => {delete c.lineItems[0].price;}],
]) test(`refuses ${name} without discounting`, async () => {
  const cart = basket(); mutate(cart);
  assert.equal(inspectCart(cart, session).ok, false);
  const api = fakeApi(cart);
  await assert.rejects(createController(api, session, async () => catalog()).apply());
  assert.equal(api.calls.includes('apply'), false);
});

test('rejects a different shop or location', () => {
  assert.equal(inspectCart(basket(), {...session, shopDomain: 'other.myshopify.com'}).ok, false);
  assert.equal(inspectCart(basket(), {...session, locationId: 72154022042}).ok, false);
});

for (const [name, mutate] of [
  ['missing variant', (d) => {d.nodes[0] = null;}],
  ['untracked stock', (d) => {d.nodes[0].inventoryItem.tracked = false;}],
  ['zero stock', (d) => {d.nodes[0].inventoryItem.inventoryLevel.quantities[0].quantity = 0;}],
  ['not stocked here', (d) => {d.nodes[0].inventoryItem.inventoryLevel = null;}],
  ['draft component', (d) => {d.nodes[0].product.status = 'DRAFT';}],
  ['changed SKU', (d) => {d.nodes[0].sku = 'OTHER';}],
  ['changed product', (d) => {d.nodes[0].product.id = 'gid://shopify/Product/1';}],
  ['bundle component', (d) => {d.nodes[0].requiresComponents = true;}],
  ['stale/manual price', (d) => {d.nodes[0].price = '15.99';}],
  ['changed kit price', (d) => {d.priceSource.price = '16.99';}],
  ['tax setting change', (d) => {d.shop.taxesIncluded = false;}],
]) test(`catalog check refuses ${name}`, () => {
  const data = catalog(); mutate(data);
  assert.throws(() => checkCatalog(data, basket(), session));
});

test('money is exact and rejects malformed prices', () => {
  assert.equal(cents('14.99'), 1499);
  for (const v of ['', null, NaN, '£14.99', '14.999', -1, '1e3', Infinity]) assert.equal(cents(v), null);
});

test('apply twice is idempotent; removing preserves component lines and other properties', async () => {
  const api = fakeApi();
  const original = structuredClone(api.current.value.lineItems);
  const controller = createController(api, session, async () => catalog());
  await controller.apply(); await controller.apply();
  assert.equal(api.calls.filter((x) => x === 'apply').length, 1);
  assert.equal(api.current.value.grandTotal, '14.99');
  assert.equal(ownsDiscount(api.current.value), true);
  await controller.remove();
  assert.equal(api.current.value.grandTotal, '23.43');
  assert.deepEqual(api.current.value.lineItems, original);
  assert.deepEqual(api.current.value.properties, {existing: 'kept'});
});

test('duplicate equal discounts remain detectable; legacy alias is counted once', async () => {
  const api = fakeApi(); await createController(api, session, async () => catalog()).apply();
  api.current.value.cartDiscount = {...api.current.value.cartDiscounts[0]};
  assert.equal(cartDiscounts(api.current.value).length, 1);
  api.current.value.cartDiscounts.push({...api.current.value.cartDiscount});
  assert.equal(cartDiscounts(api.current.value).length, 2);
  assert.equal(ownsDiscount(api.current.value), false);
});

test('basket edits during catalog check cancel the discount', async () => {
  const api = fakeApi();
  await assert.rejects(createController(api, session, async () => {
    api.change((c) => {c.lineItems[0].quantity = 2;}); return catalog();
  }).apply(), /basket changed/i);
  assert.equal(api.calls.includes('apply'), false);
});

test('concurrent clicks cannot apply twice', async () => {
  const api = fakeApi(); let release;
  const controller = createController(api, session, () => new Promise((resolve) => {release = resolve;}));
  const first = controller.apply();
  await assert.rejects(controller.apply(), /Wait/);
  release(catalog()); await first;
  assert.equal(api.calls.filter((c) => c === 'apply').length, 1);
});

test('failed native apply with a partial change rolls back only its own discount', async () => {
  const api = fakeApi(); const apply = api.applyCartDiscount;
  api.applyCartDiscount = async (...args) => {await apply(...args); throw new Error('Native failure');};
  await assert.rejects(createController(api, session, async () => catalog()).apply(), /Native failure/);
  assert.deepEqual(api.current.value.cartDiscounts, []);
  assert.equal(api.current.value.grandTotal, '23.43');
});

test('remove never clears another app’s cart discount', async () => {
  const api = fakeApi(); const controller = createController(api, session, async () => catalog());
  await controller.apply();
  api.current.value.cartDiscounts.push({discountDescription: 'Other promotion', type: 'FixedAmount', amount: 1});
  await assert.rejects(controller.remove(), /manager/);
  assert.equal(api.calls.includes('remove'), false);
});

test('mounted guard removes a stale deal after a component changes', async () => {
  const api = fakeApi(); await createController(api, session, async () => catalog()).apply();
  const messages = [];
  const stop = watchDeal(api, session, (m) => messages.push(m));
  api.change((c) => {c.lineItems[0].quantity = 2;});
  await new Promise((resolve) => setTimeout(resolve, 650));
  stop();
  assert.equal(api.current.value.cartDiscounts.length, 0);
  assert.equal(messages.length, 1);
});

test('native signal timeout does not report success', async () => {
  await assert.rejects(waitForCart(fakeApi(), () => false, 5), /not confirmed/);
});

test('entering payment with a valid deal does not trigger the edit guard', async () => {
  const api = fakeApi(); await createController(api, session, async () => catalog()).apply();
  const messages = [];
  const stop = watchDeal(api, session, (m) => messages.push(m));
  api.change((c) => {c.editable = false;});
  await new Promise((resolve) => setTimeout(resolve, 650));
  stop();
  assert.equal(ownsDiscount(api.current.value), true);
  assert.deepEqual(messages, []);
});

test('catalog fetch uses Shopify native authentication, no credentials and no mutation', async () => {
  const data = catalog();
  assert.deepEqual(await loadCatalog(basket(), session, async (url, request) => {
    assert.equal(url, 'shopify:admin/api/graphql.json');
    assert.equal(request.headers.Authorization, undefined);
    assert.match(JSON.parse(request.body).query, /^query CrownPosCheck/);
    assert.equal(JSON.parse(request.body).variables.ids.length, 4);
    return {ok: true, json: async () => ({data})};
  }), data);
  await assert.rejects(loadCatalog(basket(), session, async () => ({ok: true, json: async () => ({data, errors: [{message: 'denied'}]})})), /read permissions/);
});

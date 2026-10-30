import test from 'node:test';
import assert from 'node:assert/strict';
import {initialSelections,missingItems,selectedItems,scanChoice,chooseItem} from '../../../shared/pos-build.js';
import {quoteCart,fingerprint,appliedValid} from '../../../shared/pos-deal.js';
import {createBuildController} from '../extensions/head-happy-deals/src/build-controller.mjs';
import {session,sessionApi,dealFixture,cartFixture,nativeFixture} from './fixtures.mjs';
const deal=dealFixture(),choices=initialSelections(deal,cartFixture());
const backend=async(_s,path,body)=>path==='/definition' ? deal : {...quoteCart(deal,body.cart,body.session,body.selections,body.sets),expiresAt:Date.now()+30000};
function native(cart=cartFixture()) {
  const n=nativeFixture(cart);let added=0,removed=0;
  n.api.addLineItem=async(id,quantity,options)=>{
    const item=deal.groups.flatMap(g=>g.items).find(v=>v.id.endsWith('/'+id)),uuid='added-'+(++added);
    n.cart.lineItems.push({uuid,variantId:id,productId:Number(item.productId.split('/').pop()),sku:item.sku,price:Number(item.price),quantity,
      properties:options.properties,discounts:[],taxable:true});n.emit();return uuid;
  };
  n.api.removeLineItem=async(uuid)=>{n.cart.lineItems=n.cart.lineItems.filter(l=>l.uuid!==uuid);removed++;n.emit();};
  return {...n,get added(){return added;},get removed(){return removed;}};
}
test('guide enforces every required group, supports quantities and ambiguous scans',()=>{
  assert.equal(selectedItems(deal,choices).length,4);
  assert.throws(()=>selectedItems(deal,choices.slice(1)),/exactly/);
  assert.throws(()=>selectedItems(deal,[...choices,choices[0]]),/duplicated/);
  const group=structuredClone(deal.groups[0]);group.items.forEach(v=>v.barcode='shared');
  assert.throws(()=>scanChoice(group,'shared'),/more than one/);
  assert.equal(scanChoice(group,'BOX_GREEN'),group.items[1].id);
  assert.throws(()=>scanChoice(group,'unrelated'),/not a/);
  const next=chooseItem(deal,choices,'box',deal.groups[0].items[1].id);
  assert.equal(next.find(v=>v.groupId==='box').variantId,deal.groups[0].items[1].id);
});
test('reuse matching scans; never add a parent kit as well as its components',()=>{
  assert.ok(missingItems(deal,choices,cartFixture()).every(v=>v.add===0 && v.reuse===1));
  const c=cartFixture();c.lineItems.push({...c.lineItems[0],productId:999});
  assert.throws(()=>missingItems(deal,choices,c),/finished deal product/);
});
test('empty basket receives exactly the selected components and £14.99 price',async()=>{
  const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'}),messages=[];
  await createBuildController(n.api,sessionApi,backend,m=>messages.push(m)).build(deal,choices,fingerprint(n.cart,session));
  assert.equal(n.added,4);assert.equal(n.cart.lineItems.length,4);assert.equal(n.cart.grandTotal,'14.99');
  assert.ok(appliedValid(n.cart,session));assert.ok(messages.some(m=>m.startsWith('Applying')));
});
test('already-scanned components are reused without duplicates',async()=>{
  const n=native();await createBuildController(n.api,sessionApi,backend).build(deal,choices,fingerprint(n.cart,session));
  assert.equal(n.added,0);assert.equal(n.cart.grandTotal,'14.99');assert.equal(n.cart.lineItems.length,4);
});
test('partial basket adds only the missing papers and preserves unrelated items',async()=>{
  const c=cartFixture();c.lineItems=c.lineItems.slice(0,2);c.lineItems.push({uuid:'extra',variantId:55,productId:66,sku:'EXTRA',price:5,quantity:1,discounts:[]});
  const n=native(c);n.emit();await createBuildController(n.api,sessionApi,backend).build(deal,choices,fingerprint(n.cart,session));
  assert.equal(n.added,2);assert.equal(n.cart.grandTotal,'19.99');assert.deepEqual(n.cart.lineItems.find(l=>l.uuid==='extra').discounts,[]);
});
test('one guided deal never silently discounts a second complete set',()=>{
  const c=cartFixture();c.lineItems.forEach(l=>l.quantity=2);c.grandTotal='46.86';
  const q=quoteCart(deal,c,session,choices);assert.equal(q.sets,1);assert.equal(q.total,3842);
});
test('cancelled native addition rolls back only new components',async()=>{
  const c=cartFixture();c.lineItems=c.lineItems.slice(0,1);const n=native(c);n.emit();const original=n.api.addLineItem;
  let calls=0;n.api.addLineItem=async(...args)=>++calls===2 ? '' : original(...args);
  await assert.rejects(createBuildController(n.api,sessionApi,backend).build(deal,choices,fingerprint(n.cart,session)),/cancelled/);
  assert.equal(n.cart.lineItems.length,1);assert.equal(n.cart.lineItems[0].sku,'BOX_RED');assert.equal(n.removed,1);
});
test('backend quote failure after adding items rolls back the new kit',async()=>{
  const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'});
  const fail=async(...args)=>{if(args[1]==='/quote')throw new Error('Recipe changed');return backend(...args);};
  await assert.rejects(createBuildController(n.api,sessionApi,fail).build(deal,choices,fingerprint(n.cart,session)),/Recipe changed/);
  assert.equal(n.cart.lineItems.length,0);assert.equal(n.removed,4);
});
test('price, stock, discount and basket changes stop before adding anything',async()=>{
  for(const mode of ['price','stock','discount','stale']) {
    const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'}),hash=fingerprint(n.cart,session);
    if(mode==='discount')n.cart.cartDiscount={amount:1};
    if(mode==='stale')n.cart.customer={id:7};
    const change=async()=>{const d=structuredClone(deal);if(mode==='price')d.price++;if(mode==='stock')d.groups[0].items[0].available=0;return d;};
    await assert.rejects(createBuildController(n.api,sessionApi,change).build(deal,choices,hash));assert.equal(n.added,0);
  }
});
test('double tap cannot create a duplicate kit',async()=>{
  const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'}),hash=fingerprint(n.cart,session);
  let release;const gate=new Promise(r=>release=r);
  const c=createBuildController(n.api,sessionApi,async(...args)=>{await gate;return backend(...args);});
  const first=c.build(deal,choices,hash);await assert.rejects(c.build(deal,choices,hash),/already/);release();await first;assert.equal(n.added,4);
});
test('two guided kits can mix colours and total £29.98 with exact quantities',async()=>{
  const two=choices.map(c=>({...c,quantity:2}));two[0].quantity=1;two.push({groupId:'box',variantId:deal.groups[0].items[1].id,quantity:1});
  const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'});
  await createBuildController(n.api,sessionApi,backend).build(deal,two,fingerprint(n.cart,session),2);
  assert.equal(n.cart.grandTotal,'29.98');assert.equal(n.cart.lineItems.reduce((n,l)=>n+l.quantity,0),8);
  assert.ok(n.cart.lineItems.some(l=>l.sku==='BOX_RED'));assert.ok(n.cart.lineItems.some(l=>l.sku==='BOX_GREEN'));
});
test('native API ignoring creation properties cannot report clean rollback',async()=>{
  const n=native({...cartFixture(),lineItems:[],grandTotal:'0.00'});
  n.api.addLineItem=async()=>{n.cart.lineItems.push(cartFixture().lineItems[0]);n.emit();throw new Error('Native add failed after changing cart');};
  await assert.rejects(createBuildController(n.api,sessionApi,backend).build(deal,choices,fingerprint(n.cart,session)),/Do not take payment/);
  assert.equal(n.cart.lineItems.length,1);assert.equal(n.removed,0);
});

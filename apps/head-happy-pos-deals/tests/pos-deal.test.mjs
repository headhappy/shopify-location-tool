import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteCart,allocateDiscount,inspectCart,appliedValid,MARKER,fingerprint} from '../../../shared/pos-deal.js';
import {createController,watchDeal} from '../extensions/head-happy-deals/src/controller.mjs';
import {quotePayload,request} from '../extensions/head-happy-deals/src/backend.mjs';
import {session,sessionApi,dealFixture,cartFixture,nativeFixture} from './fixtures.mjs';
const quoteBackend=async(_s,_p,body)=>({...quoteCart(dealFixture(),body.cart,body.session),expiresAt:Date.now()+30000});
test('every box and grinder colour matches the saved groups and yields £14.99',()=>{
 const deal=dealFixture();
 for(const box of deal.groups[0].items)for(const grinder of deal.groups[1].items){
  const cart=cartFixture();
  [box,grinder].forEach((v,i)=>Object.assign(cart.lineItems[i],{variantId:Number(v.id.split('/').pop()),productId:Number(v.productId.split('/').pop()),sku:v.sku}));
  const q=quoteCart(deal,cart,session);assert.equal(q.total,1499);assert.equal(q.saving,844);
  assert.equal(q.discounts.reduce((n,d)=>n+d.amount,0),844);
 }
});
test('multiple sets and unrelated extras get exact totals without discounting unrelated products',()=>{
 const cart=cartFixture();cart.lineItems.forEach(l=>l.quantity=2);
 cart.lineItems.push({uuid:'extra',variantId:77,productId:88,sku:'EXTRA',price:5,quantity:1,discounts:[]});
 cart.grandTotal='51.86';const q=quoteCart(dealFixture(),cart,session);
 assert.equal(q.sets,2);assert.equal(q.total,3498);assert.equal(q.saving,1688);
 assert.ok(q.discounts.every(d=>d.uuid!=='extra'));
 assert.equal(q.discounts.reduce((n,d)=>n+d.amount*cart.lineItems.find(l=>l.uuid===d.uuid).quantity,0),1688);
});
test('duplicate variant lines aggregate demand; extra units cannot become additional incomplete sets',()=>{
 const c=cartFixture();c.lineItems.push({...structuredClone(c.lineItems[0]),uuid:'other-box'});c.grandTotal='38.42';
 const q=quoteCart(dealFixture(),c,session);assert.equal(q.sets,1);assert.equal(q.total,2998);
 const d=dealFixture();d.groups[0].items[0].available=1;assert.throws(()=>quoteCart(d,c,session),/stock/);
});
test('missing groups, invalid memberships, prices, overlap, stock and nested bundles refuse',()=>{
 for(const edit of [
 c=>{c.lineItems.pop();c.grandTotal='21.14';},
 c=>{c.lineItems[1].variantId=999;},
 c=>{c.lineItems[1].price=1;c.grandTotal='20.93';},
 c=>{c.lineItems[0].quantity=0;},
 c=>{c.lineItems[0].components=[{}];},
 c=>{c.lineItems[0].discounts=[{amount:1}];},
 c=>{c.cartDiscount={amount:1};},
 c=>{c.currency='USD';},
 c=>{c.grandTotal='100';},
 ]){const c=cartFixture();edit(c);assert.throws(()=>quoteCart(dealFixture(),c,session));}
 const d=dealFixture();d.groups[1].items.push(d.groups[0].items[0]);assert.throws(()=>quoteCart(d,cartFixture(),session),/two groups/);
});
test('integer allocation never silently rounds or exceeds a unit price',()=>{
 assert.throws(()=>allocateDiscount([{uuid:'x',price:100,used:1,quantity:2}],1),/penny split/);
 for(let quantity=1;quantity<30;quantity++)for(let price=10;price<100;price+=9){
  const saving=Math.floor(price/2)*quantity;
  const ds=allocateDiscount([{uuid:'a',price,used:quantity,quantity}],saving);
  assert.equal(ds.reduce((n,d)=>n+d.amount*quantity,0),saving);assert.ok(ds.every(d=>d.amount<=price));
 }
});
test('native apply, repeat apply and remove preserve scanned product quantities',async()=>{
 const n=nativeFixture(),controller=createController(n.api,sessionApi,quoteBackend);
 const original=n.cart.lineItems.map(l=>[l.variantId,l.quantity]);
 await controller.apply(dealFixture());assert.equal(n.cart.grandTotal,'14.99');assert.ok(appliedValid(n.cart,session));
 await controller.apply(dealFixture());assert.equal(n.cart.grandTotal,'14.99');
 assert.deepEqual(n.cart.lineItems.map(l=>[l.variantId,l.quantity]),original);
 await controller.remove();assert.equal(n.cart.grandTotal,'23.43');assert.equal(n.cart.properties[MARKER],undefined);
});
test('basket edit during fetch and expired quote cannot apply a discount',async()=>{
 for(const expired of [true,false]){
 const n=nativeFixture();
 const backend=async(...args)=>{const q=await quoteBackend(...args);if(expired)q.expiresAt=0;else{n.cart.lineItems[0].quantity++;n.emit();}return q;};
 await assert.rejects(createController(n.api,sessionApi,backend).apply(dealFixture()),/changed/);
 assert.equal(n.bulkCalls,0);assert.ok(!n.cart.properties[MARKER]);
 }
});
test('partial native failure removes only this app discount and leaves unrelated metadata',async()=>{
 const n=nativeFixture();n.cart.properties.note='keep';
 n.api.bulkSetLineItemDiscounts=async(ds)=>{const d=ds[0];n.cart.lineItems.find(l=>l.uuid===d.lineItemUuid).discounts=[{discountDescription:d.lineItemDiscount.title,type:'FixedAmount',amount:Number(d.lineItemDiscount.amount)}];n.emit();throw new Error('native failure');};
 await assert.rejects(createController(n.api,sessionApi,quoteBackend).apply(dealFixture()),/removed/);
 assert.ok(n.cart.lineItems.every(l=>!l.discounts.length));assert.equal(n.cart.properties.note,'keep');
});
test('another discount is never removed and concurrent Apply clicks do not race',async()=>{
 const n=nativeFixture();n.cart.lineItems[0].discounts=[{discountDescription:'Other',type:'FixedAmount',amount:1}];n.emit();
 await assert.rejects(createController(n.api,sessionApi,quoteBackend).apply(dealFixture()),/discount/);assert.equal(n.removeCalls,0);
 const n2=nativeFixture();let release;const pending=new Promise(r=>release=r);
 const c=createController(n2.api,sessionApi,async(...args)=>{await pending;return quoteBackend(...args);});
 const p=c.apply(dealFixture());await assert.rejects(c.apply(dealFixture()),/Wait/);release();await p;assert.equal(n2.bulkCalls,1);
});
test('mounted watcher removes stale deals but accepts an unchanged payment screen',async()=>{
 const n=nativeFixture(),c=createController(n.api,sessionApi,quoteBackend);await c.apply(dealFixture());
 const messages=[],off=watchDeal(n.api,sessionApi,m=>messages.push(m),c);
 n.cart.editable=false;n.emit();await new Promise(r=>setTimeout(r,650));assert.equal(n.cart.grandTotal,'14.99');
 n.cart.editable=true;n.cart.lineItems[1].quantity++;n.emit();
 await new Promise(r=>setTimeout(r,750));off();assert.ok(!n.cart.properties[MARKER]);assert.equal(messages.length,1);
});
test('fingerprint survives serialization and payload omits customer personal details',()=>{
 const c=cartFixture();c.customer={id:123,email:'private@example.com',firstName:'Private'};
 const payload=quotePayload(dealFixture(),c,session);
 assert.deepEqual(payload.cart.customer,{id:123});assert.equal(fingerprint(payload.cart,session),fingerprint(c,session));
});
test('backend request requires native session token and never uses cookies',async()=>{
 await assert.rejects(request({getSessionToken:async()=>undefined},''),/permissions/);
 const original=globalThis.fetch;
 try{globalThis.fetch=async(url,options)=>{assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,'Bearer test');return {ok:true,json:async()=>({deals:[]})};};
 assert.deepEqual(await request({getSessionToken:async()=>'test'},''),{deals:[]});}finally{globalThis.fetch=original;}
});
test('a second mounted controller cannot clear another target\'s in-flight change',async()=>{
 const n=nativeFixture(),c=createController(n.api,sessionApi,quoteBackend);await c.apply(dealFixture());
 const m=JSON.parse(n.cart.properties[MARKER]);m.pending=true;m.owner='other-target';m.until=Date.now()+20000;
 n.cart.properties[MARKER]=JSON.stringify(m);
 await assert.rejects(createController(n.api,sessionApi,quoteBackend).remove(),/Wait/);
 assert.equal(n.removeCalls,0);assert.equal(n.cart.grandTotal,'14.99');
});

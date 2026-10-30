import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {createPosVerifier,createPosDealRouter} from '../server/pos-deal-routes.js';
import {setup,savedCrown} from './bundle-fixtures.js';
import {SHOP} from '../shared/pos-deal.js';

const config={apiKey:'test-api-key',apiSecretKey:'test-only-secret-that-is-never-a-real-credential',shop:SHOP,origin:'https://example.test'};
function token(overrides={},secret=config.apiSecretKey,algorithm='HS256') {
  const now=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify({alg:algorithm,typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({aud:config.apiKey,dest:`https://${SHOP}`,iss:`https://${SHOP}/admin`,sub:'123',iat:now,nbf:now-1,exp:now+60,...overrides})).toString('base64url');
  return header+'.'+body+'.'+createHmac('sha256',secret).update(header+'.'+body).digest('base64url');
}
test('official Shopify JWT verification rejects wrong audience/shop/issuer/signature/algorithm/time and missing claims',async()=>{
  const verify=createPosVerifier(config);assert.deepEqual(await verify(token()),{userId:'123'});
  for(const claims of [{aud:'other'},{dest:'https://other.myshopify.com'},{iss:'https://evil.example/admin'},{sub:undefined},
    {exp:0},{exp:undefined},{nbf:undefined},{iat:undefined},{nbf:9999999999},{iat:9999999999},{exp:9999999999}])
    await assert.rejects(verify(token(claims)));
  await assert.rejects(verify(token({},'wrong')));await assert.rejects(verify(token({},config.apiSecretKey,'none')));
  assert.equal(createPosVerifier({...config,apiSecretKey:''}),null);
});

async function endpoint(t,verify=createPosVerifier(config)) {
  const c=await setup(t),recipe=await savedCrown(c);
  const app=express();app.use('/api/pos-deals',createPosDealRouter({...c,verify}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/pos-deals`;
  const auth={Authorization:`Bearer ${token()}`,'Content-Type':'application/json',Origin:'https://cdn.shopify.com'};
  const rows=[201,301,401,402].map(id=>c.rows.find(v=>v.id.endsWith('/'+id)));
  const body={id:recipe.id,version:recipe.version,session:{shopDomain:SHOP,locationId:1,currency:'GBP'},cart:{
    currency:'GBP',grandTotal:'59.96',properties:{},lineItems:rows.map((v,i)=>({uuid:'line-'+i,variantId:Number(v.id.split('/').pop()),
      productId:Number(v.product.id.split('/').pop()),sku:v.sku,quantity:1,price:Number(v.price),discounts:[],taxable:true}))}};
  return {...c,url,auth,recipe,body};
}
test('POS endpoint requires its own bearer token, restricts origins and exposes only bundle names',async t=>{
  const c=await endpoint(t);
  assert.equal((await fetch(c.url)).status,401);
  assert.equal((await fetch(c.url,{headers:{Cookie:'hh_bundle_session=fake'}})).status,401);
  assert.equal((await fetch(c.url,{headers:{...c.auth,Origin:'https://evil.example'}})).status,403);
  const preflight=await fetch(c.url,{method:'OPTIONS',headers:{Origin:'https://extensions.shopifycdn.com'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://extensions.shopifycdn.com');
  const response=await fetch(c.url,{headers:c.auth});assert.equal(response.status,200);
  const data=await response.json();assert.deepEqual(Object.keys(data.deals[0]).sort(),['id','name','version']);
  assert.equal(response.headers.get('access-control-allow-credentials'),null);
});
test('POS quote uses the persisted recipe version and current family/price data without writing stock or previews',async t=>{
  const c=await endpoint(t);
  let res=await fetch(c.url+'/quote',{method:'POST',headers:c.auth,body:JSON.stringify(c.body)});
  assert.equal(res.status,200,await res.clone().text());const q=await res.json();assert.equal(q.total,1499);assert.equal(q.sets,1);
  assert.equal(q.discounts.reduce((n,d)=>n+d.amount,0),4497);
  c.body.version++;res=await fetch(c.url+'/quote',{method:'POST',headers:c.auth,body:JSON.stringify(c.body)});assert.equal(res.status,409);
  assert.deepEqual(await c.store.listPreviews(),[]);assert.ok(c.calls.every(call=>!call.query.includes('mutation')));
  assert.equal((await fetch(c.url+'/assemble',{method:'POST',headers:c.auth,body:'{}'})).status,404);
});
test('missing POS config fails closed while leaving other modules available',async t=>{
  const c=await endpoint(t,null);assert.equal((await fetch(c.url,{headers:c.auth})).status,503);
});

test('guided definitions expose eligible labels, barcode and stock without component costs',async t=>{
  const c=await endpoint(t),body={id:c.recipe.id,version:c.recipe.version,session:c.body.session};
  assert.equal((await fetch(c.url+'/definition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  const res=await fetch(c.url+'/definition',{method:'POST',headers:c.auth,body:JSON.stringify(body)});
  assert.equal(res.status,200);const definition=await res.json();assert.equal(definition.price,1499);
  assert.ok(definition.groups.length);assert.ok(definition.groups[0].items[0].sku);
  assert.ok(definition.groups.every(g=>g.items.every(v=>!('cost' in v) && !('inventoryItemId' in v))));
  body.version++;assert.equal((await fetch(c.url+'/definition',{method:'POST',headers:c.auth,body:JSON.stringify(body)})).status,409);
  assert.ok(c.calls.every(call=>!call.query.includes('mutation')));
});

test('guided quote requires a complete selection and does not trust client quantity or price',async t=>{
  const c=await endpoint(t);
  const def=await (await fetch(c.url+'/definition',{method:'POST',headers:c.auth,body:JSON.stringify(c.body)})).json();
  c.body.selections=def.groups.map(g=>({groupId:g.id,variantId:g.items.find(v=>c.body.cart.lineItems.some(l=>v.id.endsWith('/'+l.variantId))).id,quantity:g.quantity}));
  let res=await fetch(c.url+'/quote',{method:'POST',headers:c.auth,body:JSON.stringify(c.body)});assert.equal(res.status,200);
  assert.equal((await res.json()).total,1499);
  c.body.selections.pop();res=await fetch(c.url+'/quote',{method:'POST',headers:c.auth,body:JSON.stringify(c.body)});assert.equal(res.status,422);
});

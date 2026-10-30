// Browser interaction regression for the Preact flow with a simulated native cart.
// This verifies clicks and visible failures, not Shopify POS device behaviour.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import express from 'express';
import {chromium} from 'playwright';
import {build} from '../apps/head-happy-pos-deals/node_modules/esbuild/lib/main.js';

const source=`
import {dealFixture,cartFixture,nativeFixture,session} from './apps/head-happy-pos-deals/tests/fixtures.mjs';
import {quoteCart} from './shared/pos-deal.js';
import mount from './apps/head-happy-pos-deals/extensions/head-happy-deals/src/Modal.jsx';
const mode=new URLSearchParams(location.search).get('mode');
const deal=dealFixture();deal.groups.forEach(g=>g.items.forEach(v=>{v.barcode=v.sku;v.title=v.sku;v.productTitle=g.name;}));
const initial=cartFixture();if(mode!=='reuse'){initial.lineItems=[];initial.grandTotal='0.00';}
if(mode==='legacy-currency')delete initial.currency;
if(mode==='readonly')initial.editable=false;
const native=nativeFixture(initial);let added=0,scan;
native.api.addLineItem=async(id,quantity,options)=>{const v=deal.groups.flatMap(g=>g.items).find(v=>v.id.endsWith('/'+id));
const uuid='new-'+(++added);native.cart.lineItems.push({uuid,variantId:id,productId:Number(v.productId.split('/').pop()),sku:v.sku,price:Number(v.price),quantity,properties:options.properties,discounts:[],taxable:true});native.emit();return uuid;};
native.api.removeLineItem=async(id)=>{native.cart.lineItems=native.cart.lineItems.filter(l=>l.uuid!==id);native.emit();};
globalThis.shopify={cart:native.api,session:{currentSession:session,getSessionToken:async()=>'test-only'},toast:{show:m=>globalThis.lastToast=m},scanner:{
showCameraScanner:()=>{},scannerData:{current:{subscribe(fn){scan=fn;fn({data:'BOX_GREEN'});return()=>{};}}}}};
globalThis.testCart=native.cart;globalThis.scanCode=data=>scan({data});globalThis.addedCount=()=>added;
globalThis.fetch=async(url,options)=>{
if(!String(url).startsWith('https://headhappy-bundle-preview.onrender.com/api/pos-deals'))throw Error('Unexpected network request');
await new Promise(r=>setTimeout(r,15));const body=options.body ? JSON.parse(options.body) : null;
const path=String(url).split('/api/pos-deals')[1];
if(path==='/quote' && mode==='failure')return {ok:false,json:async()=>({error:'Recipe changed. Reload the deal.'})};
const data=path==='/definition' ? deal : path==='/quote' ? {...quoteCart(deal,body.cart,body.session,body.selections,body.sets),expiresAt:Date.now()+30000} : {deals:[{id:deal.id,version:deal.version,name:deal.name}]};
return {ok:true,json:async()=>data};};
class Button extends HTMLElement {get disabled(){return this.hasAttribute('disabled');}set disabled(v){this.toggleAttribute('disabled',!!v);}get loading(){return this.hasAttribute('loading');}set loading(v){this.toggleAttribute('loading',!!v);}
connectedCallback(){this.setAttribute('role','button');this.addEventListener('click',e=>{if(this.disabled || this.loading)e.stopImmediatePropagation();},true);}}
customElements.define('s-button',Button);
await mount();
`;
const compiled=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'pos-browser.jsx',loader:'jsx'},bundle:true,write:false,format:'esm',jsx:'automatic',jsxImportSource:'preact',
  nodePaths:['apps/head-happy-pos-deals/extensions/head-happy-deals/node_modules'],
  plugins:[{name:'native-preact-shim',setup(b){b.onResolve({filter:/^@shopify\/ui-extensions\/preact$/},()=>({path:'shim',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));}}]});
const app=express();app.get('/guide.js',(_q,r)=>r.type('js').send(compiled.outputFiles[0].text));
app.get('/',(_q,r)=>r.send('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{font:16px Arial;margin:20px;color:#142b25} s-page,s-stack,s-section,s-text,s-banner{display:block;margin:12px 0} s-page:before,s-section:before{content:attr(heading);font-weight:bold;font-size:22px} s-button{display:block;border:1px solid #aaa;padding:12px;margin:10px 0;cursor:pointer;border-radius:8px} s-button[disabled]{opacity:.4} s-banner{border:2px solid #ae3320;padding:12px}</style></head><body><script type="module" src="/guide.js"></script></body></html>'));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true,...(process.env.BUNDLE_BROWSER_CHANNEL ? {channel:process.env.BUNDLE_BROWSER_CHANNEL} : {})});
try {
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+server.address().port;
  for(const mode of ['empty','reuse','legacy-currency','failure','readonly']) {
    await page.goto(origin+'/?mode='+mode);
    await page.locator('s-section[heading="Choose Box"]').waitFor();
    await page.locator('s-button').filter({hasText:mode==='reuse' ? 'BOX_RED' : 'BOX_GREEN'}).click();
    await page.locator('s-section[heading="Choose Grinder"]').waitFor();
    await page.evaluate(code=>window.scanCode(code),mode==='reuse' ? 'GRINDER_RED' : 'GRINDER_GREEN');
    await page.locator('s-section[heading="Check the complete deal"]').waitFor();
    assert.match(await page.locator('body').innerText(),/Gold papers/);assert.match(await page.locator('body').innerText(),/Silver papers/);
    await page.locator('s-button').filter({hasText:'Confirm all items'}).click();
    if(mode==='failure' || mode==='readonly') {
      await page.locator('s-banner[tone="critical"]').waitFor();
      const message=await page.locator('s-banner[tone="critical"]').innerText();assert.match(message,mode==='failure' ? /Recipe changed/ : /Return to the basket/);
      assert.equal(await page.evaluate(()=>window.testCart.lineItems.length),0);
      assert.match(await page.evaluate(()=>window.lastToast),mode==='failure' ? /Recipe changed/ : /Return to the basket/);
    } else {
      await page.locator('s-section[heading="Deal price applied"]').waitFor();
      assert.equal(await page.evaluate(()=>window.testCart.grandTotal),'14.99');
      assert.equal(await page.evaluate(()=>window.testCart.lineItems.length),4);
      assert.equal(await page.evaluate(()=>window.addedCount()),mode==='reuse' ? 0 : 4);
      await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/pos-guide-'+mode+'.png',fullPage:true});
    }
  }
  assert.deepEqual(errors,[]);console.log('POS guide browser clicks, scanner choices, reused cart, price application and visible errors passed. Native POS still requires device testing.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

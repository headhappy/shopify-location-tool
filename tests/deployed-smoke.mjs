// Read-only deployment checks: never sends a location-write or clear request.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LOCATION_SCHEMA,LOCATION_FIELDS,locationKey} from '../public/location-fields.js';
const base='https://shopify-location-tool.onrender.com';
const expected=process.env.EXPECTED_COMMIT||'';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,body){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Cache-Control':'no-cache'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});
  assert.equal(response.status,200,`HTTP status for ${path.split('?')[0]}`);
  return response;
}
let health=null;
for(let attempt=0;attempt<15;attempt++){
  try{const h=await (await request('/health')).json();if(h.locationSchema===LOCATION_SCHEMA&&(!expected||h.commit===expected)){health=h;break;}}catch{}
  console.log(`Waiting for requested deployment (${attempt+1}/15).`);await pause(20000);
}
assert.ok(health,'Requested four-field release was not confirmed live.');
assert.equal(health.updaterFeatures.displaySlots,2);assert.equal(health.updaterFeatures.productLocationFallback,false);
console.log('PASS: deployed health reports two displays and variant-only ownership.');
const cameraSource=await (await request('/camera.js?scanner=1.4.1')).text();
assert.equal(cameraSource,await readFile(new URL('../public/camera.js',import.meta.url),'utf8'),'Deployed camera must match the tested source byte for byte');
assert.match(cameraSource,/CAMERA_VERSION = '1\.4\.1'/);
console.log('PASS: deployed camera helper matches the tested zero-width-preview fix byte for byte.');
for(const path of ['/','/batch-scan.html','/location-viewer.html','/label-station.html']){
  const text=await (await request(path)).text();assert.match(text,/1\.4\.0/);assert.match(text,/type="module"/);
}
for(const path of ['/location-fields.js','/product-locations.js','/batch-scan.js','/location-viewer.js','/label-station.js','/location-ui.css','/label-station-display2.css','/vendor/bwip-js/bwip-js-min.js'])assert.ok((await (await request(path)).text()).length>100);
console.log('PASS: all four pages and their JavaScript, CSS and barcode assets load.');
const lookup=await (await request('/lookup-variant',{search:'TIP_AXY'})).json();
const row=lookup.variant?lookup:lookup.variants?.find(v=>v.sku==='TIP_AXY');assert.ok(row,'Known variant read failed.');
for(const f of LOCATION_FIELDS)assert.ok(f.current in row,`Missing ${f.current}`);
console.log('PASS: real Shopify variant lookup supplies all four location fields.');
const locations=await (await request('/api/labels/locations')).json();assert.ok(Array.isArray(locations.locations));assert.equal(locations.meta.schema,LOCATION_SCHEMA);
const usable=locations.locations.find(l=>l.variantCount>0);assert.ok(usable,'No location available to verify.');
const contents=await (await request('/api/labels/location-products?location='+encodeURIComponent(usable.code))).json();
assert.ok(Array.isArray(contents.rows)&&contents.rows.length>0);assert.equal(new Set(contents.rows.map(v=>v.id)).size,contents.rows.length);
for(const v of contents.rows){for(const f of LOCATION_FIELDS)assert.ok(f.current in v);assert.ok(LOCATION_FIELDS.some(f=>locationKey(v[f.current])===locationKey(usable.code)));}
console.log('PASS: exact-location labels return unique variants with all four fields.');
const refreshed=await (await request('/api/labels/variants',{variantIds:[row.variant?.id||row.id]})).json();assert.equal(refreshed.rows.length,1);assert.ok('currentDisplayLoc2' in refreshed.rows[0]);
const stock=await (await request('/api/shopify-stock.json?search='+encodeURIComponent('sku:TIP_AXY'))).json();assert.equal(stock.meta.locationSchema,LOCATION_SCHEMA);assert.ok(stock.rows.length>0);assert.ok(stock.rows.every(v=>'DisplayLocation2' in v));
const csv=await (await request('/api/shopify-stock.csv?search='+encodeURIComponent('sku:TIP_AXY'))).text();assert.match(csv.split('\n')[0],/"Handle","DisplayLocation2"$/);
console.log('PASS: pre-print refresh and stock JSON/CSV include Display 2.');
console.log('Deployment read checks complete. No stock, locations or product values were changed.');

// Shared contract for Shopify, all location screens, labels and exports.
export const LOCATION_SCHEMA = 'variant-locations-v2-display2';
export const LOCATION_FIELDS = Object.freeze([
  {name:'display', label:'Display 1', match:'DISPLAY', namespace:'custom', key:'display_loc', alias:'displayLoc', current:'currentDisplayLoc', column:'DisplayLocation', input:'displayLoc', endpoint:'/update-display-loc', valueKey:'displayLocValue', display:true},
  {name:'display2', label:'Display 2', match:'DISPLAY2', namespace:'custom', key:'display_loc_2', alias:'displayLoc2', current:'currentDisplayLoc2', column:'DisplayLocation2', input:'displayLoc2', endpoint:'/update-display-loc-2', valueKey:'displayLoc2Value', display:true},
  {name:'location', label:'LOCATION', match:'LOCATION', namespace:'stock', key:'location', alias:'quickLoc', current:'currentLocation', column:'ShelfLocation', input:'location', endpoint:'/update-location', valueKey:'locationValue'},
  {name:'loc2', label:'LOC2', match:'LOC2', namespace:'custom', key:'location', alias:'loc2', current:'currentLoc2', column:'LOC2', input:'loc2', endpoint:'/update-loc2', valueKey:'loc2Value'}
].map(Object.freeze));
export const clean = value => String(value ?? '').trim();
export const escapeHtml = value => clean(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const isVariantId = value => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(clean(value));
export function parseDisplay(value) {
  const raw=clean(value), lod=/\(LOD\)\s*$/i.test(raw)||/^LOD$/i.test(raw);
  return {base:raw.replace(/\s*\(LOD\)\s*$/i,'').replace(/^LOD$/i,'').trim(),lod};
}
export function physicalLocation(value) {
  const base=parseDisplay(value).base.replace(/\s+/g,' ');
  return /^(?:0|-|n\/?a|none|null|blank)$/i.test(base) ? '' : base;
}
export const locationKey = value => physicalLocation(value).toLowerCase();
export function displayValue(base,lod) {
  const value=parseDisplay(base).base;
  if(lod&&!value) throw new Error('Enter the physical display position before selecting LOD.');
  return value && lod ? `${value} (LOD)` : value;
}
export function normaliseLookupRow(row,envelope={}) {
  const product=envelope.product||{};
  const result={id:clean(row.id||row.variantId),productId:clean(row.productId||product.id),productTitle:clean(row.productTitle||envelope.productTitle||row.product_title||'Product'),variantTitle:clean(row.variantTitle??row.variant_title??row.title).replace(/^Default Title$/i,''),sku:clean(row.sku),barcode:clean(row.barcode),stock:Number(row.stock??row.inventoryQuantity??envelope.stock??0),price:clean(row.price??envelope.price),handle:clean(row.handle||envelope.handle||product.handle)};
  for(const f of LOCATION_FIELDS) result[f.current]=clean(row[f.current]??row[f.alias]??envelope[f.current]);
  return result;
}
export function lookupRows(data) {
  return Array.isArray(data?.variants) ? data.variants.map(v=>normaliseLookupRow(v,data)) : data?.variant ? [normaliseLookupRow(data.variant,data)] : [];
}
export async function jsonRequest(url,body,options={}) {
  const response=await fetch(url,{...options,method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.success===false) throw new Error(data?.detail||data?.error||`Request failed (${response.status}).`);
  return data;
}

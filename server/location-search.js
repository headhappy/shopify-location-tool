import { LOCATION_FIELDS, LOCATION_SCHEMA, clean, locationKey, physicalLocation, parseDisplay } from '../public/location-fields.js';
export const VARIANT_FIELDS = `id title sku barcode price inventoryQuantity
 ${LOCATION_FIELDS.map(f=>`${f.alias}:metafield(namespace:"${f.namespace}",key:"${f.key}"){value}`).join('\n')}
 product{id title handle vendor status}`;
let cache={expiresAt:0,rows:[]}, pending=null, revision=0;
export function locationRow(v,p=v.product||{}) {
  const variantTitle=v.title&&v.title!=='Default Title'?v.title:'';
  const row={id:v.id||'',productId:p.id||'',sku:v.sku||'',barcode:v.barcode||'',productTitle:p.title||'',variantTitle,title:variantTitle?`${p.title||''} – ${variantTitle}`:(p.title||v.sku||v.barcode||'Variant'),price:v.price||'',stock:Number(v.inventoryQuantity??0),handle:p.handle||'',vendor:p.vendor||'',productStatus:p.status||''};
  for(const f of LOCATION_FIELDS) row[f.current]=v[f.alias]?.value||'';
  return row;
}
const norm=v=>clean(v).toLowerCase();
function barcodeCandidates(term){const raw=clean(term),set=new Set([raw]);if(/^\d+$/.test(raw)){const n=raw.replace(/^0+/,'');if(n)set.add(n);set.add(`0${n||raw}`);}return [...set];}
export function expireLocationSearchCache(){cache={expiresAt:0,rows:[]};revision++;pending=null;}
async function catalog(graph){
  if(cache.expiresAt>Date.now())return cache.rows;
  if(pending)return pending;
  const started=revision;
  const work=(async()=>{const rows=[];let after=null,pages=0;do{const data=await graph(`query LocationCatalog($first:Int!,$after:String){productVariants(first:$first,after:$after,sortKey:TITLE){pageInfo{hasNextPage endCursor}nodes{${VARIANT_FIELDS}}}}`,{first:100,after});const c=data.productVariants;if(!c?.pageInfo||!Array.isArray(c.nodes))throw new Error('Incomplete Shopify location catalogue response.');rows.push(...c.nodes.map(v=>locationRow(v)));const next=c.pageInfo.hasNextPage?c.pageInfo.endCursor:null;if(c.pageInfo.hasNextPage&&(!next||next===after))throw new Error('Location catalogue pagination did not advance.');after=next;if(++pages>200)throw new Error('Location catalogue pagination safety stop.');}while(after);if(started===revision)cache={expiresAt:Date.now()+600000,rows};return rows;})();
  pending=work;try{return await work;}finally{if(pending===work)pending=null;}
}
export async function findLocationMatches(graph,term){
  const raw=clean(term);if(!raw)return {mode:'empty',hits:[]};
  const candidates=barcodeCandidates(raw),escaped=x=>x.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const q=candidates.flatMap(x=>[`barcode:"${escaped(x)}"`,`sku:"${escaped(x)}"`]).join(' OR ');
  const data=await graph(`query ExactLocationProduct($q:String!){productVariants(first:50,query:$q){pageInfo{hasNextPage endCursor}nodes{${VARIANT_FIELDS}}}}`,{q});
  const needles=new Set(candidates.map(norm));
  const exact=(data.productVariants?.nodes||[]).map(v=>locationRow(v)).filter(v=>norm(v.sku)===norm(raw)||needles.has(norm(v.barcode)));
  if(exact.length&&!data.productVariants?.pageInfo?.hasNextPage)return {mode:'barcode_or_sku_normalised',hits:exact};
  const needle=norm(raw),all=await catalog(graph);
  const exactAll=all.filter(v=>norm(v.sku)===needle||needles.has(norm(v.barcode)));
  if(exactAll.length)return {mode:'barcode_or_sku_normalised',hits:exactAll};
  const hits=all.filter(v=>[v.productTitle,v.variantTitle,v.sku].some(x=>norm(x).includes(needle)));
  return {mode:'catalog_normalised',hits:hits.slice(0,250),truncated:hits.length>250};
}
export async function labelVariants(graph,ids){
  const data=await graph(`query LabelVariants($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{${VARIANT_FIELDS}}}}`,{ids});
  if(!Array.isArray(data.nodes))throw new Error('Incomplete Shopify variant response.');
  return data.nodes.filter(Boolean).map(v=>locationRow(v));
}
async function contents(graph,term,exact){
  const target=locationKey(term);let rows=[];
  if(target)rows=(await catalog(graph)).map(v=>{
    if(exact&&v.productStatus&&v.productStatus!=='ACTIVE')return null;
    const matches=LOCATION_FIELDS.filter(f=>{const key=locationKey(v[f.current]);return key&&(exact?key===target:key.includes(target));}).map(f=>f.match);
    const lod1=parseDisplay(v.currentDisplayLoc).lod,lod2=parseDisplay(v.currentDisplayLoc2).lod;
    return matches.length?{...v,matches,lod:lod1||lod2,lod1,lod2}:null;
  }).filter(Boolean);
  rows.sort((a,b)=>`${a.productTitle} ${a.variantTitle} ${a.sku}`.localeCompare(`${b.productTitle} ${b.variantTitle} ${b.sku}`));
  return {schema:LOCATION_SCHEMA,location:clean(term),mode:exact?'location_exact':'location_contains',count:rows.length,stockTotal:rows.reduce((n,v)=>n+v.stock,0),lodCount:rows.filter(v=>v.lod).length,lod1Count:rows.filter(v=>v.lod1).length,lod2Count:rows.filter(v=>v.lod2).length,rows};
}
export const findLocationContents=(graph,term)=>contents(graph,term,false);
export const findExactLocationContents=(graph,term)=>contents(graph,term,true);
export async function listLocationLabels(graph){
  const locations=new Map(),order=LOCATION_FIELDS.map(f=>f.match);
  for(const row of await catalog(graph)){
    if(row.productStatus&&row.productStatus!=='ACTIVE')continue;
    for(const f of LOCATION_FIELDS){const code=physicalLocation(row[f.current]);if(!code)continue;const key=locationKey(code);if(!locations.has(key))locations.set(key,{code,types:new Set(),products:new Set(),variants:new Map()});const e=locations.get(key);e.types.add(f.match);if(row.productId)e.products.add(row.productId);if(row.id)e.variants.set(row.id,row.stock);}
  }
  const rows=[...locations.values()].map(e=>({code:e.code,types:[...e.types].sort((a,b)=>order.indexOf(a)-order.indexOf(b)),productCount:e.products.size,variantCount:e.variants.size,stockTotal:[...e.variants.values()].reduce((n,v)=>n+v,0)})).sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true,sensitivity:'base'}));
  return {meta:{schema:LOCATION_SCHEMA,generatedAt:new Date().toISOString(),locationCount:rows.length,source:'cached_location_catalog'},locations:rows};
}

import { normalise } from "./shopify-client.js";

let cache={ expiresAt:0,rows:[] };

function row(variant,product=variant.product||{}){
  const variantTitle=variant.title && variant.title!=="Default Title" ? variant.title : "";
  return {
    id:variant.id||"", productId:product.id||"", sku:variant.sku||"", barcode:variant.barcode||"",
    productTitle:product.title||"", variantTitle,
    title:variantTitle ? `${product.title||""} – ${variantTitle}` : (product.title||variant.sku||variant.barcode||"Variant"),
    price:variant.price||"", stock:Number(variant.inventoryQuantity ?? 0),
    handle:product.handle||"", vendor:product.vendor||"", productStatus:product.status||"",
    currentDisplayLoc:product.displayLoc?.value||"", currentLocation:variant.quickLoc?.value||"", currentLoc2:product.loc2?.value||"",
  };
}

const fields=`
  id title sku barcode price inventoryQuantity
  quickLoc: metafield(namespace:"stock",key:"location") { value }
  product {
    id title handle vendor status
    displayLoc: metafield(namespace:"custom",key:"display_loc") { value }
    loc2: metafield(namespace:"custom",key:"location") { value }
  }`;

function escaped(value){ return String(value||"").trim().replace(/\\/g,"\\\\").replace(/"/g,'\\"'); }

function barcodeCandidates(term){
  const raw=String(term||"").trim();
  const candidates=new Set([raw]);
  if(/^\d+$/.test(raw)){
    const withoutLeadingZero=raw.replace(/^0+/,"");
    if(withoutLeadingZero) candidates.add(withoutLeadingZero);
    candidates.add(`0${withoutLeadingZero || raw}`);
  }
  return [...candidates].filter(Boolean);
}

function locationKey(value){
  return normalise(String(value||"").replace(/\s*\(LOD\)\s*$/i,"").replace(/\s+/g," "));
}

function physicalLocation(value){
  const code=String(value||"").replace(/\s*\(LOD\)\s*$/i,"").replace(/\s+/g," ").trim();
  if(!code || /^(?:0|-|n\/?a|none|null|blank|lod)$/i.test(code)) return "";
  return code;
}

function locationMatches(value,target){
  const key=locationKey(value);
  return !!key && !!target && key.includes(target);
}

function hasLod(value){
  const raw=String(value||"").trim();
  return /^LOD$/i.test(raw) || /\(LOD\)\s*$/i.test(raw);
}

async function exact(shopifyGraph,term){
  const query=`query($q:String!){productVariants(first:50,query:$q){nodes{${fields}}}}`;
  const candidates=barcodeCandidates(term);
  const q=candidates.flatMap(code=>[`barcode:"${escaped(code)}"`,`sku:"${escaped(code)}"`]).join(" OR ");
  const data=await shopifyGraph(query,{q});
  return (data.productVariants?.nodes||[]).map(item=>row(item));
}

async function indexed(shopifyGraph,term){
  const query=`query($q:String!){products(first:50,query:$q,sortKey:TITLE){nodes{id title handle vendor status displayLoc:metafield(namespace:"custom",key:"display_loc"){value} loc2:metafield(namespace:"custom",key:"location"){value} variants(first:100){nodes{id title sku barcode price inventoryQuantity quickLoc:metafield(namespace:"stock",key:"location"){value}}}}}}`;
  const data=await shopifyGraph(query,{q:String(term).trim()});
  const needle=normalise(term);
  return (data.products?.nodes||[]).filter(product=>normalise(product.title).includes(needle)).flatMap(product=>(product.variants?.nodes||[]).map(variant=>row(variant,product)));
}

async function catalog(shopifyGraph){
  if(cache.expiresAt>Date.now() && cache.rows.length) return cache.rows;
  const query=`query($first:Int!,$after:String){productVariants(first:$first,after:$after,sortKey:TITLE){pageInfo{hasNextPage endCursor}nodes{${fields}}}}`;
  const rows=[];
  let after=null,pages=0;
  do{
    pages+=1;
    const data=await shopifyGraph(query,{first:250,after});
    const connection=data.productVariants;
    rows.push(...(connection.nodes||[]).map(item=>row(item)));
    after=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;
    if(pages>200) throw new Error("Search catalog pagination safety stop");
  }while(after);
  cache={expiresAt:Date.now()+600000,rows};
  return rows;
}

export function expireLocationSearchCache(){ cache.expiresAt=0; }

export async function findLocationMatches(shopifyGraph,term){
  const exactRows=await exact(shopifyGraph,term);
  if(exactRows.length) return {mode:"barcode_or_sku_normalised",hits:exactRows};

  const indexedRows=await indexed(shopifyGraph,term);
  if(indexedRows.length) return {mode:"product_name_contains",hits:indexedRows};

  const needle=normalise(term);
  const barcodeNeedles=new Set(barcodeCandidates(term).map(normalise));
  const fallback=(await catalog(shopifyGraph)).filter(item=>
    normalise(item.productTitle).includes(needle) ||
    normalise(item.variantTitle).includes(needle) ||
    normalise(item.sku).includes(needle) ||
    barcodeNeedles.has(normalise(item.barcode))
  );
  return {mode:"catalog_normalised",hits:fallback.slice(0,250)};
}

export async function findLocationContents(shopifyGraph,locationTerm){
  const target=locationKey(locationTerm);
  if(!target) return {location:String(locationTerm||""),count:0,rows:[],stockTotal:0};

  const rows=(await catalog(shopifyGraph)).map(item=>{
    const matches=[];
    if(locationMatches(item.currentDisplayLoc,target)) matches.push("DISPLAY");
    if(locationMatches(item.currentLocation,target)) matches.push("LOCATION");
    if(locationMatches(item.currentLoc2,target)) matches.push("LOC2");
    return {...item,matches,lod:hasLod(item.currentDisplayLoc)};
  }).filter(item=>item.matches.length);

  rows.sort((a,b)=>`${a.productTitle} ${a.variantTitle} ${a.sku}`.localeCompare(`${b.productTitle} ${b.variantTitle} ${b.sku}`));

  return {
    location:String(locationTerm||"").trim(),
    mode:"location_contains",
    count:rows.length,
    stockTotal:rows.reduce((sum,item)=>sum+Number(item.stock||0),0),
    lodCount:rows.filter(item=>item.lod).length,
    rows
  };
}

export async function findExactLocationContents(shopifyGraph,locationTerm){
  const target=locationKey(locationTerm);
  if(!target) return {location:String(locationTerm||""),count:0,rows:[],stockTotal:0,lodCount:0};

  const rows=(await catalog(shopifyGraph)).map(item=>{
    if(item.productStatus && item.productStatus!=="ACTIVE") return null;
    const matches=[];
    if(locationKey(item.currentDisplayLoc)===target) matches.push("DISPLAY");
    if(locationKey(item.currentLocation)===target) matches.push("LOCATION");
    if(locationKey(item.currentLoc2)===target) matches.push("LOC2");
    return matches.length ? {...item,matches,lod:hasLod(item.currentDisplayLoc)} : null;
  }).filter(Boolean);

  rows.sort((a,b)=>`${a.productTitle} ${a.variantTitle} ${a.sku}`.localeCompare(`${b.productTitle} ${b.variantTitle} ${b.sku}`));

  return {
    location:String(locationTerm||"").trim(),
    mode:"location_exact",
    count:rows.length,
    stockTotal:rows.reduce((sum,item)=>sum+Number(item.stock||0),0),
    lodCount:rows.filter(item=>item.lod).length,
    rows
  };
}

export async function listLocationLabels(shopifyGraph){
  const locations=new Map();
  const typeOrder=["DISPLAY","LOCATION","LOC2"];

  const add=(rawCode,type,item)=>{
    const code=physicalLocation(rawCode);
    if(!code) return;
    const key=normalise(code);
    if(!locations.has(key)) locations.set(key,{code,types:new Set(),productIds:new Set(),variants:new Map()});
    const entry=locations.get(key);
    entry.types.add(type);
    if(item.productId) entry.productIds.add(item.productId);
    if(item.id) entry.variants.set(item.id,Number(item.stock||0));
  };

  for(const item of await catalog(shopifyGraph)){
    if(item.productStatus && item.productStatus!=="ACTIVE") continue;
    add(item.currentDisplayLoc,"DISPLAY",item);
    add(item.currentLocation,"LOCATION",item);
    add(item.currentLoc2,"LOC2",item);
  }

  const rows=[...locations.values()].map(entry=>({
    code:entry.code,
    types:[...entry.types].sort((a,b)=>typeOrder.indexOf(a)-typeOrder.indexOf(b)),
    productCount:entry.productIds.size,
    variantCount:entry.variants.size,
    stockTotal:[...entry.variants.values()].reduce((sum,stock)=>sum+stock,0),
  })).sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true,sensitivity:"base"}));

  return {
    meta:{generatedAt:new Date().toISOString(),locationCount:rows.length,source:"cached_location_catalog"},
    locations:rows,
  };
}

import { normalise } from "./shopify-client.js";

let cache={ expiresAt:0,rows:[] };

function row(variant,product=variant.product||{}){
  const variantTitle=variant.title && variant.title!=="Default Title" ? variant.title : "";
  return {
    id:variant.id||"", productId:product.id||"", sku:variant.sku||"", barcode:variant.barcode||"",
    productTitle:product.title||"", variantTitle,
    title:variantTitle ? `${product.title||""} – ${variantTitle}` : (product.title||variant.sku||variant.barcode||"Variant"),
    currentDisplayLoc:product.displayLoc?.value||"", currentLocation:variant.quickLoc?.value||"", currentLoc2:product.loc2?.value||"",
  };
}

const fields=`
  id title sku barcode
  quickLoc: metafield(namespace:"stock",key:"location") { value }
  product {
    id title
    displayLoc: metafield(namespace:"custom",key:"display_loc") { value }
    loc2: metafield(namespace:"custom",key:"location") { value }
  }`;

function escaped(value){ return String(value||"").trim().replace(/\\/g,"\\\\").replace(/"/g,'\\"'); }

async function exact(shopifyGraph,term){
  const query=`query($q:String!){productVariants(first:50,query:$q){nodes{${fields}}}}`;
  const data=await shopifyGraph(query,{q:`barcode:"${escaped(term)}" OR sku:"${escaped(term)}"`});
  return (data.productVariants?.nodes||[]).map(item=>row(item));
}

async function indexed(shopifyGraph,term){
  const query=`query($q:String!){products(first:50,query:$q,sortKey:TITLE){nodes{id title displayLoc:metafield(namespace:"custom",key:"display_loc"){value} loc2:metafield(namespace:"custom",key:"location"){value} variants(first:100){nodes{id title sku barcode quickLoc:metafield(namespace:"stock",key:"location"){value}}}}}}`;
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
  if(exactRows.length) return {mode:"barcode_or_sku",hits:exactRows};
  const indexedRows=await indexed(shopifyGraph,term);
  if(indexedRows.length) return {mode:"product_name_contains",hits:indexedRows};
  const needle=normalise(term);
  const fallback=(await catalog(shopifyGraph)).filter(item=>normalise(item.productTitle).includes(needle));
  return {mode:"product_name_contains_catalog",hits:fallback.slice(0,250)};
}

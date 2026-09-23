import { normalise, sendCsv } from './shopify-client.js';
import { LOCATION_FIELDS, LOCATION_SCHEMA } from '../public/location-fields.js';
// Append the new column; existing CSV column positions stay unchanged.
export const STOCK_COLUMNS=['Product','Variant','SKU','Barcode','Vendor','Tags','ProductStatus','Tracked','Available','DisplayLocation','ShelfLocation','LOC2','Location','LocationId','InventoryItemId','VariantId','ProductId','Price','Handle','DisplayLocation2'];
const fields=`id title sku barcode price inventoryQuantity
${LOCATION_FIELDS.map(f=>`${f.alias}:metafield(namespace:"${f.namespace}",key:"${f.key}"){value}`).join('\n')}
product{id title handle vendor status tags}`;
export const STOCK_QUERY=`query StockRows($first:Int!,$after:String,$query:String){productVariants(first:$first,after:$after,query:$query){pageInfo{hasNextPage endCursor}nodes{${fields}}}}`;
export const STOCK_BY_LOCATION_QUERY=`query StockRowsByLocation($first:Int!,$after:String,$query:String){productVariants(first:$first,after:$after,query:$query){pageInfo{hasNextPage endCursor}nodes{${fields} inventoryItem{id tracked inventoryLevels(first:50){nodes{id quantities(names:["available"]){name quantity}location{id name}}}}}}}`;
export function baseRow(v,p=v.product||{}){const row={Product:p.title||'',Variant:v.title==='Default Title'?'':v.title||'',SKU:v.sku||'',Barcode:v.barcode||'',Vendor:p.vendor||'',Tags:(p.tags||[]).join('|'),ProductStatus:p.status||'',VariantId:v.id||'',ProductId:p.id||'',Price:v.price||'',Handle:p.handle||''};for(const f of LOCATION_FIELDS)row[f.column]=v[f.alias]?.value||'';return row;}
function filterRows(rows,q){const sku=normalise(q.skuContains),product=normalise(q.productContains),inStock=q.inStockOnly==='1'||q.inStockOnly==='true';return rows.filter(r=>(!sku||normalise(r.SKU).includes(sku))&&(!product||normalise(r.Product).includes(product))&&(!inStock||Number(r.Available)>0));}
export async function stockRows(graph,options={},byLocation=false){
  const rows=[];let after=null,pages=0;
  do{const data=await graph(byLocation?STOCK_BY_LOCATION_QUERY:STOCK_QUERY,{first:100,after,query:options.search||null}),c=data.productVariants;if(!c?.pageInfo||!Array.isArray(c.nodes))throw new Error('Incomplete stock export response.');
    for(const v of c.nodes){const p=v.product||{},tags=p.tags||[];if(options.status&&options.status!=='ALL'&&p.status!==options.status)continue;if(options.tag&&!tags.some(t=>normalise(t)===normalise(options.tag)))continue;if(options.vendor&&normalise(p.vendor)!==normalise(options.vendor))continue;const common=baseRow(v,p);
      if(!byLocation)rows.push({...common,Tracked:'',Available:Number(v.inventoryQuantity??0),Location:'TOTAL',LocationId:'',InventoryItemId:''});
      else for(const level of v.inventoryItem?.inventoryLevels?.nodes||[]){if(options.locationId&&level.location?.id!==options.locationId)continue;rows.push({...common,Tracked:v.inventoryItem?.tracked?'TRUE':'FALSE',Available:Number((level.quantities||[]).find(q=>q.name==='available')?.quantity??0),Location:level.location?.name||'',LocationId:level.location?.id||'',InventoryItemId:v.inventoryItem?.id||''});}
    }
    const next=c.pageInfo.hasNextPage?c.pageInfo.endCursor:null;if(c.pageInfo.hasNextPage&&(!next||next===after))throw new Error('Stock pagination did not advance.');after=next;if(++pages>200)throw new Error('Stock pagination safety stop.');
  }while(after);return rows;
}
export function registerStockRoutes(app,{shopifyGraph,shop,apiVersion}){
  app.get('/api/locations',async(_req,res)=>{try{const data=await shopifyGraph(`query{locations(first:100){nodes{id name isActive}}}`);res.json({locations:data.locations.nodes||[]});}catch(e){res.status(500).json({error:'Location lookup failed',detail:e.message});}});
  for(const format of ['json','csv'])for(const byLocation of [false,true]){
    const stem=byLocation?'shopify-stock-by-location':'shopify-stock';
    app.get(`/api/${stem}.${format}`,async(req,res)=>{try{const q=req.query||{},rows=filterRows(await stockRows(shopifyGraph,{search:q.search||'',tag:q.tag||'',vendor:q.vendor||'',locationId:q.locationId||'',status:q.status||'ACTIVE'},byLocation),q);if(format==='csv')return sendCsv(res,`${stem}.csv`,rows,STOCK_COLUMNS);res.json({meta:{app:'Head Happy Stock Control + Locations',mode:byLocation?'BY_LOCATION':'TOTAL_INVENTORY_QUANTITY',shop,apiVersion,locationSchema:LOCATION_SCHEMA,generatedAt:new Date().toISOString(),rowCount:rows.length,filters:q},rows});}catch(e){res.status(500).json({error:'Stock export failed',detail:e.message});}});
  }
}

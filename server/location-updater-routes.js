import { setTextMetafield } from './shopify-client.js';
import { LOCATION_FIELDS, LOCATION_SCHEMA, clean, isVariantId, physicalLocation } from '../public/location-fields.js';
import { expireLocationSearchCache, findLocationMatches, findLocationContents, findExactLocationContents, listLocationLabels, labelVariants } from './location-search.js';
export function registerLocationUpdaterRoutes(app,{shopifyGraph}){
  const error=(res,label,e)=>res.status(500).json({error:label,detail:e.message});
  const noCache=res=>res.setHeader('Cache-Control','no-store');
  app.post('/lookup-variant',async(req,res)=>{
    noCache(res);const search=clean(req.body?.search??req.body?.barcode);if(!search)return res.status(400).json({error:'Barcode, SKU or product name required.'});
    try{const result=await findLocationMatches(shopifyGraph,search);if(!result.hits.length)return res.status(404).json({error:'No product or variant matches.'});const common={schema:LOCATION_SCHEMA,searchMode:result.mode,matchedBy:result.mode,truncated:!!result.truncated};if(result.hits.length!==1)return res.json({...common,variants:result.hits});const v=result.hits[0];res.json({...common,...v,variant:{id:v.id,sku:v.sku,barcode:v.barcode,title:v.variantTitle,price:v.price,inventoryQuantity:v.stock,stock:v.stock},product:{id:v.productId,handle:v.handle,vendor:v.vendor,status:v.productStatus}});}catch(e){error(res,'Lookup failed',e);}
  });
  app.get('/api/labels/locations',async(req,res)=>{noCache(res);try{if(req.query?.refresh==='1')expireLocationSearchCache();res.json(await listLocationLabels(shopifyGraph));}catch(e){error(res,'Label location list failed',e);}});
  app.get('/api/labels/location-products',async(req,res)=>{noCache(res);const location=clean(req.query?.location??req.query?.search);if(!physicalLocation(location))return res.status(400).json({error:'Physical location code required.'});try{res.json(await findExactLocationContents(shopifyGraph,location));}catch(e){error(res,'Location product list failed',e);}});
  app.post('/api/labels/variants',async(req,res)=>{
    noCache(res);const ids=req.body?.variantIds;if(!Array.isArray(ids)||!ids.length||ids.length>100||!ids.every(isVariantId))return res.status(400).json({error:'Provide 1–100 Shopify variant IDs.'});
    try{res.json({schema:LOCATION_SCHEMA,rows:await labelVariants(shopifyGraph,[...new Set(ids)])});}catch(e){error(res,'Label refresh failed',e);}
  });
  const lookupLocation=async(req,res)=>{noCache(res);const location=clean(req.body?.location??req.body?.search??req.query?.location??req.query?.search);if(!location)return res.status(400).json({error:'Location code required.'});try{res.json(await findLocationContents(shopifyGraph,location));}catch(e){error(res,'Location lookup failed',e);}};
  app.post('/lookup-location',lookupLocation);app.get('/api/location-contents',lookupLocation);
  for(const field of LOCATION_FIELDS){
    const save=async(req,res)=>{
      noCache(res);const id=req.body?.variantId;let raw=req.body?.[field.valueKey];if(field.name==='display')raw??=req.body?.displayLocationValue;
      if(!isVariantId(id))return res.status(400).json({error:'A Shopify ProductVariant ID is required. Refresh the app; product-level location writes are disabled.'});
      if(typeof raw!=='string'||!clean(raw))return res.status(400).json({error:'Blank locations are protected. Use the explicit Clear button.'});
      const value=clean(raw);if(/[\r\n]/.test(value)||value.length>255)return res.status(400).json({error:'Use a single-line location of up to 255 characters.'});
      if(field.display&&!physicalLocation(value))return res.status(400).json({error:'Enter a physical display position; LOD alone is not a location.'});
      try{await setTextMetafield(shopifyGraph,id,field.namespace,field.key,value);expireLocationSearchCache();res.json({success:true,schema:LOCATION_SCHEMA,variantId:id,field:field.name,value});}catch(e){error(res,`${field.label} save failed`,e);}
    };
    app.post(field.endpoint,save);if(field.name==='display')app.post('/update-display-location',save);
  }
  app.post('/clear-variant-location',async(req,res)=>{
    const id=req.body?.variantId,field=LOCATION_FIELDS.find(f=>f.name===req.body?.field);
    if(!isVariantId(id)||!field||req.body?.confirmClear!==true)return res.status(400).json({error:'Variant ID, supported field and explicit clear confirmation required.'});
    try{const data=await shopifyGraph(`mutation ClearVariantLocation($metafields:[MetafieldIdentifierInput!]!){metafieldsDelete(metafields:$metafields){deletedMetafields{ownerId namespace key}userErrors{field message}}}`,{metafields:[{ownerId:id,namespace:field.namespace,key:field.key}]});if(!data.metafieldsDelete)throw new Error('Shopify returned no clear result.');if(data.metafieldsDelete.userErrors?.length)throw new Error(data.metafieldsDelete.userErrors[0].message);expireLocationSearchCache();res.json({success:true,variantId:id,field:field.name,value:''});}catch(e){error(res,'Clear failed',e);}
  });
}

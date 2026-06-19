import { setTextMetafield } from "./shopify-client.js";
import { expireLocationSearchCache, findLocationMatches } from "./location-search.js";

export function registerLocationUpdaterRoutes(app,{shopifyGraph}){
  app.post("/lookup-variant",async(req,res)=>{
    const search=String(req.body?.search ?? req.body?.barcode ?? "").trim();
    if(!search) return res.status(400).json({error:"Barcode, SKU, or product name required"});
    try{
      const result=await findLocationMatches(shopifyGraph,search);
      if(!result.hits.length) return res.status(404).json({error:"No product or variant matches"});
      if(result.hits.length===1){
        const v=result.hits[0];
        return res.json({searchMode:result.mode,variant:{id:v.id,sku:v.sku,barcode:v.barcode,title:v.variantTitle},product:{id:v.productId},productTitle:v.productTitle,currentDisplayLoc:v.currentDisplayLoc,currentLocation:v.currentLocation,currentLoc2:v.currentLoc2});
      }
      res.json({searchMode:result.mode,variants:result.hits});
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Lookup failed",detail:error.message});
    }
  });

  app.post("/update-display-location",async(req,res)=>{
    const {productId,displayLocationValue}=req.body;
    if(!productId || displayLocationValue===undefined) return res.status(400).json({error:"productId & displayLocationValue required"});
    try{await setTextMetafield(shopifyGraph,productId,"custom","display_loc",displayLocationValue);expireLocationSearchCache();res.json({success:true});}
    catch(error){res.status(500).json({error:"Display LOC save failed",detail:error.message});}
  });

  app.post("/update-location",async(req,res)=>{
    const {variantId,locationValue}=req.body;
    if(!variantId || locationValue===undefined) return res.status(400).json({error:"variantId & locationValue required"});
    try{await setTextMetafield(shopifyGraph,variantId,"stock","location",locationValue);expireLocationSearchCache();res.json({success:true});}
    catch(error){res.status(500).json({error:"LOCATION save failed",detail:error.message});}
  });

  app.post("/update-loc2",async(req,res)=>{
    const {productId,loc2Value}=req.body;
    if(!productId || loc2Value===undefined) return res.status(400).json({error:"productId & loc2Value required"});
    try{await setTextMetafield(shopifyGraph,productId,"custom","location",loc2Value);expireLocationSearchCache();res.json({success:true});}
    catch(error){res.status(500).json({error:"LOC2 save failed",detail:error.message});}
  });
}

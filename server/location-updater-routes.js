import { setTextMetafield } from "./shopify-client.js";
import { expireLocationSearchCache, findLocationContents, findLocationMatches, listLocationLabels } from "./location-search.js";

export function registerLocationUpdaterRoutes(app,{shopifyGraph}){
  app.post("/lookup-variant",async(req,res)=>{
    const search=String(req.body?.search ?? req.body?.barcode ?? "").trim();
    if(!search) return res.status(400).json({error:"Barcode, SKU, or product name required"});
    try{
      const result=await findLocationMatches(shopifyGraph,search);
      if(!result.hits.length) return res.status(404).json({error:"No product or variant matches"});
      if(result.hits.length===1){
        const v=result.hits[0];
        return res.json({
          searchMode:result.mode,
          matchedBy:result.mode,
          variant:{id:v.id,sku:v.sku,barcode:v.barcode,title:v.variantTitle,price:v.price,inventoryQuantity:v.stock,stock:v.stock},
          product:{id:v.productId,handle:v.handle,vendor:v.vendor,status:v.productStatus},
          productTitle:v.productTitle,
          price:v.price,
          stock:v.stock,
          handle:v.handle,
          vendor:v.vendor,
          productStatus:v.productStatus,
          currentDisplayLoc:v.currentDisplayLoc,
          currentLocation:v.currentLocation,
          currentLoc2:v.currentLoc2
        });
      }
      res.json({searchMode:result.mode,matchedBy:result.mode,variants:result.hits});
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Lookup failed",detail:error.message});
    }
  });

  app.get("/api/labels/locations",async(_req,res)=>{
    try{
      res.json(await listLocationLabels(shopifyGraph));
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Label location list failed",detail:error.message});
    }
  });

  app.post("/lookup-location",async(req,res)=>{
    const location=String(req.body?.location ?? req.body?.search ?? "").trim();
    if(!location) return res.status(400).json({error:"Location code required"});
    try{
      res.json(await findLocationContents(shopifyGraph,location));
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Location lookup failed",detail:error.message});
    }
  });

  app.get("/api/location-contents",async(req,res)=>{
    const location=String(req.query?.location ?? req.query?.search ?? "").trim();
    if(!location) return res.status(400).json({error:"Location code required"});
    try{
      res.json(await findLocationContents(shopifyGraph,location));
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Location lookup failed",detail:error.message});
    }
  });

  const saveDisplayLocation=async(req,res)=>{
    const productId=req.body?.productId;
    const displayLocationValue=req.body?.displayLocationValue ?? req.body?.displayLocValue;
    if(!productId || displayLocationValue===undefined) return res.status(400).json({error:"productId and display location value required"});
    try{
      await setTextMetafield(shopifyGraph,productId,"custom","display_loc",displayLocationValue);
      expireLocationSearchCache();
      res.json({success:true,value:displayLocationValue});
    }catch(error){
      console.error(error);
      res.status(500).json({error:"Display LOC save failed",detail:error.message});
    }
  };

  app.post("/update-display-location",saveDisplayLocation);
  app.post("/update-display-loc",saveDisplayLocation);

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

import fetch from "node-fetch";
export function createShopifyGraph({shop,token,apiVersion,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  return async function shopifyGraph(query,variables={}){
    const readOnly=!/\bmutation\b/.test(query);
    for(let attempt=0;attempt<5;attempt++){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let response,payload;
      try{response=await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query,variables}),signal:controller.signal});payload=await response.json();}
      catch(e){if(!readOnly||attempt===4)throw e;await sleep(Math.min(8000,500*2**attempt));continue;}
      finally{clearTimeout(timer);}
      const throttled=payload.errors?.some(e=>e.extensions?.code==='THROTTLED');
      if(attempt<4&&(throttled||(readOnly&&[429,500,502,503,504].includes(response.status)))){
        const cost=payload.extensions?.cost,t=cost?.throttleStatus,wait=t?.restoreRate?Math.ceil(Math.max(0,(cost.requestedQueryCost||100)-(t.currentlyAvailable||0))/t.restoreRate*1000)+300:500*2**attempt;
        await sleep(Math.min(15000,Math.max(500,wait)));continue;
      }
      if(!response.ok)throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload.errors||payload)}`);
      if(payload.errors?.length)throw new Error(JSON.stringify(payload.errors));
      if(!payload.data)throw new Error('Shopify returned no data.');return payload.data;
    }
    throw new Error('Shopify request retries exhausted.');
  };
}
export async function setTextMetafield(graph,ownerId,namespace,key,value){const data=await graph(`mutation SetTextMetafield($id:ID!,$namespace:String!,$key:String!,$value:String!){metafieldsSet(metafields:[{ownerId:$id,namespace:$namespace,key:$key,type:"single_line_text_field",value:$value}]){userErrors{field message}}}`,{id:ownerId,namespace,key,value:String(value??'')});if(!data.metafieldsSet)throw new Error('Shopify returned no save result.');if(data.metafieldsSet.userErrors?.length)throw new Error(data.metafieldsSet.userErrors[0].message);}
export const normalise=value=>String(value??'').trim().toLowerCase();
export const csvEscape=value=>`"${String(value??'').replace(/"/g,'""')}"`;
export function sendCsv(res,filename,rows,columns){const header=columns.map(csvEscape).join(','),body=rows.map(r=>columns.map(c=>csvEscape(r[c])).join(',')).join('\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.send('\uFEFF'+(body?`${header}\n${body}`:header));}

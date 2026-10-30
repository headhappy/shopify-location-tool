import {BUILD_PROPERTY,missingItems,numericId} from '../../../../../shared/pos-build.js';
import {fingerprint,inspectCart,marker,quoteCart,cents} from '../../../../../shared/pos-deal.js';
import {request} from './backend.mjs';
import {createController,waitForCart} from './controller.mjs';

export function createBuildController(api,sessionApi,backend=request,progress=(_message)=>{}) {
  let busy=false;
  const controller=createController(api,sessionApi,backend,progress);
  async function build(deal,selections,reviewedFingerprint,sets=1) {
    if(busy) throw new Error('The deal is already being added. Please wait.');
    busy=true;
    const session=sessionApi.currentSession;
    const tag=Date.now().toString(36)+Math.random().toString(36).slice(2);
    const planned=new Map(); let started=false;
    try {
      const start=api.current.value;
      if(marker(start)) throw new Error('A Head Happy deal is already applied. Return to the basket, or remove that deal before changing its choices.');
      inspectCart(start,session,true);
      if(fingerprint(start,session)!==reviewedFingerprint) throw new Error('The basket changed. Review the choices again before adding the deal.');
      progress('Checking the latest choices, stock and deal price…');
      const fresh=await backend(sessionApi,'/definition',{id:deal.id,version:deal.version,
        session:{shopDomain:session.shopDomain,locationId:session.locationId,currency:session.currency}});
      if(fresh.price!==deal.price) throw new Error('The deal price changed. Reopen the guide to see the new price.');
      const missing=missingItems(fresh,selections,start,sets);
      // Validate the exact planned basket before the first native cart mutation.
      const future={...start,lineItems:[...start.lineItems]};
      for(const item of missing) if(item.add) {
        const id=numericId(item.id),key=tag+':'+id;
        planned.set(key,{variantId:id,quantity:item.add});
        future.lineItems.push({uuid:key,variantId:id,productId:numericId(item.productId),sku:item.sku,
          price:Number(item.price),quantity:item.add,discounts:[],properties:{[BUILD_PROPERTY]:key},taxable:true});
      }
      future.grandTotal=(future.lineItems.reduce((n,l)=>n+cents(l.price)*l.quantity,0)/100).toFixed(2);
      quoteCart(fresh,future,session,selections,sets);
      if(fingerprint(api.current.value,session)!==reviewedFingerprint) throw new Error('The basket changed. Review the choices again.');
      const originalIds=new Set(start.lineItems.map(l=>l.uuid));
      function checkOriginal() {
        const current=api.current.value;
        if(marker(current)) throw new Error('Another deal was applied while this one was being built. Review the basket.');
        const original={...current,lineItems:current.lineItems.filter(l=>originalIds.has(l.uuid))};
        if(fingerprint(original,session)!==reviewedFingerprint || current.lineItems.some(l=>!originalIds.has(l.uuid) && !planned.has(l.properties?.[BUILD_PROPERTY])))
          throw new Error('The basket changed while adding the deal. Review it before trying again.');
      }
      for(const item of missing) if(item.add) {
        checkOriginal();started=true;
        const id=numericId(item.id),key=tag+':'+id;
        progress(`Adding ${item.add} × ${item.sku}…`);
        const uuid=await api.addLineItem(id,item.add,{properties:{[BUILD_PROPERTY]:key}});
        if(!uuid) throw new Error('Adding a component was cancelled.');
        await waitForCart(api,c=>c.lineItems.some(l=>l.uuid===uuid && l.variantId===id && l.quantity===item.add && l.properties?.[BUILD_PROPERTY]===key));
        checkOriginal();
      }
      checkOriginal();
      return await controller.apply(fresh,selections,sets);
    } catch(error) {
      if(started) {
        try {
          if(marker(api.current.value)) throw new Error('Discount cleanup is not confirmed.');
          for(const line of [...api.current.value.lineItems]) {
            const expected=planned.get(line.properties?.[BUILD_PROPERTY]);
            if(!expected) continue;
            if(line.variantId!==expected.variantId || line.quantity!==expected.quantity || line.discounts?.length)
              throw new Error('An added item was changed.');
            await api.removeLineItem(line.uuid);
            await waitForCart(api,c=>!c.lineItems.some(l=>l.uuid===line.uuid));
          }
          if(fingerprint(api.current.value,session)!==reviewedFingerprint)
            throw new Error('The original basket could not be confirmed after cleanup.');
        } catch {throw new Error('The deal was not completed and cleanup could not be confirmed. Do not take payment. Review the basket with a manager.');}
        throw new Error(error.message+' The deal was not completed. Check the basket before payment.');
      }
      throw error;
    } finally {busy=false;}
  }
  return {build,remove:controller.remove};
}

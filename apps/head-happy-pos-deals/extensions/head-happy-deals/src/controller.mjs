import {MARKER, marker, ownedLines, appliedValid, inspectCart, fingerprint, cents, money} from '../../../../../shared/pos-deal.js';
import {request,quotePayload} from './backend.mjs';
export function waitForCart(api,predicate,timeoutMs=5000) {
  if(predicate(api.current.value)) return Promise.resolve();
  return new Promise((resolve,reject) => {
    let off=()=>{};
    const timer=setTimeout(()=>{off();reject(new Error('The till has not confirmed the change. Check the basket before payment.'));},timeoutMs);
    const check=c=>{if(predicate(c)){clearTimeout(timer);off();resolve();}};
    off=api.current.subscribe(check);check(api.current.value);
  });
}
export function createController(api,sessionApi,backend=request) {
  let busy=false;
  const owner=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const session=()=>sessionApi.currentSession;
  async function clearOwned() {
    if(api.current.value.editable===false) throw new Error('Return to the basket to remove the deal.');
    const m=marker(api.current.value);
    if(!m) return;
    if(m.pending && m.until>Date.now() && m.owner!==owner) throw new Error('Wait for the current deal change to finish.');
    // Pause the other mounted target's watcher during native cleanup.
    m.pending=true;m.until=Date.now()+20000;m.owner=owner;
    const lease=JSON.stringify(m);
    await api.addCartProperties({[MARKER]:lease});
    await waitForCart(api,c=>c.properties?.[MARKER]===lease);
    for(const line of ownedLines(api.current.value)) {
      if(api.current.value.properties?.[MARKER]!==lease) throw new Error('Another deal change started. Check the basket.');
      if(line.discounts.length!==1) throw new Error('Discounts have been combined. Ask a manager to remove the Head Happy deal in POS.');
      await api.removeLineItemDiscount(line.uuid);
      await waitForCart(api,c=>!c.lineItems.find(l=>l.uuid===line.uuid)?.discounts?.some(d=>d.discountDescription===m.title));
    }
    if(api.current.value.properties?.[MARKER]!==lease) throw new Error('Another deal change started. Check the basket.');
    await api.removeCartProperties([MARKER]);
    await waitForCart(api,c=>!c.properties?.[MARKER]);
  }
  async function remove() {
    if(busy) throw new Error('Wait for the current deal check to finish.');
    busy=true;try {await clearOwned();return 'Deal removed. Your scanned items are still in the basket.';} finally {busy=false;}
  }
  async function apply(deal) {
    if(busy) throw new Error('Wait for the current deal check to finish.');
    busy=true;let attempted=false;
    try {
      await clearOwned();
      const start=api.current.value, initial=inspectCart(start,session());
      const quote=await backend(sessionApi,'/quote',quotePayload(deal,start,session()));
      if(quote.fingerprint!==initial.fingerprint || fingerprint(api.current.value,session())!==initial.fingerprint || quote.expiresAt<Date.now())
        throw new Error('The basket changed during the check. Try Apply deal again.');
      const m={v:2,title:quote.title,hash:quote.fingerprint,saving:quote.saving,until:Date.now()+20000,pending:true,owner};
      await api.addCartProperties({[MARKER]:JSON.stringify(m)});
      await waitForCart(api,c=>c.properties?.[MARKER]===JSON.stringify(m));
      inspectCart(api.current.value,session());
      if(fingerprint(api.current.value,session())!==quote.fingerprint || quote.expiresAt<Date.now()) throw new Error('The basket changed. Try Apply deal again.');
      attempted=true;
      await api.bulkSetLineItemDiscounts(quote.discounts.map(d=>({lineItemUuid:d.uuid,
        lineItemDiscount:{type:'FixedAmount',title:quote.title,amount:(d.amount/100).toFixed(2)}})));
      await waitForCart(api,c=>quote.discounts.every(d=>{
        const line=c.lineItems.find(l=>l.uuid===d.uuid);
        return line?.discounts?.length===1 && line.discounts[0].discountDescription===quote.title &&
          line.discounts[0].type==='FixedAmount' && cents(line.discounts[0].amount)===d.amount;
      }) && appliedValid(c,session()) && cents(c.grandTotal)===quote.total);
      m.pending=false;delete m.until;
      await api.addCartProperties({[MARKER]:JSON.stringify(m)});
      await waitForCart(api,c=>c.properties?.[MARKER]===JSON.stringify(m));
      if(!appliedValid(api.current.value,session())) throw new Error('The basket changed after applying. Check it again.');
      return `${quote.sets} × ${quote.name} applied. Basket total ${money(quote.total)}. Check this before payment.`;
    } catch(error) {
      try {await clearOwned();} catch {
        throw new Error('Could not confirm or undo the deal. Do not take payment; remove the Head Happy discounts in POS and try again.');
      }
      throw new Error(error.message + (attempted ? ' The deal discount was removed.' : ''));
    } finally {busy=false;}
  }
  return {apply,remove};
}
// A mounted tile can clean up stale manual discounts. This is not a checkout hook.
export function watchDeal(api,sessionApi,notify,controller=createController(api,sessionApi)) {
  let timer,disposed=false,removing=false,reported='';
  const check=()=>{
    clearTimeout(timer);timer=setTimeout(async()=>{
      const cart=api.current.value,m=marker(cart);
      if(disposed || removing || !m) return;
      if(m.pending && m.until>Date.now()) {check();return;}
      if(appliedValid(cart,sessionApi.currentSession)) {reported='';return;}
      removing=true;
      try {await controller.remove();if(!disposed)notify('Basket changed. Deal removed—tap Head Happy deals and apply again.');}
      catch(error) {if(!disposed && reported!==error.message){reported=error.message;notify('Check the deal before payment: '+error.message);}}
      finally {removing=false;}
    },600);
  };
  const off=api.current.subscribe(check);check();
  return ()=>{disposed=true;clearTimeout(timer);off();};
}

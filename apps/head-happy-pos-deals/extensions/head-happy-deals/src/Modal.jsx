import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect,useMemo,useState} from 'preact/hooks';
import {marker,appliedValid} from '../../../../../shared/pos-deal.js';
import {request} from './backend.mjs';
import {createController,watchDeal} from './controller.mjs';
export default async()=>{render(<Extension/>,document.body);};
function Extension() {
  const [cart,setCart]=useState(shopify.cart.current.value),[deals,setDeals]=useState([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('Loading saved bundles…');
  const controller=useMemo(()=>createController(shopify.cart,shopify.session),[]);
  useEffect(()=>shopify.cart.current.subscribe(setCart),[]);
  useEffect(()=>watchDeal(shopify.cart,shopify.session,setMessage,controller),[]);
  async function load() {
    setBusy(true);setMessage('Loading saved bundles…');
    try {const data=await request(shopify.session,'');setDeals(data.deals);setMessage(data.deals.length ? '' : 'Save a bundle in the Bundle Builder first.');}
    catch(error){setMessage(error.message);}finally{setBusy(false);}
  }
  useEffect(()=>{load();},[]);
  async function run(action) {
    setBusy(true);setMessage('Checking the scanned items and saved deal…');
    try{setMessage(await action());}catch(error){setMessage(error.message);}finally{setBusy(false);}
  }
  const applied=appliedValid(cart,shopify.session.currentSession);
  return <s-page heading="Head Happy deals"><s-scroll-box><s-stack direction="block" gap="base" padding="base">
    <s-text>Scan the individual components in the POS basket, then apply your saved bundle below. Any eligible colour counts.</s-text>
    {deals.map(deal=><s-section key={deal.id} heading={deal.name}>
      <s-button variant="primary" disabled={busy || !cart.lineItems.length || cart.editable===false}
        onClick={()=>run(()=>controller.apply(deal))}>Apply deal</s-button>
    </s-section>)}
    {marker(cart) && <s-button disabled={busy} onClick={()=>run(controller.remove)}>Remove deal</s-button>}
    {applied && <s-banner>Deal applied. Check the basket total before payment.</s-banner>}
    {message && <s-banner>{message}</s-banner>}
    <s-button disabled={busy} onClick={load}>Refresh saved bundles</s-button>
    <s-text>If you change the basket, apply the deal again. One saved deal can cover several complete kits in this basket.</s-text>
    <s-text>Shopify records the actual scanned items and deducts their stock when you complete the sale.</s-text>
  </s-stack></s-scroll-box></s-page>;
}

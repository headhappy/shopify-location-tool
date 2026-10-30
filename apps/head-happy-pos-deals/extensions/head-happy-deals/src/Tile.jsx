import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect,useState} from 'preact/hooks';
import {appliedValid} from '../../../../../shared/pos-deal.js';
import {watchDeal} from './controller.mjs';
export default async()=>{render(<Extension/>,document.body);};
function Extension(){
  const [cart,setCart]=useState(shopify.cart.current.value);
  useEffect(()=>shopify.cart.current.subscribe(setCart),[]);
  useEffect(()=>watchDeal(shopify.cart,shopify.session,message=>shopify.toast.show(message)),[]);
  return <s-tile heading="Head Happy deals"
    subheading={appliedValid(cart,shopify.session.currentSession) ? 'Deal applied · check basket' : 'Scan items, then apply deal'}
    onClick={()=>shopify.action.presentModal()}/>;
}

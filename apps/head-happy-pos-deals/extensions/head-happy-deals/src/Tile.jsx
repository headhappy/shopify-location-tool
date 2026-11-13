import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {inspectCart} from './deal.mjs';
import {watchDeal} from './controller.mjs';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const [cart, setCart] = useState(shopify.cart.current.value);
  const session = shopify.session.currentSession;
  useEffect(() => shopify.cart.current.subscribe(setCart), []);
  useEffect(() => watchDeal(shopify.cart, session, (message) => shopify.toast.show(message)), []);
  const state = inspectCart(cart, session, {allowOwned: true});
  return (
    <s-tile
      heading="Crown deal · £14.99"
      subheading={state.applied ? 'Deal applied · check basket' : state.ok ? 'Ready to apply' : 'Scan the 4 items, then tap'}
      onClick={() => shopify.action.presentModal()}
    />
  );
}

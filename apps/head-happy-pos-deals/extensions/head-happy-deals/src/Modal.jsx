import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useMemo, useState} from 'preact/hooks';
import {GROUPS, PILOT, inspectCart, marker, money} from './deal.mjs';
import {createController, watchDeal} from './controller.mjs';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [cart, setCart] = useState(shopify.cart.current.value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const session = shopify.session.currentSession;
  const controller = useMemo(() => createController(shopify.cart, session), []);
  useEffect(() => shopify.cart.current.subscribe(setCart), []);
  useEffect(() => watchDeal(shopify.cart, session, setMessage, controller), []);
  const state = inspectCart(cart, session, {allowOwned: true});
  async function run(action) {
    setBusy(true);
    setMessage('Checking the basket…');
    try { setMessage(await action() || 'Crown deal removed.'); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return (
    <s-page heading="Crown deal · £14.99">
      <s-scroll-box>
        <s-stack direction="block" gap="base" padding="base">
          <s-text>Scan one of each in the normal POS basket. Choose any eligible box and grinder colour.</s-text>
          {GROUPS.map((group) => {
            const selected = cart.lineItems.filter(group.matches);
            return <s-section key={group.id} heading={group.name}>
              <s-text>{selected.length ? selected.map((l) => `${l.quantity} × ${l.title || l.sku} · ${l.sku}`).join(', ') : 'Still to scan'}</s-text>
            </s-section>;
          })}
          <s-text>{state.ok ? `${money(state.subtotalCents)} normally · ${money(state.discountCents)} deal saving` : state.reason}</s-text>
          <s-button variant="primary" disabled={busy || !state.ok || state.applied} loading={busy}
            onClick={() => run(controller.apply)}>{state.applied ? 'Crown deal applied' : 'Apply Crown deal · £14.99'}</s-button>
          {marker(cart) && <s-button disabled={busy} onClick={() => run(controller.remove)}>Remove Crown deal</s-button>}
          {message && <s-banner>{message}</s-banner>}
          <s-text>This first pilot is one deal per basket at 31 Cowgate. If you change any items, remove the deal and apply it again.</s-text>
          <s-text>Check the four items and £14.99 before payment. Shopify records their sale and reduces their stock when you finish checkout.</s-text>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

import {PILOT, cartDiscounts, checkCatalog, fingerprint, inspectCart, ownsDiscount} from './deal.mjs';
import {loadCatalog} from './catalog.mjs';

export function waitForCart(api, predicate, timeoutMs = 4000) {
  if (predicate(api.current.value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('The till has not confirmed the change. Check the basket before taking payment.'));
    }, timeoutMs);
    unsubscribe = api.current.subscribe((cart) => {
      if (predicate(cart)) { clearTimeout(timeout); unsubscribe(); resolve(); }
    });
    if (predicate(api.current.value)) { clearTimeout(timeout); unsubscribe(); resolve(); }
  });
}

export function createController(api, session, readCatalog = loadCatalog) {
  let busy = false;
  async function clearMarkerIfUnused() {
    const cart = api.current.value;
    if (cart.editable === false || cartDiscounts(cart).some((d) => d.discountDescription === PILOT.discountTitle)) return;
    if (cart.properties?.[PILOT.markerKey]) await api.removeCartProperties([PILOT.markerKey]);
  }
  async function remove() {
    if (busy) throw new Error('Wait for the current check to finish.');
    busy = true;
    try {
      const cart = api.current.value;
      if (cart.editable === false) throw new Error('Return to the basket before removing the deal.');
      if (!ownsDiscount(cart)) {
        if (cartDiscounts(cart).some((d) => d.discountDescription === PILOT.discountTitle)) throw new Error('The discounts have changed. Ask a manager to remove the Crown pilot discount in POS.');
        await clearMarkerIfUnused();
        return;
      }
      await api.removeCartDiscount();
      await waitForCart(api, (c) => !cartDiscounts(c).some((d) => d.discountDescription === PILOT.discountTitle));
      await clearMarkerIfUnused();
    } finally { busy = false; }
  }
  async function apply() {
    if (busy) throw new Error('Wait for the current check to finish.');
    busy = true;
    let attempted = false;
    try {
      const start = api.current.value;
      const existing = inspectCart(start, session, {allowOwned: true});
      if (existing.ok && existing.applied) return 'The Crown deal is already applied. Check £14.99 at payment.';
      const initial = inspectCart(start, session);
      if (!initial.ok) throw new Error(initial.reason);
      const data = await readCatalog(start, session);
      if (fingerprint(api.current.value, session) !== initial.fingerprint) throw new Error('The basket changed during the check. Check the items and try again.');
      const checked = checkCatalog(data, api.current.value, session);
      const value = JSON.stringify({version: 1, fingerprint: checked.fingerprint, discountCents: checked.discountCents});
      await api.addCartProperties({[PILOT.markerKey]: value});
      await waitForCart(api, (c) => c.properties?.[PILOT.markerKey] === value);
      const latest = inspectCart(api.current.value, session);
      if (!latest.ok || latest.fingerprint !== checked.fingerprint) throw new Error('The basket changed before the discount. Check it and try again.');
      attempted = true;
      await api.applyCartDiscount('FixedAmount', PILOT.discountTitle, (checked.discountCents / 100).toFixed(2));
      await waitForCart(api, (c) => ownsDiscount(c));
      await waitForCart(api, (c) => inspectCart(c, session, {allowOwned: true}).ok);
      return 'Crown deal applied. Check £14.99 on the payment screen, then complete the sale in POS.';
    } catch (error) {
      // Native calls can fail after changing the basket. Only undo our lone, identified discount.
      if (attempted && ownsDiscount(api.current.value) && api.current.value.editable !== false) {
        try {
          await api.removeCartDiscount();
          await waitForCart(api, (c) => !ownsDiscount(c));
        } catch {
          throw new Error('The till could not confirm or undo the deal. Do not take payment; ask a manager to check the basket.');
        }
      }
      await clearMarkerIfUnused().catch(() => {});
      throw error;
    } finally { busy = false; }
  }
  return {apply, remove};
}

// Best effort while the tile/modal is mounted, not a checkout enforcement hook.
export function watchDeal(api, session, notify, controller = createController(api, session)) {
  let timer;
  let disposed = false;
  let removing = false;
  let reported = '';
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const cart = api.current.value;
      if (disposed || removing || !cart.properties?.[PILOT.markerKey]) return;
      // A valid basket becomes read-only on the payment screen; that is not an edit.
      if (inspectCart({...cart, editable: true}, session, {allowOwned: true}).ok) { reported = ''; return; }
      if (!cartDiscounts(cart).some((d) => d.discountDescription === PILOT.discountTitle)) return;
      removing = true;
      try {
        await controller.remove();
        if (!disposed) notify('The basket changed. Crown deal removed; check the items and apply again.');
      } catch (error) {
        const message = 'Check the Crown deal before payment: ' + error.message;
        if (!disposed && reported !== message) { reported = message; notify(message); }
      } finally { removing = false; }
    }, 500);
  };
  const unsubscribe = api.current.subscribe(check);
  check();
  return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
}

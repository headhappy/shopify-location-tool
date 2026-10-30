const ORIGIN = 'https://headhappy-bundle-preview.onrender.com';
export async function request(session, path, body) {
  let tokenTimer;
  const token = await Promise.race([session.getSessionToken(),new Promise((_,reject) => {
    tokenTimer=setTimeout(()=>reject(new Error('Shopify sign-in did not respond. Close and reopen the deal.')),15000);
  })]).finally(()=>clearTimeout(tokenTimer));
  if (!token) throw new Error('Your Shopify POS user needs access to Head Happy POS Deals. Ask the manager to check app permissions.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),55000);
  try {
    const res = await fetch(ORIGIN + '/api/pos-deals' + path,{
      method:body ? 'POST' : 'GET', credentials:'omit', signal:controller.signal,
      headers:{Authorization:`Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The deal service is waking up. Try again in a moment.');
    return data;
  } catch(error) {
    if (error.name === 'AbortError') throw new Error('The deal service is taking longer to wake up. Try again; no discount was added.');
    throw error;
  } finally { clearTimeout(timer); }
}
export function quotePayload(deal, cart, session) {
  return {id:deal.id, version:deal.version,
    session:{shopDomain:session.shopDomain,locationId:session.locationId,currency:session.currency},
    cart:{currency:cart.currency ?? session.currency, editable:cart.editable, grandTotal:cart.grandTotal,
      customer:cart.customer ? {id:cart.customer.id} : undefined,
      cartDiscount:cart.cartDiscount,cartDiscounts:cart.cartDiscounts,
      properties:cart.properties,
      lineItems:cart.lineItems.map(l => ({uuid:l.uuid,variantId:l.variantId,productId:l.productId,sku:l.sku,
        price:l.price,quantity:l.quantity,taxable:l.taxable,discounts:l.discounts,discountAllocations:l.discountAllocations,
        isGiftCard:l.isGiftCard,requiresSellingPlan:l.requiresSellingPlan,sellingPlan:l.sellingPlan,components:l.components,properties:l.properties}))}};
}

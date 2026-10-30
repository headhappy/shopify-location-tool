// A guided deal selects exact variants. Shopify checkout remains the stock writer.
export const BUILD_PROPERTY = '_headhappy_build';
const need = (ok, message) => { if (!ok) throw new Error(message); };
export const numericId = id => Number(id.split('/').pop());
export function selectedItems(deal, selections, sets = 1) {
  need(Number.isSafeInteger(sets) && sets>0 && sets<=100, 'Choose between 1 and 100 complete deals.');
  need(Array.isArray(selections) && selections.length <= 100, 'Choose the components first.');
  const result = [], seen = new Set();
  for (const choice of selections) {
    const group = deal.groups.find(g => g.id === choice.groupId);
    const item = group?.items.find(v => v.id === choice.variantId);
    need(item && !seen.has(item.id), 'A chosen item is missing, duplicated or no longer allowed in this deal.');
    need(Number.isSafeInteger(choice.quantity) && choice.quantity > 0 && choice.quantity <= 1000, 'Choose a whole quantity for each component.');
    seen.add(item.id); result.push({...item, groupId:group.id, quantity:choice.quantity});
  }
  for (const group of deal.groups) need(result.filter(v => v.groupId === group.id).reduce((n,v) => n+v.quantity,0) === group.quantity*sets,
    `Choose exactly ${group.quantity*sets} × ${group.name}.`);
  need(result.reduce((n,v) => n+v.quantity,0) <= 1000, 'Use at most 1,000 components.');
  return result;
}
export function initialSelections(deal, cart) {
  const result = [];
  for (const group of deal.groups) {
    let left = group.quantity;
    for (const item of group.items) {
      const inCart = (cart.lineItems || []).filter(l => l.variantId === numericId(item.id)).reduce((n,l) => n+l.quantity,0);
      const quantity = Math.min(left,inCart);
      if (quantity) {result.push({groupId:group.id,variantId:item.id,quantity});left-=quantity;}
    }
    if (left && group.items.length === 1) {
      const item = group.items[0], prior = result.find(c => c.variantId === item.id);
      if (prior) prior.quantity += left;
      else result.push({groupId:group.id,variantId:item.id,quantity:left});
    }
  }
  return result;
}
export function missingItems(deal, selections, cart, sets = 1) {
  need(!(cart.lineItems || []).some(l => l.productId === numericId(deal.product.id)),
    'Remove the finished deal product from the basket first. This guide adds its actual components at the deal price.');
  return selectedItems(deal,selections,sets).map(item => {
    const already = (cart.lineItems || []).filter(l => l.variantId === numericId(item.id)).reduce((n,l) => n+l.quantity,0);
    return {...item, reuse:Math.min(item.quantity,already), add:Math.max(0,item.quantity-already)};
  });
}
export function chooseItem(deal, selections, groupId, variantId) {
  const group = deal.groups.find(g => g.id === groupId);
  need(group?.items.some(v => v.id === variantId), 'That item is not allowed in this step.');
  const next = selections.map(c => ({...c}));
  if (group.quantity === 1) return [...next.filter(c => c.groupId !== groupId),{groupId,variantId,quantity:1}];
  const total = next.filter(c => c.groupId === groupId).reduce((n,c) => n+c.quantity,0);
  need(total < group.quantity, 'This step is full. Clear the choice before changing it.');
  const choice = next.find(c => c.groupId === groupId && c.variantId === variantId);
  if (choice) choice.quantity++; else next.push({groupId,variantId,quantity:1});
  return next;
}
export function scanChoice(group, barcode) {
  const matches = group.items.filter(v => v.barcode === barcode || v.sku === barcode);
  need(matches.length === 1, matches.length ? 'That barcode has more than one colour. Tap the actual colour below.' : `That code is not a ${group.name}. Choose an item below.`);
  return matches[0].id;
}

export const session={shopDomain:'headhappyhemp.myshopify.com',locationId:1,currency:'GBP'};
export const sessionApi={currentSession:session};
export function dealFixture(){
 const item=(id,product,sku,price)=>({id:`gid://shopify/ProductVariant/${id}`,productId:`gid://shopify/Product/${product}`,sku,price,available:500,tracked:true,status:'ACTIVE',requiresComponents:false});
 return {id:'7256dd94-a27d-4176-8172-5ac0efbd9168',version:3,name:'Crown kit',price:1499,currency:'GBP',groups:[
 {id:'box',name:'Box',quantity:1,items:[item(1,11,'BOX_RED','14.99'),item(2,12,'BOX_GREEN','14.99')]},
 {id:'grinder',name:'Grinder',quantity:1,items:[item(3,13,'GRINDER_RED','3.50'),item(4,13,'GRINDER_GREEN','3.50')]},
 {id:'gold',name:'Gold papers',quantity:1,items:[item(5,14,'PAPK_RDY','2.65')]},
 {id:'silver',name:'Silver papers',quantity:1,items:[item(6,15,'PAPR_RDY_A1','2.29')]}]};
}
export function cartFixture(deal=dealFixture()){
 const lineItems=deal.groups.map((g,i)=>{const v=g.items[0];return {uuid:'line-'+i,variantId:Number(v.id.split('/').pop()),productId:Number(v.productId.split('/').pop()),sku:v.sku,price:Number(v.price),quantity:1,taxable:true,discounts:[],properties:{},isGiftCard:false};});
 return {lineItems,properties:{},currency:'GBP',grandTotal:'23.43',editable:true};
}
export function nativeFixture(cart=cartFixture()){
 const listeners=new Set();let bulkCalls=0,removeCalls=0;
 const emit=()=>{let total=0;for(const l of cart.lineItems) total+=Math.round(l.price*100)*l.quantity-(l.discounts||[]).reduce((n,d)=>n+Math.round(d.amount*100)*l.quantity,0);cart.grandTotal=(total/100).toFixed(2);for(const f of listeners)f(cart);};
 const api={current:{get value(){return cart;},subscribe(f){listeners.add(f);return()=>listeners.delete(f);}},
 async addCartProperties(p){Object.assign(cart.properties,p);emit();},
 async removeCartProperties(keys){keys.forEach(k=>delete cart.properties[k]);emit();},
 async bulkSetLineItemDiscounts(ds){bulkCalls++;for(const d of ds){const l=cart.lineItems.find(l=>l.uuid===d.lineItemUuid);l.discounts=[{discountDescription:d.lineItemDiscount.title,type:d.lineItemDiscount.type,amount:Number(d.lineItemDiscount.amount),currency:'GBP'}];}emit();},
 async removeLineItemDiscount(id){removeCalls++;cart.lineItems.find(l=>l.uuid===id).discounts=[];emit();}};
 return {api,cart,emit,get bulkCalls(){return bulkCalls;},get removeCalls(){return removeCalls;}};
}

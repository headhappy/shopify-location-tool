import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {marker,appliedValid,fingerprint,money} from '../../../../../shared/pos-deal.js';
import {initialSelections,chooseItem,scanChoice,missingItems} from '../../../../../shared/pos-build.js';
import {request} from './backend.mjs';
import {createBuildController} from './build-controller.mjs';
export default async()=>{render(<Extension/>,document.body);};
export function Extension() {
  const [cart,setCart]=useState(shopify.cart.current.value);
  const [deals,setDeals]=useState([]),[deal,setDeal]=useState(null),[choices,setChoices]=useState([]);
  const [step,setStep]=useState(0),[quantity,setQuantity]=useState(1),[reviewHash,setReviewHash]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('Loading your bundles…'),[failed,setFailed]=useState(false);
  const [success,setSuccess]=useState(false),latest=useRef(null);
  const session=shopify.session.currentSession;
  const controller=useMemo(()=>createBuildController(shopify.cart,shopify.session,request,setMessage),[]);
  useEffect(()=>shopify.cart.current.subscribe(value=>setCart({...value})),[]);
  function report(error) {const text=error.message || String(error);setFailed(true);setMessage(text);shopify.toast.show(text);}
  const scaled=deal ? {...deal,groups:deal.groups.map(g=>({...g,quantity:g.quantity*quantity}))} : null;
  const choiceGroups=scaled?.groups.filter(g=>g.items.length>1) || [],group=choiceGroups[step];
  function review() {setStep(choiceGroups.length);setReviewHash(fingerprint(shopify.cart.current.value,session));}
  function changeQuantity(value) {
    const count=Number(value);
    if(!Number.isInteger(count) || count<1 || count>100) {report(new Error('Choose 1 to 100 deals.'));return;}
    setQuantity(count);setStep(0);setMessage('');setFailed(false);
    setChoices(initialSelections({...deal,groups:deal.groups.map(g=>({...g,quantity:g.quantity*count}))},shopify.cart.current.value));
    setReviewHash(fingerprint(shopify.cart.current.value,session));
  }
  async function open(selected) {
    setBusy(true);setFailed(false);setMessage('Loading the allowed colours and store stock…');setSuccess(false);
    try {
      const data=await request(shopify.session,'/definition',{id:selected.id,version:selected.version,
        session:{shopDomain:session.shopDomain,locationId:session.locationId,currency:session.currency}});
      setDeal(data);setChoices(initialSelections(data,shopify.cart.current.value));setStep(0);setQuantity(1);
      setReviewHash(fingerprint(shopify.cart.current.value,session));setMessage('');
    } catch(error){report(error);} finally{setBusy(false);}
  }
  async function load() {
    setBusy(true);setFailed(false);setMessage('Loading your bundles…');
    try {
      const data=await request(shopify.session,'');setDeals(data.deals);
      if(data.deals.length===1) await open(data.deals[0]);
      else {setDeal(null);setMessage(data.deals.length ? 'Choose a deal.' : 'Save a bundle in the Bundle Builder first.');}
    } catch(error){report(error);} finally{setBusy(false);}
  }
  useEffect(()=>{load();},[]);
  function choose(id) {
    try {
      const next=chooseItem(scaled,choices,group.id,id);
      setChoices(next);setMessage('');setFailed(false);
      if(next.filter(c=>c.groupId===group.id).reduce((n,c)=>n+c.quantity,0)===group.quantity) {
        if(step+1===choiceGroups.length) review(); else setStep(step+1);
      }
    } catch(error){report(error);}
  }
  latest.current={busy,group,choose,report};
  useEffect(()=>{
    if(!shopify.scanner) return;
    // Ignore Shopify's synchronous replay of the previous scan on subscribe.
    let subscribing=true,last='',lastAt=0;
    const off=shopify.scanner.scannerData.current.subscribe(result=>{
      if(subscribing || !result.data) return;
      const current=latest.current;
      if(current.busy || !current.group) return;
      if(last===result.data && Date.now()-lastAt<750) return;
      last=result.data;lastAt=Date.now();
      try {current.choose(scanChoice(current.group,result.data));} catch(error){current.report(error);}
    });
    subscribing=false;return off;
  },[]);
  let summary=[],reviewError='';
  if(deal && !group) try {summary=missingItems(deal,choices,cart,quantity);}catch(error){reviewError=error.message;}
  async function add() {
    if(busy) return;
    setBusy(true);setFailed(false);setMessage('Checking your deal. Keep this screen open while it is added.');
    shopify.toast.show('Checking your deal…');
    try {
      const result=await controller.build(deal,choices,reviewHash,quantity);
      setSuccess(true);setMessage(result);shopify.toast.show('Deal price applied. Check the basket total.');
    }catch(error){report(error);setReviewHash(fingerprint(shopify.cart.current.value,session));}
    finally{setBusy(false);}
  }
  async function remove() {
    setBusy(true);setFailed(false);setMessage('Removing the deal discount…');
    try {setMessage(await controller.remove());setSuccess(false);setReviewHash(fingerprint(shopify.cart.current.value,session));}
    catch(error){report(error);}finally{setBusy(false);}
  }
  const applied=appliedValid(cart,session),hasDeal=!!marker(cart);
  return <s-page heading="Build a deal"><s-scroll-box><s-stack direction="block" gap="base" padding="base">
    {message && <s-banner heading={message} tone={failed ? 'critical' : 'info'}><s-text>{message}</s-text></s-banner>}
    {busy && <s-text>Keep this screen open. Nothing is sold until you complete checkout.</s-text>}
    {!busy && (success || hasDeal) ? <s-section heading={applied ? 'Deal price applied' : 'Check the current deal'}>
      <s-text>Basket total: {cart.grandTotal} {cart.currency}. Actual components are in the basket.</s-text>
      {!applied && <s-text>The basket changed. Remove the deal discount, then review the choices again before payment.</s-text>}
      <s-button variant="primary" onClick={()=>window.close()}>Return to basket</s-button>
      <s-button onClick={remove}>Remove deal discount to change choices</s-button>
    </s-section> : <>
      {!deal && deals.map(d=><s-button key={d.id} disabled={busy} onClick={()=>open(d)}>{d.name}</s-button>)}
      {deal && <><s-text>{deal.name} · {money(deal.price)} per deal</s-text>
        <s-number-field label="Number of deals" value={String(quantity)} min={1} max={100} disabled={busy} onChange={event=>changeQuantity(event.currentTarget.value)}/></>}
      {deal && group && <s-section heading={`Choose ${group.name}`}>
        <s-text>Step {step+1} of {choiceGroups.length+1} · Choose {group.quantity}. Tap the actual colour or scan its barcode.</s-text>
        {group.items.map(item=>{
          const picked=choices.find(c=>c.variantId===item.id)?.quantity || 0;
          const label=item.title && item.title!=='Default Title' ? item.title : item.productTitle || item.sku;
          const unavailable=item.status!=='ACTIVE' || !item.tracked || item.requiresComponents || !Number.isInteger(item.available) || item.available<1;
          return <s-button key={item.id} disabled={busy || unavailable} variant={picked ? 'primary' : 'secondary'}
            onClick={()=>choose(item.id)}>{picked ? `${picked} selected · ` : ''}{label} · {item.sku} · {item.available ?? '?'} in stock</s-button>;
        })}
        <s-button disabled={busy} onClick={()=>setChoices(choices.filter(c=>c.groupId!==group.id))}>Clear this choice</s-button>
        {shopify.scanner && <s-button disabled={busy} onClick={()=>shopify.scanner.showCameraScanner()}>Use camera</s-button>}
        {choices.filter(c=>c.groupId===group.id).reduce((n,c)=>n+c.quantity,0)===group.quantity &&
          <s-button disabled={busy} onClick={()=>step+1===choiceGroups.length ? review() : setStep(step+1)}>Keep this choice</s-button>}
        {step>0 && <s-button disabled={busy} onClick={()=>setStep(step-1)}>Back</s-button>}
      </s-section>}
      {deal && !group && <s-section heading="Check the complete deal">
        <s-text>{quantity} complete deal(s), including the papers. Matching items already scanned are reused.</s-text>
        {summary.map(item=><s-text key={item.id}>{item.quantity} × {item.productTitle || item.sku}{item.title && item.title!=='Default Title' ? ` / ${item.title}` : ''} · {item.sku} — {item.reuse} already in basket, {item.add} to add</s-text>)}
        {reviewError && <s-banner heading={reviewError} tone="critical"/>}
        <s-text>Deal total: {money(deal.price*quantity)}. Other basket items remain extra.</s-text>
        <s-button variant="primary" loading={busy} disabled={!!reviewError || busy} onClick={add}>Confirm all items &amp; add deal at {money(deal.price*quantity)}</s-button>
        {!!choiceGroups.length && <s-button disabled={busy} onClick={()=>setStep(0)}>Change choices</s-button>}
      </s-section>}
    </>}
    {!busy && !success && !hasDeal && <s-button onClick={load}>Reload bundles</s-button>}
    <s-text>{cart.lineItems.reduce((n,l)=>n+l.quantity,0)} items in basket · Guided release · POS {session.posVersion || 'version unavailable'}</s-text>
  </s-stack></s-scroll-box></s-page>;
}

import {LOCATION_FIELDS as fields,clean,escapeHtml as esc,lookupRows,jsonRequest,physicalLocation} from './location-fields.js';
import {Camera} from './camera.js?v=1.4.3';
const $=id=>document.getElementById(id),camera=new Camera(),state={scanning:false,processing:false,queue:[],seen:new Set(),remembered:new Map(),pending:null,saved:0,skipped:0,failed:0};
$('targetFields').innerHTML=fields.map(f=>`<label class="target-card"><input type="radio" name="target" value="${f.name}" ${f.name==='location'?'checked':''}><span>${f.label}<small class="hint" style="display:block">Variant: ${f.namespace}.${f.key}</small></span></label>`).join('');
const target=()=>fields.find(f=>f.name===document.querySelector('[name=target]:checked').value);
function status(message,tone=''){ $('batchStatus').textContent=message;$('batchStatus').className=`status ${tone}`; }
function controls(){const busy=state.scanning||state.processing||state.queue.length>0||!!state.pending;for(const el of [$('batchLocation'),$('scanLocationBtn'),...document.querySelectorAll('[name=target]')])el.disabled=!!busy;$('startBtn').disabled=!!busy;$('stopBtn').disabled=!state.scanning;$('clearBtn').disabled=!!busy;for(const [key,id] of [['saved','savedCount'],['skipped','skipCount'],['failed','failCount']])$(id).textContent=state[key];$('queueCount').textContent=state.queue.length;}
function log(kind,title,detail){const row=document.createElement('div');row.className=`log-row ${kind}`;row.innerHTML=`<strong>${esc(title)}</strong><div class="hint">${esc(detail)}</div>`;$('batchLog').prepend(row);}
function codeMatch(v,code){const norm=s=>clean(s).toLowerCase(),same=(a,b)=>{a=clean(a);b=clean(b);return !!a&&((/^\d+$/.test(a)&&/^\d+$/.test(b))?a.replace(/^0+/,'')===b.replace(/^0+/,''):norm(a)===norm(b));};if(norm(v.sku)===norm(code))return true;return (v.barcodes?.length?v.barcodes:[v.barcode]).some(barcode=>same(barcode,code));}

const norm=v=>clean(v).toLowerCase();
function dismissChooser(){$('variantChooser').hidden=true;$('variantChoices').innerHTML='';}
async function saveVariant(hit,job){
 if(!hit?.id)throw new Error('Selected variant has no Shopify ID');
 await jsonRequest(job.field.endpoint,{variantId:hit.id,[job.field.valueKey]:job.location});
 state.saved++;
 log('ok',hit.sku+' · '+hit.productTitle+(hit.variantTitle?' — '+hit.variantTitle:''),job.field.label+': '+job.location+' · barcode '+job.code+' · saved to selected variant');
}
function chooser(job,hits){
 state.pending={job,hits};
 $('chooserTitle').textContent=hits.length+' matching variants for '+job.code;
 $('chooserHint').textContent='Destination: '+job.field.label+' → '+job.location+'. Choose one variant or explicitly apply to all. Further scans will wait in the queue.';
 $('variantChoices').innerHTML=hits.map((v,i)=>'<button type="button" class="variant-choice" data-choice="'+i+'"><strong>'+esc(v.productTitle)+' — '+esc(v.variantTitle||'Default')+'</strong><span>SKU: '+esc(v.sku)+' · Stock: '+Number(v.stock||0)+' · Current: '+esc(v[job.field.current]||'BLANK')+'</span></button>').join('');
 $('variantChooser').hidden=false;status('Choose the correct variant; nothing has been saved yet.','warn');controls();
}
async function handle(job){
 status('Looking up '+job.code+'…','busy');
 try{
  const data=await jsonRequest('/lookup-variant',{search:job.code});
  const hits=lookupRows(data).filter(v=>codeMatch(v,job.code));
  if(!hits.length){state.skipped++;state.seen.delete(job.key);log('warn',job.code,'No exact match; nothing saved.');status('No exact match.','warn');return;}
  if(hits.length>1){
   const remembered=state.remembered.get(norm(job.code));
   if(remembered){
    const selected=hits.filter(v=>remembered.includes(v.id));
    if(selected.length===remembered.length&&selected.length){
     for(const hit of selected)await saveVariant(hit,job);
     status('Saved remembered variant selection for '+job.code+'.','ok');return;
    }
    state.remembered.delete(norm(job.code));
   }
   chooser(job,hits);return;
  }
  await saveVariant(hits[0],job);
  status('Saved '+hits[0].sku+' to '+job.field.label+': '+job.location+'.','ok');
 }catch(e){state.failed++;state.seen.delete(job.key);log('fail',job.code,e.message);status(e.message,'error');}
}
async function resolveChoice(all,index){
 if(!state.pending)return;
 const {job,hits}=state.pending,selected=all?hits:(hits[index]?[hits[index]]:[]);
 if(!selected.length)return;
 $('variantChooser').querySelectorAll('button').forEach(b=>b.disabled=true);
 let succeeded=0,failed=0;
 for(const hit of selected){
  try{await saveVariant(hit,job);succeeded++;}
  catch(e){failed++;state.failed++;log('fail',hit.sku||job.code,e.message);}
 }
 if(!failed){state.remembered.set(norm(job.code),selected.map(v=>v.id));status('Saved '+succeeded+' variant(s); selection remembered for this session.','ok');}
 else{state.seen.delete(job.key);status('Saved '+succeeded+', failed '+failed+'. Check the log before retrying.','error');}
 state.pending=null;dismissChooser();controls();process();
}
$('variantChoices').onclick=e=>{const b=e.target.closest('[data-choice]');if(b)resolveChoice(false,Number(b.dataset.choice));};
$('applyAllVariants').onclick=()=>{if(state.pending&&confirm('Save ALL '+state.pending.hits.length+' variants to '+state.pending.job.location+'?'))resolveChoice(true);};
$('skipAmbiguous').onclick=()=>{
 if(!state.pending)return;
 const job=state.pending.job;state.skipped++;state.seen.delete(job.key);
 log('warn',job.code,'Skipped by operator. No location changed.');
 state.pending=null;dismissChooser();status('Skipped. Ready for next scan.','warn');controls();process();
};
async function process(){if(state.processing||state.pending)return;state.processing=true;controls();try{while(state.queue.length&&!state.pending){const job=state.queue.shift();controls();await handle(job);}}finally{state.processing=false;controls();}}
function enqueue(raw){const code=clean(raw),location=clean($('batchLocation').value),field=target();if(!code)return;if(!physicalLocation(location))return status('Set a physical location before scanning.','error');const key=`${field.name}|${location.toLowerCase()}|${code.toLowerCase()}`;if(state.seen.has(key)){state.skipped++;controls();return status(`Duplicate scan skipped: ${code}`,'warn');}state.seen.add(key);state.queue.push({code,location,field,key});controls();process();}
async function start(){if(state.scanning||state.processing||state.pending)return;const location=clean($('batchLocation').value);if(!physicalLocation(location))return status('Set or scan a location first.','error');state.scanning=true;controls();status(`Scanner running → ${target().label}: ${location}.`,'busy');try{await camera.start($('productScanner'),text=>{if(state.scanning)enqueue(text);},{continuous:true});}catch(e){state.scanning=false;controls();status(e.message,'error');}}
async function stop(){state.scanning=false;controls();await camera.stop();status(state.processing||state.queue.length?'Scanner stopped. Finishing already queued scans…':'Scanner stopped.',state.processing?'busy':'');controls();}
$('scanLocationBtn').onclick=async()=>{if(state.processing||state.scanning||state.pending)return;try{await camera.start($('locationScanner'),text=>{$('batchLocation').value=clean(text);status(`Destination: ${target().label} → ${clean(text)}`,'ok');});}catch(e){status(e.message,'error');}};
$('startBtn').onclick=start;$('stopBtn').onclick=stop;$('manualForm').onsubmit=e=>{e.preventDefault();enqueue($('manualProduct').value);$('manualProduct').value='';};$('clearBtn').onclick=()=>{if(state.processing||state.scanning||state.pending)return;state.queue=[];state.seen.clear();state.remembered.clear();state.saved=state.skipped=state.failed=0;$('batchLog').innerHTML='';controls();status('Session cleared. Check the destination before the next batch.');};controls();

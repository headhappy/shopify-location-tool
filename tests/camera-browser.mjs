// Real html5-qrcode + Chromium media capture; only the camera DEVICE and Shopify
// responses are synthetic. No Shopify server, credentials, or live writes are used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import bwipjs from 'bwip-js';
const root = process.cwd();
const decoder = await readFile(path.join(root,'node_modules/html5-qrcode/html5-qrcode.min.js'));
const fixture = {id:'gid://shopify/ProductVariant/100',productId:'gid://shopify/Product/200',productTitle:'Scanner test only',variantTitle:'Blue',sku:'TEST_SKU',barcode:'12345678',stock:3,currentDisplayLoc:'Window 1',currentDisplayLoc2:'Till 2',currentLocation:'MC1 D1',currentLoc2:'Blue 9'};
const writes = [];
const pngs = new Map();
for (const bcid of ['qrcode','code128']) pngs.set(`/__${bcid}.png`,await bwipjs.toBuffer({bcid,text:'TEST_SKU',scale:4,padding:20,backgroundcolor:'FFFFFF'}));
const server = createServer(async(req,res)=>{
  try {
    const url = new URL(req.url,'http://localhost');
    let body='',type='text/html';
    if (url.pathname === '/__camera.html') body = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/location-ui.css"><style>body{max-width:560px}</style><div id="reader" class="scanner"></div><div id="other" class="scanner"></div><script src="/__decoder.js"></script>`;
    else if (url.pathname === '/__decoder.js') {body=decoder;type='text/javascript';}
    else if (pngs.has(url.pathname)) {body=pngs.get(url.pathname);type='image/png';}
    else if (req.method==='POST') {
      const chunks=[];for await (const chunk of req)chunks.push(chunk);
      const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      type='application/json';
      if(url.pathname==='/lookup-variant')body=JSON.stringify({variants:[fixture],matchedBy:'test-fixture'});
      else if(url.pathname==='/lookup-location')body=JSON.stringify({location:data.location,rows:[fixture],count:1});
      else {writes.push({path:url.pathname,body:data});body=JSON.stringify({success:true});}
    } else {
      const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
      const file=path.resolve(root,'public',relative);
      if(!file.startsWith(path.join(root,'public')+path.sep))throw new Error('Invalid path');
      body=await readFile(file);
      type=relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html';
    }
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
  } catch(error) {res.writeHead(404);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
let checks=0;
const pass=message=>{checks++;console.log(`PASS ${checks}: ${message}`);};
async function open(viewport={width:390,height:844},pagePath='/__camera.html',profile=null) {
  const context=await browser.newContext({viewport,permissions:['camera']});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='cdnjs.cloudflare.com'&&url.pathname.includes('html5-qrcode'))return route.fulfill({body:decoder,contentType:'text/javascript'});
    if(url.origin!==base)return route.abort();
    return route.continue();
  });
  await page.addInitScript(profile=>{
    window.__streams=[];window.__codes=[];window.__controlCalls=[];
    if(profile){
      const supported=navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices);
      navigator.mediaDevices.getSupportedConstraints=()=>({...supported(),pointsOfInterest:profile.points!==false});
      if(profile.cameras)navigator.mediaDevices.enumerateDevices=async()=>[
        {kind:'videoinput',deviceId:'rear-wide',label:'Rear wide camera'},
        {kind:'videoinput',deviceId:'rear-close',label:'Rear close camera'},
      ];
    }
    const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{
      window.__mediaRequested=true;
      if(window.__delayMedia)await new Promise(r=>setTimeout(r,window.__delayMedia));
      if(window.__denyMedia)throw new DOMException('Permission denied','NotAllowedError');
      const requested=constraints.video?.deviceId?.exact;
      const stream=await get(profile?.cameras?{...constraints,video:{facingMode:'environment'}}:constraints);
      window.__streams.push(stream);
      if(profile){
        const track=stream.getVideoTracks()[0],getSettings=track.getSettings.bind(track),getConstraints=track.getConstraints.bind(track);
        let changes={},lastConstraints=getConstraints();
        track.getCapabilities=()=>profile.capabilities||{};
        track.getSettings=()=>({...getSettings(),zoom:1,torch:false,...changes,...(profile.cameras?{deviceId:requested||'rear-wide'}:{})});
        track.getConstraints=()=>lastConstraints;
        track.applyConstraints=async next=>{
          const patch=Object.assign({},...(next.advanced||[]));window.__controlCalls.push(patch);
          if(window.__controlDelay)await new Promise(r=>setTimeout(r,window.__controlDelay));
          if(window.__rejectFeature&&window.__rejectFeature in patch)throw new DOMException('Unsupported control','OverconstrainedError');
          if(profile.ignorePoints)delete patch.pointsOfInterest;
          lastConstraints=next;changes={...changes,...patch};
        };
      }
      return stream;
    };
  },profile);
  await page.goto(base+pagePath);
  await page.waitForFunction(()=>typeof Html5Qrcode==='function');
  // Capture callbacks for lifecycle tests. Real startup/rendering/no-code logic
  // still run in html5-qrcode. Separate image tests exercise real decoding.
  await page.evaluate(()=>{
    const original=Html5Qrcode.prototype.start;
    Html5Qrcode.prototype.start=function(camera,config,onCode,onMiss){window.__onCode=onCode;window.__onMiss=onMiss;return original.call(this,camera,config,onCode,onMiss);};
  });
  return {context,page,errors};
}
async function ready(page,selector) {
  await page.waitForFunction(selector=>{
    const el=document.querySelector(selector),v=el?.querySelector('video'),canvas=el?.querySelector('canvas');
    return el?.dataset.cameraState==='scanning'&&v?.readyState>=2&&v.clientWidth>50&&v.clientHeight>50&&canvas?.width>0;
  },selector);
}
async function init(page,continuous=false) {
  await page.evaluate(async continuous=>{const {Camera}=await import('/camera.js');window.cam=new Camera();await cam.start(document.getElementById('reader'),text=>window.__codes.push(text),{continuous});},continuous);
  await ready(page,'#reader');
}
try {
  {
    const {context,page}=await open();
    assert.equal(await page.locator('#reader').evaluate(el=>el.clientWidth),0);
    await page.evaluate(()=>{window.raw=new Html5Qrcode('reader');window.rawStart=raw.start({facingMode:'environment'},{fps:8,qrbox:{width:250,height:180}},()=>{}).catch(e=>{window.__rawError=String(e);});});
    await page.waitForFunction(()=>document.querySelector('#reader video'));
    await page.waitForTimeout(800);
    const width=await page.locator('#reader video').evaluate(v=>v.clientWidth);
    assert.equal(width,0,'Original scanner must reproduce the zero-width video');
    pass('reproduced original bug with real html5-qrcode: preview width = 0');
    await context.close();
  }
  for(const viewport of [{width:1280,height:900},{width:390,height:844},{width:320,height:640},{width:844,height:390}]) {
    const {context,page,errors}=await open(viewport);await init(page);
    await page.waitForTimeout(1100);await ready(page,'#reader');assert.deepEqual(errors,[]);
    await page.screenshot({path:`test-results/scanner-${viewport.width}x${viewport.height}.png`});
    await page.evaluate(async()=>{await cam.stop();});
    assert.equal(await page.evaluate(()=>__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
    assert.equal(await page.locator('#reader').evaluate(el=>el.clientWidth),0);
    await init(page);await ready(page,'#reader');
    pass(`visible and stable real video + stop/reopen at ${viewport.width}x${viewport.height}`);await context.close();
  }
  {
    const {context,page,errors}=await open();await init(page);
    await page.evaluate(()=>__onCode('TEST_SKU'));
    await page.waitForFunction(()=>__codes.length===1);
    await page.evaluate(()=>__onCode('LATE_CODE'));
    assert.deepEqual(await page.evaluate(()=>__codes),['TEST_SKU']);
    assert.equal(await page.locator('#reader video').count(),0);
    assert.deepEqual(errors,[]);pass('single scan closes only after a result; late callbacks ignored');await context.close();
  }
  const fullControls={capabilities:{torch:[false,true],zoom:{min:1,max:4,step:0.5},focusMode:['continuous','single-shot']},cameras:true};
  for(const viewport of [{width:390,height:844},{width:320,height:640},{width:844,height:390}]) {
    const {context,page,errors}=await open(viewport,'/__camera.html',fullControls);await init(page);
    await page.getByRole('button',{name:'Light on',exact:true}).click();
    await page.getByRole('button',{name:'Light off',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Light off',exact:true}).getAttribute('aria-pressed'),'true');
    const zoom=page.getByRole('slider');await zoom.focus();await zoom.press('Home');await zoom.press('ArrowRight');
    await page.waitForFunction(()=>__controlCalls.some(c=>c.zoom===1.5));
    await zoom.blur();
    await page.locator('video').scrollIntoViewIfNeeded();
    const bounds=await page.locator('video').boundingBox();
    await page.mouse.click(bounds.x+bounds.width*0.25,bounds.y+bounds.height*0.65);
    await page.waitForFunction(()=>__controlCalls.some(c=>c.focusMode==='continuous'&&c.pointsOfInterest));
    const focus=await page.evaluate(()=>__controlCalls.findLast(c=>c.pointsOfInterest));
    assert.ok(Math.abs(focus.pointsOfInterest[0].x-0.25)<0.02);
    assert.ok(Math.abs(focus.pointsOfInterest[0].y-0.65)<0.02);
    assert.equal(focus.torch,true);assert.equal(focus.zoom,1.5);
    assert.equal(await page.evaluate(()=>__controlCalls.some(c=>c.focusMode==='single-shot')),false,'Tapping must not lock an autofocus camera to a one-time attempt');
    const beforeRefocus=await page.evaluate(()=>__controlCalls.length);
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(before=>__controlCalls.length>before,beforeRefocus);
    const retried=await page.evaluate(()=>__controlCalls.at(-1));
    assert.deepEqual(retried.pointsOfInterest,focus.pointsOfInterest,'Refocus must retry the tapped area, not jump back to the centre');
    assert.equal(retried.focusMode,'continuous');
    assert.equal(await page.locator('.camera-focus-marker').isVisible(),true,'Button requests need the same visible feedback as taps');
    await ready(page,'#reader');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Controls fit viewport');
    await page.screenshot({path:`test-results/scanner-controls-${viewport.width}.png`,fullPage:true});
    await page.getByRole('button',{name:'Close camera',exact:true}).click();
    await page.waitForFunction(()=>__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    assert.deepEqual(errors,[]);pass(`light, hardware zoom, tap focus and close work at ${viewport.width}px`);await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',{capabilities:{}});await init(page);
    assert.equal(await page.getByRole('button',{name:'Light on',exact:true}).count(),0);
    assert.equal(await page.getByRole('slider').count(),0);
    assert.equal(await page.getByRole('button',{name:'Refocus',exact:true}).count(),0);
    assert.match(await page.locator('.camera-tools').textContent(),/Focus is controlled by your phone/);
    await page.locator('video').click({force:true});await ready(page,'#reader');
    assert.deepEqual(errors,[]);pass('unsupported controls are explained; tapping still leaves scanner open');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',fullControls);await init(page);
    await page.evaluate(()=>{__rejectFeature='torch';});
    await page.getByRole('button',{name:'Light on',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.camera-message').textContent.includes('could not change its light'));
    await ready(page,'#reader');
    await page.evaluate(()=>{__rejectFeature='pointsOfInterest';});
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.camera-message').textContent.includes('Tap-to-focus is unavailable'));
    assert.equal(await page.evaluate(()=>__controlCalls.at(-1).focusMode),'continuous');
    assert.equal(await page.getByRole('button',{name:'Refocus',exact:true}).isVisible(),false);
    await ready(page,'#reader');assert.deepEqual(errors,[]);
    pass('rejected light/point focus settings preserve scanning and fall back to autofocus');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',{...fullControls,points:false});await init(page);
    assert.equal(await page.getByRole('button',{name:'Refocus',exact:true}).count(),0);
    assert.match(await page.locator('.camera-tools').textContent(),/tap-to-focus is not available/);
    const before=await page.evaluate(()=>__controlCalls.length);
    await page.locator('video').click({force:true});
    assert.equal(await page.evaluate(()=>__controlCalls.length),before);
    assert.equal(await page.locator('.camera-focus-marker').isVisible(),false);
    await ready(page,'#reader');assert.deepEqual(errors,[]);
    pass('automatic-only focus shows no ineffective Refocus button or tapped-point marker');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',{capabilities:{focusMode:['single-shot']},points:false});await init(page);
    await page.locator('video').click({force:true});
    assert.equal(await page.locator('.camera-focus-marker').isVisible(),false);
    assert.equal(await page.evaluate(()=>__controlCalls.length),0);
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(()=>__controlCalls.some(c=>c.focusMode==='single-shot'));
    assert.match(await page.locator('.camera-tools').textContent(),/cannot focus at a tapped point/);
    await ready(page,'#reader');assert.deepEqual(errors,[]);
    pass('single-shot-only lenses retain Refocus without pretending to target taps');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',{...fullControls,ignorePoints:true});await init(page);
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.camera-message').textContent.includes('has not confirmed the point'));
    assert.equal(await page.locator('.camera-focus-marker').isVisible(),false);
    await ready(page,'#reader');assert.deepEqual(errors,[]);
    pass('silently ignored focus points are reported as unconfirmed, with scanning retained');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',fullControls);await init(page);
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(()=>__controlCalls.some(c=>c.pointsOfInterest));
    assert.deepEqual(await page.evaluate(()=>__controlCalls.at(-1).pointsOfInterest),[{x:0.5,y:0.5}]);
    await page.evaluate(()=>{__rejectFeature='pointsOfInterest';});
    await page.getByRole('button',{name:'Refocus',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.camera-message').textContent.includes('Tap-to-focus is unavailable'));
    await page.getByRole('button',{name:'Light on',exact:true}).click();
    await page.getByRole('button',{name:'Light off',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>'pointsOfInterest' in __controlCalls.at(-1)),false);
    await ready(page,'#reader');assert.deepEqual(errors,[]);
    pass('Refocus starts at centre; a later point rejection does not break light controls');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',fullControls);await init(page);
    await page.getByRole('combobox',{name:'Camera',exact:true}).selectOption('rear-close');await ready(page,'#reader');
    await page.waitForFunction(()=>__streams.length===2&&__streams[0].getTracks().every(t=>t.readyState==='ended'));
    assert.equal(await page.locator('video').count(),1);
    assert.equal(await page.getByRole('combobox',{name:'Camera',exact:true}).inputValue(),'rear-close');
    await page.evaluate(()=>{__controlDelay=300;});
    await page.getByRole('button',{name:'Light on',exact:true}).click();
    await page.getByRole('button',{name:'Close camera',exact:true}).click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('video').count(),0);
    assert.ok(await page.evaluate(()=>__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))));
    assert.deepEqual(errors,[]);pass('camera switch releases the old lens; closing during a delayed control cannot reopen it');await context.close();
  }
  {
    const {context,page,errors}=await open(undefined,'/__camera.html',fullControls);await init(page);
    await page.evaluate(()=>{__denyMedia=true;});
    await page.getByRole('combobox',{name:'Camera',exact:true}).selectOption('rear-close');
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(),/Tap Scan again/);
    await page.evaluate(()=>{__denyMedia=false;});await init(page);
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.waitForFunction(()=>__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    assert.deepEqual(errors,[]);pass('failed lens switch can retry; leaving the page releases the camera');await context.close();
  }
  {
    const {context,page,errors}=await open();await init(page,true);
    await page.evaluate(()=>{__onMiss?.('No barcode in frame');__onCode('ONE');});
    await page.waitForFunction(()=>__codes.length===1);await page.evaluate(()=>__onCode('TWO'));
    await page.waitForFunction(()=>__codes.length===2);await ready(page,'#reader');
    assert.deepEqual(errors,[]);pass('continuous scanning stays open across misses and two scan callbacks');await context.close();
  }
  {
    const {context,page,errors}=await open();
    await page.evaluate(async()=>{const {Camera}=await import('/camera.js');window.cam=new Camera();window.__delayMedia=300;window.opening=cam.start(document.getElementById('reader'),t=>__codes.push(t));});
    await page.waitForFunction(()=>__mediaRequested);
    await page.evaluate(async()=>{await cam.stop();await opening;});
    assert.equal(await page.locator('video').count(),0);
    assert.equal(await page.evaluate(()=>__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
    await page.evaluate(async()=>{__delayMedia=0;await Promise.all([cam.start(document.getElementById('reader'),t=>__codes.push('old:'+t)),cam.start(document.getElementById('other'),t=>__codes.push('new:'+t))]);});
    await ready(page,'#other');assert.equal(await page.locator('video').count(),1);assert.deepEqual(errors,[]);
    pass('stop during startup and rapid replacement do not leak or cross camera sessions');await context.close();
  }
  {
    const {context,page,errors}=await open();
    const error=await page.evaluate(async()=>{const {Camera}=await import('/camera.js');window.cam=new Camera();window.__denyMedia=true;try{await cam.start(document.getElementById('reader'),()=>{});}catch(e){return e.message;}});
    assert.match(error,/permission.*blocked/i);assert.equal(await page.locator('video').count(),0);
    await page.evaluate(()=>{__denyMedia=false;});await init(page);assert.deepEqual(errors,[]);
    pass('permission denial is explained and retry can reopen');await context.close();
  }
  for (const bcid of ['qrcode','code128']) {
    const {context,page,errors}=await open();
    const decoded=await page.evaluate(async bcid=>{
      const blob=await (await fetch(`/__${bcid}.png`)).blob();
      const box=document.getElementById('reader');box.style.display='block';
      const r=new Html5Qrcode('reader');try{return await r.scanFile(new File([blob],`${bcid}.png`,{type:'image/png'}),false);}finally{r.clear();}
    },bcid);
    assert.equal(decoded,'TEST_SKU');assert.deepEqual(errors,[]);pass(`real ${bcid} decoder returns TEST_SKU`);await context.close();
  }
  {
    const {context,page,errors}=await open({width:390,height:844},'/');
    await page.click('#scanSearch');await ready(page,'#searchScanner');
    await page.evaluate(()=>__onCode('TEST_SKU'));await page.waitForFunction(()=>document.querySelector('[data-scan=display2]')?.disabled===false);
    for(const [name,input] of [['display','displayLoc'],['display2','displayLoc2'],['location','location'],['loc2','loc2']]) {
      await page.click(`[data-scan=${name}]`);await ready(page,`#${name}Scanner`);
      await page.evaluate(()=>__onCode('NEW BIN'));
      await page.waitForFunction(input=>document.getElementById(input).value==='NEW BIN',input);
    }
    assert.deepEqual(errors,[]);assert.equal(writes.length,0);
    pass('Product Locations search and all four field scanners work without auto-saving');await context.close();
  }
  {
    const {context,page,errors}=await open({width:390,height:844},'/batch-scan.html');
    await page.click('#scanLocationBtn');await ready(page,'#locationScanner');
    await page.evaluate(()=>__onCode('MC1 D1'));await page.waitForFunction(()=>document.getElementById('batchLocation').value==='MC1 D1');
    await page.click('#startBtn');await ready(page,'#productScanner');await page.waitForTimeout(1100);await ready(page,'#productScanner');
    await page.click('#stopBtn');await page.waitForFunction(()=>document.querySelectorAll('video').length===0);assert.deepEqual(errors,[]);assert.equal(writes.length,0);
    pass('Batch Scan destination camera + continuous product camera stay open until Stop');await context.close();
  }
  {
    const {context,page,errors}=await open({width:390,height:844},'/location-viewer.html');
    await page.click('#scanLocation');await ready(page,'#locationScanner');await page.evaluate(()=>__onCode('Window 1'));
    await page.waitForFunction(()=>document.getElementById('locationInput').value==='Window 1');
    await page.click('#scanLocation');await ready(page,'#locationScanner');assert.deepEqual(errors,[]);
    pass('Location Viewer camera scans and reopens');await context.close();
  }
  assert.equal(writes.length,0);console.log(`CAMERA CHECKS COMPLETE: ${checks} passed. Real scanner library; virtual camera, not physical devices. Zero live writes.`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}

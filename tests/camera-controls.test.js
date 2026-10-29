import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFeatures, zoomValue, focusPoint, CameraSettings } from '../public/camera-controls.js';

test('camera controls are offered only for advertised hardware capabilities', () => {
  assert.deepEqual(cameraFeatures(), {torch:false,zoom:null,focus:null,continuousFocus:false,points:false});
  const supported = cameraFeatures({torch:[false,true],zoom:{min:1,max:4,step:0.25},focusMode:['continuous','single-shot']},{pointsOfInterest:true});
  assert.equal(supported.torch,true); assert.equal(supported.focus,'single-shot'); assert.equal(supported.continuousFocus,true); assert.equal(supported.points,true);
  assert.equal(cameraFeatures({torch:true}).torch,true);
  assert.equal(cameraFeatures({torch:[false],zoom:{min:1,max:1},focusMode:['manual']}).focus,null);
  assert.equal(cameraFeatures({torch:[false],zoom:{min:1,max:1}}).zoom,null);
  assert.equal(cameraFeatures({zoom:{min:NaN,max:10}}).zoom,null);
});
test('zoom is clamped to hardware range and steps; tap focus uses normalized sensor coordinates', () => {
  const range = {min:1,max:4,step:0.25};
  assert.equal(zoomValue(2.37,range),2.25); assert.equal(zoomValue(999,range),4); assert.equal(zoomValue(-1,range),1);
  assert.throws(()=>zoomValue('bad',range));
  const rect = {left:20,top:40,width:200,height:100};
  assert.deepEqual(focusPoint(70,115,rect),{x:0.25,y:0.75});
  assert.deepEqual(focusPoint(70,115,rect,true),{x:0.75,y:0.75});
  assert.deepEqual(focusPoint(-1,999,rect),{x:0,y:1});
});
test('controls serialize and preserve capture, light and zoom when refocusing', async () => {
  let constraints={deviceId:{exact:'rear'},width:{ideal:1280},advanced:[{exposureMode:'continuous'}]};
  let inFlight=0,maxFlight=0; const calls=[];
  const track={readyState:'live',getConstraints:()=>constraints,async applyConstraints(c){maxFlight=Math.max(maxFlight,++inFlight);await new Promise(r=>setTimeout(r,2));calls.push(c);constraints=c;inFlight--;}};
  const controls=new CameraSettings(track);
  await Promise.all([controls.apply({torch:true}),controls.apply({zoom:2}),controls.apply({focusMode:'single-shot',pointsOfInterest:[{x:0.2,y:0.8}]})]);
  assert.equal(maxFlight,1); assert.equal(calls.length,3);
  assert.deepEqual(calls[2].deviceId,{exact:'rear'});assert.deepEqual(calls[2].width,{ideal:1280});
  assert.deepEqual(calls[2].advanced,[{exposureMode:'continuous'},{torch:true,zoom:2,focusMode:'single-shot',pointsOfInterest:[{x:0.2,y:0.8}]}]);
});
test('failed setting does not poison the control queue or retain the failed constraint', async () => {
  const calls=[]; const track={readyState:'live',async applyConstraints(c){calls.push(c);if(c.advanced.at(-1).torch)throw Error('No torch');}};
  const controls=new CameraSettings(track);
  await assert.rejects(controls.apply({torch:true}));
  assert.equal(await controls.apply({zoom:2}),true);
  assert.deepEqual(calls[1].advanced,[{zoom:2}]);
  assert.equal(track.readyState,'live');
});
test('stopping while a setting is in flight cancels queued controls and late UI success', async () => {
  let finish;let calls=0;
  const track={readyState:'live',applyConstraints(){calls++;return new Promise(r=>{finish=r;});}};
  const controls=new CameraSettings(track);
  const first=controls.apply({zoom:2}); await Promise.resolve();
  const queued=controls.apply({torch:true});controls.close();track.readyState='ended';finish();
  assert.equal(await first,false);assert.equal(await queued,false);assert.equal(calls,1);
});

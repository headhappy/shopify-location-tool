import test from 'node:test';
import assert from 'node:assert/strict';
import {locationTextLayout,locationTextWarning,renderLocationText} from '../public/label-location-layout.js';

for (const code of ['BLUE 2 BIN 1','BLUE 2 BIN 14','BLUE 2 BIN 140','BLUE 2 BIN 1400','BLUE 2 BIN14','BLUE 2 BIN-14','Blue 2 bin 14']) {
  test(`preserves and splits ${code}`, () => {
    const layout=locationTextLayout(code);
    assert.equal(layout.lines.length,2);
    assert.equal(layout.lines.join(' '),code);
    assert.equal(layout.code,code);
    assert.equal(layout.sizes.length,2);
    assert.ok(layout.sizes.every(n=>n>0&&n<=4.5));
  });
}
test('long names use both lines without losing text',()=>{
  const code='UPSTAIRS STOCKROOM BLUE SHELF';
  const layout=locationTextLayout(code);
  assert.equal(layout.lines.length,2);
  assert.equal(layout.lines.join(' '),code);
});
test('single codes have no arbitrary character cutoff',()=>{
  const code='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  assert.equal(locationTextLayout(code).lines.join(' '),code);
  assert.ok(locationTextWarning(code));
});
test('HTML is escaped and original code is available to assistive technology',()=>{
  const code='BLUE <2> & "red" BIN 14';
  const html=renderLocationText(code,'BULK');
  assert.ok(html.includes('&lt;2&gt; &amp; &quot;red&quot;'));
  assert.ok(html.includes('aria-label='));
  assert.ok(!html.includes('<2>'));
  assert.ok(!html.includes('ellipsis'));
});
test('empty and numeric values cannot break rendering',()=>{
  assert.deepEqual(locationTextLayout(null).lines,[]);
  assert.equal(locationTextLayout(123).code,'123');
});

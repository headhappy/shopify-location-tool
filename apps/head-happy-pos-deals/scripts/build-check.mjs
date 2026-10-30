import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const appConfig = await readFile('shopify.app.toml', 'utf8');
const scopes = appConfig.match(/^scopes\s*=\s*"([^"]*)"\s*$/m)?.[1].split(',').map((v) => v.trim()).sort();
assert.deepEqual(scopes, ['read_inventory', 'read_products'], 'Pilot must keep its two read-only Admin scopes.');
const extensionConfig = await readFile('extensions/head-happy-deals/shopify.extension.toml', 'utf8');
assert.match(extensionConfig, /api_version = "2026-10"/);
assert.match(extensionConfig, /target = "pos.home.tile.render"/);
assert.match(extensionConfig, /target = "pos.home.modal.render"/);
const result = await build({
  entryPoints: ['extensions/head-happy-deals/src/Tile.jsx', 'extensions/head-happy-deals/src/Modal.jsx'],
  outdir: 'build-check', bundle: true, write: false, minify: true, format: 'esm',
  target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact',
});
for (const file of result.outputFiles) {
  assert.ok(file.contents.byteLength < 64 * 1024, 'POS bundle exceeds 64 KiB');
  console.log(`${file.path}: ${file.contents.byteLength} bytes`);
}
console.log('Read-only scope guard and offline extension bundles passed. Run pnpm validate and pnpm build with Shopify login before release.');

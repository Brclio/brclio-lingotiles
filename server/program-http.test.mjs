import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createHandler } from './index.mjs';
import { createCloudflareHandler } from './cloudflare.mjs';
import { StoreError } from './github-store.mjs';

const revision = 'c'.repeat(24);
const data = { total: 100000, stages: [{ id: 'primary' }] };
const body = JSON.stringify(data);
const checksum = createHash('sha256').update(body).digest('hex');
function programStore() {
  const files = {
    'catalog/current.json': { schemaVersion: 1, revision, manifestPath: `releases/${revision}/manifest.json`, publishedAt: '2026-10-28T08:00:00.000Z' },
    [`releases/${revision}/manifest.json`]: { schemaVersion: 1, revision, files: [{ path: 'vocabulary/manifest.json', sha256: checksum, bytes: Buffer.byteLength(body) }] },
    [`releases/${revision}/vocabulary/manifest.json`]: data,
  };
  return { transaction: async callback => callback({ get: async path => structuredClone(files[path] ?? null) }) };
}
const baseConfig = { origin: 'https://lingo.brclio.com', production: true, sessionSecret: 'x'.repeat(48), googleEnabled: false, storageConfigured: false, serveStatic: false, trustProxy: false };
async function nodeFixture(t, overrides = {}) {
  const server = createServer(createHandler({ store: null, programStore: programStore(), config: baseConfig, ...overrides }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('public Node program API returns verified JSON with cache validators and 304', async t => {
  const base = await nodeFixture(t);
  const response = await fetch(`${base}/api/program/vocabulary/manifest.json`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('ETag'), `"${checksum}"`);
  assert.equal(response.headers.get('X-Program-Revision'), revision);
  assert.match(response.headers.get('Cache-Control'), /max-age=60/);
  const cached = await fetch(`${base}/api/program/vocabulary/manifest.json`, { headers: { 'If-None-Match': `W/"${checksum}"` } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  const pinned = await fetch(`${base}/api/program/releases/${revision}/vocabulary/manifest.json`);
  assert.equal(pinned.status, 200);
  assert.match(pinned.headers.get('Cache-Control'), /immutable/);
});

test('program errors preserve safe 404 statuses and hide operational installation details', async t => {
  const base = await nodeFixture(t);
  const missing = await fetch(`${base}/api/program/vocabulary/missing.json`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  const blocked = await fetch(`${base}/api/program/users/secret/profile.json`);
  assert.equal(blocked.status, 404);
  const broken = await nodeFixture(t, { programStore: { transaction: async () => { throw new StoreError('Install App at /Users/secret.pem with private-key-token', 503); } } });
  const unavailable = await fetch(`${broken}/api/program/vocabulary/manifest.json`);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
  assert.ok(!(await unavailable.text()).includes('secret'));
});

test('Cloudflare adapter uses the same public program route and bodyless conditional responses', async () => {
  const handle = createCloudflareHandler({ store: null, programStore: programStore(), config: baseConfig });
  const url = 'https://lingo.brclio.com/api/program/vocabulary/manifest.json';
  const response = await handle(new Request(url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), data);
  assert.equal(response.headers.get('ETag'), `"${checksum}"`);
  const cached = await handle(new Request(url, { headers: { 'If-None-Match': `"other", "${checksum}"` } }));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  assert.match(cached.headers.get('Cache-Control'), /max-age=60/);
});

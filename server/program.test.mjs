import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readProgramData } from './program.mjs';

const revision = 'a'.repeat(24), previous = 'b'.repeat(24);
const file = { stages: [{ id: 'primary', count: 662 }], total: 100_000 };
const body = JSON.stringify(file);
const checksum = createHash('sha256').update(body).digest('hex');
const manifest = { schemaVersion: 1, revision, vocabularyTotal: 100_000, files: [{ path: 'vocabulary/manifest.json', bytes: Buffer.byteLength(body), sha256: checksum }] };
const pointer = { schemaVersion: 1, revision, manifestPath: `releases/${revision}/manifest.json`, publishedAt: '2026-10-28T08:00:00.000Z' };
function storeFor(extra = {}) {
  const data = {
    'catalog/current.json': pointer,
    [`releases/${revision}/manifest.json`]: manifest,
    [`releases/${revision}/vocabulary/manifest.json`]: file,
    ...extra,
  };
  const reads = [];
  return { reads, data, transaction: async callback => callback({ get: async path => { reads.push(path); return structuredClone(data[path] ?? null); } }) };
}

test('current catalog, manifest and listed shards return matching hashes and short cache headers', async () => {
  const store = storeFor();
  const value = await readProgramData(store, 'vocabulary/manifest.json');
  assert.equal(value.body, body);
  assert.deepEqual(value.value, file);
  assert.equal(value.etag, `"${checksum}"`);
  assert.equal(value.revision, revision);
  assert.match(value.cacheControl, /max-age=60/);
  assert.equal(value.contentType, 'application/json; charset=utf-8');
  assert.deepEqual((await readProgramData(store, 'catalog/current.json')).value, pointer);
  assert.deepEqual((await readProgramData(store, 'manifest.json')).value, manifest);
});

test('versioned URLs can read retained revisions with immutable caching', async () => {
  const store = storeFor({
    [`releases/${previous}/manifest.json`]: { ...manifest, revision: previous },
    [`releases/${previous}/vocabulary/manifest.json`]: file,
  });
  const result = await readProgramData(store, `releases/${previous}/vocabulary/manifest.json`);
  assert.equal(result.revision, previous);
  assert.match(result.cacheControl, /immutable/);
  assert.equal(result.publishedAt, undefined);
  assert.ok(!store.reads.includes('catalog/current.json'));
});

test('traversal, credentials and unknown files never reach arbitrary repository paths', async () => {
  const store = storeFor({ 'auth/email/secret.json': { secret: true } });
  for (const path of ['../auth/email/secret.json', 'auth/email/secret.json', 'vocabulary/../secret.json', 'vocabulary/%2e%2e.json', '/vocabulary/manifest.json', 'vocabulary//manifest.json', 'vocabulary/manifest.json?token=x', `releases/${revision}/auth/email/secret.json`]) {
    await assert.rejects(readProgramData(store, path), { status: 404 });
  }
  assert.deepEqual(store.reads, []);
  await assert.rejects(readProgramData(store, 'vocabulary/unlisted.json'), { status: 404 });
  assert.ok(!store.reads.some(path => path.includes('unlisted.json') || path.includes('secret.json')));
});

test('unpublished and corrupt pointers, manifests and shards fail closed', async () => {
  await assert.rejects(readProgramData(storeFor({ 'catalog/current.json': null }), 'manifest.json'), { status: 503 });
  await assert.rejects(readProgramData(storeFor({ 'catalog/current.json': { ...pointer, manifestPath: 'auth/email/secret.json' } }), 'manifest.json'), { status: 503 });
  await assert.rejects(readProgramData(storeFor({ [`releases/${revision}/manifest.json`]: { ...manifest, files: [{ ...manifest.files[0], path: 'users/account/profile.json' }] } }), 'manifest.json'), { status: 503 });
  await assert.rejects(readProgramData(storeFor({ [`releases/${revision}/vocabulary/manifest.json`]: { tampered: true } }), 'vocabulary/manifest.json'), { status: 503 });
  await assert.rejects(readProgramData(storeFor(), `releases/${previous}/manifest.json`), { status: 404 });
});

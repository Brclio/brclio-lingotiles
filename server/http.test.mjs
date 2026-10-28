import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createHandler } from './index.mjs';

function memoryStore() {
  const values = new Map();
  let queue = Promise.resolve();
  return {
    values,
    async get(path) { return structuredClone(values.get(path) ?? null); },
    async list(prefix) { return [...values].filter(([path]) => path.startsWith(prefix + '/')).map(([path, value]) => ({ path, value: structuredClone(value) })); },
    transaction(mutator) {
      const operation = queue.then(async () => {
        const draft = new Map(structuredClone([...values]));
        const result = await mutator({ get: async path => structuredClone(draft.get(path) ?? null), set: (path, value) => draft.set(path, structuredClone(value)), delete: path => draft.delete(path), list: async prefix => [...draft].filter(([path]) => path.startsWith(prefix + '/')).map(([path, value]) => ({ path, value: structuredClone(value) })) });
        values.clear();
        draft.forEach((value, key) => values.set(key, value));
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
async function fixture(t, { store = memoryStore(), config: overrides = {}, authOptions } = {}) {
  const config = { origin: 'http://127.0.0.1', production: false, sessionSecret: 'x'.repeat(48), googleEnabled: false, storageConfigured: true, serveStatic: true, trustProxy: false, ...overrides };
  const server = createServer(createHandler({ store, config, authOptions }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { base, config, store, post };
}
const account = { email: 'alice@example.com', name: 'Alice', password: 'correct horse battery staple' };
const sessionCookie = response => response.headers.getSetCookie().find(value => value.startsWith('lingotiles-session='))?.split(';')[0];
async function register(app, details = account) {
  const response = await app.post('/api/auth/register', details);
  assert.equal(response.status, 201);
  return { user: (await response.json()).user, cookie: sessionCookie(response) };
}

test('HTTP rejects cross-origin writes, missing Origin and wrong content types before mutation', async t => {
  const app = await fixture(t);
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await app.post('/api/auth/register', account, headers);
    assert.equal(response.status, 403);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  const wrongType = await app.post('/api/auth/register', account, { 'Content-Type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  const brokenJson = await fetch(app.base + '/api/auth/register', { method: 'POST', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(brokenJson.status, 400);
  const arrayBody = await app.post('/api/auth/register', [account]);
  assert.equal(arrayBody.status, 400);
  assert.equal(app.store.values.size, 0);
});

test('HTTP rejects declared oversized bodies with a JSON error', async t => {
  const app = await fixture(t);
  const response = await app.post('/api/auth/register', { ...account, ignored: 'x'.repeat(17 * 1024) });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /过大/);
  assert.equal(app.store.values.size, 0);
});

test('HTTP rejects chunked oversized bodies without dropping the error response', async t => {
  const app = await fixture(t);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"extra":"' + 'x'.repeat(10 * 1024)));
    controller.enqueue(new TextEncoder().encode('x'.repeat(10 * 1024) + '"}'));
    controller.close();
  } });
  const response = await fetch(app.base + '/api/auth/register', { method: 'POST', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /过大/);
  assert.equal(app.store.values.size, 0);
});

test('HTTP requires authentication for all learning endpoints', async t => {
  const app = await fixture(t);
  for (const response of [await fetch(app.base + '/api/learning'), await app.post('/api/learning/sync', {})]) {
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /登录/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('HTTP registration, session, learning sync and logout preserve account isolation', async t => {
  const app = await fixture(t);
  const alice = await register(app);
  const bob = await register(app, { ...account, email: 'bob@example.com', name: 'Bob' });
  const current = await fetch(app.base + '/api/auth/session', { headers: { Cookie: alice.cookie } });
  assert.equal((await current.json()).user.id, alice.user.id);
  const now = new Date().toISOString();
  const payload = {
    // Client supplied identities are ignored; only the cookie determines the owner.
    userId: bob.user.id,
    progress: { seen: ['apple'], saved: ['apple'], completed: { '1': { stars: 3, bestScore: 100, bestTime: 7 } }, sessions: 1, lastPlayed: now.slice(0, 10), streak: 1 },
    favoriteChanges: [{ wordId: 'apple', saved: true, updatedAt: now }],
    cards: [{ wordId: 'apple', word: 'apple', pos: 'n.', meaning: '苹果', sourceId: 'run-1', collectedAt: now }],
    records: [{ id: 'run-1', levelId: 1, levelTitle: '词汇花园', mode: 'theme', wordCount: 1, score: 100, stars: 3, assists: 0, gameSeconds: 7, studySeconds: 5, totalSeconds: 12, completedAt: now }],
    preferences: { matchAnimation: true, updatedAt: now },
  };
  const synced = await app.post('/api/learning/sync', payload, { Cookie: alice.cookie, 'X-LingoTiles-Account': alice.user.id });
  assert.equal(synced.status, 200);
  const learning = await synced.json();
  assert.deepEqual(learning.progress.saved, ['apple']);
  assert.equal(learning.cards[0].count, 1);
  assert.equal(learning.records[0].id, 'run-1');
  assert.equal(learning.preferences.matchAnimation, true);
  const retried = await app.post('/api/learning/sync', payload, { Cookie: alice.cookie, 'X-LingoTiles-Account': alice.user.id });
  const afterRetry = await retried.json();
  assert.equal(afterRetry.cards[0].count, 1);
  assert.equal(afterRetry.records.length, 1);
  const bobView = await fetch(app.base + '/api/learning?userId=' + alice.user.id, { headers: { Cookie: bob.cookie, 'X-LingoTiles-Account': bob.user.id } });
  const bobLearning = await bobView.json();
  assert.deepEqual(bobLearning.progress.saved, []);
  assert.deepEqual(bobLearning.cards, []);
  assert.deepEqual(bobLearning.records, []);
  for (const expected of [undefined, alice.user.id]) {
    const headers = { Cookie: bob.cookie, ...(expected ? { 'X-LingoTiles-Account': expected } : {}) };
    for (const response of [await fetch(app.base + '/api/learning', { headers }), await app.post('/api/learning/sync', payload, headers)]) {
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /当前登录账号已变化/);
    }
  }
  const bobAfterMismatchedWrites = await fetch(app.base + '/api/learning', { headers: { Cookie: bob.cookie, 'X-LingoTiles-Account': bob.user.id } });
  assert.deepEqual((await bobAfterMismatchedWrites.json()).cards, []);
  assert.ok([...app.store.values.keys()].some(path => path.startsWith(`users/${alice.user.id}/cards/`)));
  assert.ok(![...app.store.values.keys()].some(path => path.startsWith(`users/${bob.user.id}/cards/`)));
  const invalid = await app.post('/api/learning/sync', { favoriteChanges: [{ wordId: '../../escape', saved: true, updatedAt: now }] }, { Cookie: alice.cookie, 'X-LingoTiles-Account': alice.user.id });
  assert.equal(invalid.status, 400);
  const logout = await app.post('/api/auth/logout', undefined, { Cookie: alice.cookie, 'X-LingoTiles-Account': alice.user.id });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await (await fetch(app.base + '/api/auth/session', { headers: { Cookie: alice.cookie } })).json()).user, null);
  assert.equal((await fetch(app.base + '/api/learning', { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await fetch(app.base + '/api/learning', { headers: { Cookie: bob.cookie, 'X-LingoTiles-Account': bob.user.id } })).status, 200);
});

test('HTTP uses safe service errors without exposing exception details or private key paths', async t => {
  const secret = '-----BEGIN PRIVATE KEY----- /Users/private/secret.pem installation-token';
  const store = { get: async () => { throw new Error(secret); }, transaction: async () => { throw new Error(secret); } };
  const app = await fixture(t, { store });
  const response = await app.post('/api/auth/login', account);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes('PRIVATE KEY'));
  assert.deepEqual(Object.keys(JSON.parse(body)), ['error']);
});

test('HTTP invalid Google callback clears only OAuth state and preserves the existing session', async t => {
  const app = await fixture(t, { config: { googleEnabled: true, googleClientId: 'test-client', googleClientSecret: 'test-secret' } });
  const alice = await register(app);
  const started = await fetch(app.base + '/api/auth/google', { redirect: 'manual' });
  assert.equal(started.status, 303);
  const oauthCookie = started.headers.getSetCookie()[0].split(';')[0];
  const callback = await fetch(app.base + '/api/auth/google/callback?state=changed&code=irrelevant', { redirect: 'manual', headers: { Cookie: `${alice.cookie}; ${oauthCookie}` } });
  assert.equal(callback.status, 303);
  assert.ok(new URL(callback.headers.get('Location'), app.base).searchParams.has('authError'));
  const cleared = callback.headers.getSetCookie();
  assert.equal(cleared.length, 1);
  assert.match(cleared[0], /^lingotiles-oauth=;.*Max-Age=0/);
  assert.equal((await (await fetch(app.base + '/api/auth/session', { headers: { Cookie: alice.cookie } })).json()).user.id, alice.user.id);
});

test('HTTP serves the built app with CSP and refuses private files and path traversal', { skip: !existsSync(new URL('../dist/index.html', import.meta.url)) }, async t => {
  const app = await fixture(t);
  const response = await fetch(app.base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /<div id="root">/);
  const csp = response.headers.get('Content-Security-Policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /style-src 'self' 'unsafe-inline';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  const script = html.match(/src="([^"]+\.js)"/)[1];
  const asset = await fetch(new URL(script, app.base + '/'));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('Content-Type'), /javascript/);
  assert.match(asset.headers.get('Cache-Control'), /immutable/);
  for (const path of ['/package.json', '/.env', '/%2e%2e%2f.env', '/api/not-a-route']) {
    const missing = await fetch(app.base + path);
    assert.equal(missing.status, 404);
    assert.deepEqual(Object.keys(await missing.json()), ['error']);
  }
});

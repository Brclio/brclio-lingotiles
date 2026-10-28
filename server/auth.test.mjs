import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService, hash, normalizeEmail } from './auth.mjs';
import { loadConfig } from './config.mjs';

function memoryStore() {
  const values = new Map();
  let queue = Promise.resolve();
  return {
    values,
    async get(path) { return structuredClone(values.get(path) ?? null); },
    async list(prefix) { return [...values].filter(([path]) => path.startsWith(prefix)).map(([path, value]) => ({ path, value: structuredClone(value) })); },
    transaction(mutator) {
      const operation = queue.then(async () => {
        const draft = new Map(structuredClone([...values]));
        const result = await mutator({ get: async path => structuredClone(draft.get(path) ?? null), set: (path, value) => draft.set(path, structuredClone(value)), delete: path => draft.delete(path), list: async prefix => [...draft].filter(([path]) => path.startsWith(prefix)).map(([path, value]) => ({ path, value })) });
        values.clear();
        draft.forEach((value, key) => values.set(key, value));
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
const config = { origin: 'http://127.0.0.1:5173', production: false, sessionSecret: 'x'.repeat(48), googleClientId: 'test-google-client', googleClientSecret: 'test-google-secret', googleEnabled: true };
const details = { name: '英语学习者', email: 'Learner@Example.com', password: 'correct horse battery staple' };
const cookieHeader = cookie => cookie.split(';')[0];
const expectedStatus = status => error => error.status === status;

test('server config validates origins and keeps Google disabled without both credentials', () => {
  const value = loadConfig({});
  assert.equal(value.port, 8787);
  assert.equal(value.googleEnabled, false);
  assert.equal(value.storageConfigured, false);
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://example.com/path' }), /APP_ORIGIN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.throws(() => loadConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }), /SESSION_SECRET/);
});

test('email normalization and password/name validation reject malformed input', async () => {
  const service = createAuthService({ store: memoryStore(), config });
  assert.equal(normalizeEmail(' Learner@Example.com '), 'learner@example.com');
  await assert.rejects(service.register({ ...details, password: 'short' }), expectedStatus(400));
  await assert.rejects(service.register({ ...details, name: 'bad\nname' }), expectedStatus(400));
  await assert.rejects(service.register({ ...details, email: 'bad-email' }), expectedStatus(400));
});

test('registration persists a salted hash and an opaque hashed session, never plaintext credentials', async () => {
  const store = memoryStore();
  const service = createAuthService({ store, config });
  const registered = await service.register(details);
  assert.equal(registered.user.email, 'learner@example.com');
  assert.equal(registered.user.provider, 'password');
  assert.match(registered.cookie, /HttpOnly; SameSite=Lax/);
  const serialized = JSON.stringify([...store.values]);
  assert.ok(!serialized.includes(details.password));
  const token = cookieHeader(registered.cookie).split('=')[1];
  assert.ok(!serialized.includes(token));
  const credential = await store.get(`users/${registered.user.id}/credentials/password.json`);
  assert.equal(credential.algorithm, 'scrypt');
  assert.equal(credential.hash.length, 128);
  const current = await service.currentUser(cookieHeader(registered.cookie));
  assert.deepEqual(current, registered.user);
  assert.ok(!('hash' in current));
  await assert.rejects(service.register(details), expectedStatus(409));
});

test('concurrent duplicate registrations atomically create only one account', async () => {
  const store = memoryStore();
  const service = createAuthService({ store, config });
  const results = await Promise.allSettled([service.register(details), service.register(details)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal([...store.values.keys()].filter(path => path.endsWith('/profile.json')).length, 1);
});

test('password login rejects invalid credentials and rotates the existing session', async () => {
  const store = memoryStore();
  const service = createAuthService({ store, config });
  const registered = await service.register(details);
  await assert.rejects(service.login({ email: details.email, password: 'wrong' }), expectedStatus(401));
  await assert.rejects(service.login({ email: 'missing@example.com', password: 'wrong' }), expectedStatus(401));
  const loggedIn = await service.login(details, '127.0.0.1', cookieHeader(registered.cookie));
  assert.notEqual(loggedIn.cookie, registered.cookie);
  assert.equal(await service.currentUser(cookieHeader(registered.cookie)), null);
  assert.equal((await service.currentUser(cookieHeader(loggedIn.cookie))).id, registered.user.id);
  await service.logout(cookieHeader(loggedIn.cookie));
  assert.equal(await service.currentUser(cookieHeader(loggedIn.cookie)), null);
});

test('sessions expire and production cookies use the host prefix and Secure', async () => {
  let time = Date.now();
  const service = createAuthService({ store: memoryStore(), config: { ...config, production: true }, now: () => time });
  const registered = await service.register(details);
  assert.match(registered.cookie, /^__Host-lingotiles-session=/);
  assert.match(registered.cookie, /; Secure$/);
  time += 31 * 24 * 60 * 60 * 1000;
  assert.equal(await service.currentUser(cookieHeader(registered.cookie)), null);
});

test('rate limits survive new service instances and expire after the window', async () => {
  const store = memoryStore();
  let time = Date.now();
  const service = createAuthService({ store, config, now: () => time });
  await service.consumeRateLimit(['ip:127.0.0.1'], 2, 1000);
  await service.consumeRateLimit(['ip:127.0.0.1'], 2, 1000);
  const another = createAuthService({ store, config, now: () => time });
  await assert.rejects(another.consumeRateLimit(['ip:127.0.0.1'], 2, 1000), expectedStatus(429));
  time += 1001;
  await another.consumeRateLimit(['ip:127.0.0.1'], 2, 1000);
});

function googleFixture({ claims = {}, email = 'google@example.com' } = {}) {
  const store = memoryStore();
  let state;
  const service = createAuthService({ store, config, fetch: async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('code'), 'one-time-code');
    assert.equal(options.body.get('code_verifier'), state.verifier);
    return { ok: true, json: async () => ({ id_token: 'signed-google-token' }) };
  }, verifyGoogleToken: async token => {
    assert.equal(token, 'signed-google-token');
    return { sub: 'google-subject-123', email, email_verified: true, nonce: state.nonce, name: 'Google Learner', ...claims };
  } });
  return { store, service, async start() {
    const result = await service.googleStart();
    const raw = decodeURIComponent(cookieHeader(result.cookie).split('=')[1]);
    state = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString());
    const callback = new URL(`${config.origin}/api/auth/google/callback`);
    callback.search = new URLSearchParams({ state: state.state, code: 'one-time-code' });
    return { result, state, callback };
  } };
}

test('Google OAuth uses state, PKCE and nonce, stores subject index and creates a session', async () => {
  const fixture = googleFixture();
  const { result, callback } = await fixture.start();
  const destination = new URL(result.location);
  assert.equal(destination.origin, 'https://accounts.google.com');
  assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destination.searchParams.get('nonce'));
  const finished = await fixture.service.googleCallback(callback, cookieHeader(result.cookie));
  assert.equal(finished.user.provider, 'google');
  assert.equal(finished.user.email, 'google@example.com');
  assert.ok(await fixture.store.get(`auth/google/${hash('google-subject-123')}.json`));
  assert.equal(finished.cookies.length, 2);
  assert.equal((await fixture.service.currentUser(cookieHeader(finished.cookies[1]))).id, finished.user.id);
  await assert.rejects(fixture.service.googleCallback(callback, cookieHeader(result.cookie)), expectedStatus(400));
});

test('Google rejects changed state, tampered cookies, unverified emails and nonce mismatch', async () => {
  const fixture = googleFixture();
  const { result, callback } = await fixture.start();
  callback.searchParams.set('state', 'attacker-state');
  await assert.rejects(fixture.service.googleCallback(callback, cookieHeader(result.cookie)), expectedStatus(400));
  await assert.rejects(fixture.service.googleCallback(callback, `${cookieHeader(result.cookie)}changed`), expectedStatus(400));
  for (const claims of [{ email_verified: false }, { nonce: 'different-nonce' }, { azp: 'another-client' }]) {
    const invalid = googleFixture({ claims });
    const pending = await invalid.start();
    await assert.rejects(invalid.service.googleCallback(pending.callback, cookieHeader(pending.result.cookie)), expectedStatus(401));
    assert.equal([...invalid.store.values.keys()].filter(path => path.endsWith('/profile.json')).length, 0);
  }
});

test('Google never silently links a subject to an existing password account with the same email', async () => {
  const fixture = googleFixture({ email: 'learner@example.com' });
  const passwordAccount = await fixture.service.register(details);
  const pending = await fixture.start();
  await assert.rejects(fixture.service.googleCallback(pending.callback, cookieHeader(pending.result.cookie)), expectedStatus(409));
  assert.equal(await fixture.store.get(`auth/google/${hash('google-subject-123')}.json`), null);
  assert.equal((await fixture.service.currentUser(cookieHeader(passwordAccount.cookie))).id, passwordAccount.user.id);
});

test('missing storage or disabled Google returns actionable service errors', async () => {
  const unavailable = createAuthService({ store: null, config });
  assert.equal(await unavailable.currentUser(''), null);
  await assert.rejects(unavailable.register(details), expectedStatus(503));
  const disabled = createAuthService({ store: memoryStore(), config: { ...config, googleEnabled: false } });
  await assert.rejects(disabled.googleStart(), expectedStatus(503));
});

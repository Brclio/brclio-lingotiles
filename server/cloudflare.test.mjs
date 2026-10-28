import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareHandler } from './cloudflare.mjs';

const origin = 'https://lingo.brclio.com';
function memoryStore() {
  const data = new Map();
  return {
    data,
    get: async path => structuredClone(data.get(path) ?? null),
    list: async prefix => [...data].filter(([path]) => path.startsWith(prefix + '/')).map(([path, value]) => ({ path, value: structuredClone(value) })),
    async transaction(mutator) {
      const draft = new Map(structuredClone([...data]));
      const result = await mutator({ get: async path => structuredClone(draft.get(path) ?? null), list: async prefix => [...draft].filter(([path]) => path.startsWith(prefix + '/')).map(([path, value]) => ({ path, value: structuredClone(value) })), set: (path, value) => draft.set(path, structuredClone(value)), delete: path => draft.delete(path) });
      data.clear(); draft.forEach((value, key) => data.set(key, value)); return result;
    },
  };
}
function request(path, body, headers = {}) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const details = { name: 'Pages learner', email: 'pages@example.com', password: 'pages learner correct horse' };

test('Cloudflare reads only explicit bindings and never follows a local private key path', async () => {
  const handler = createCloudflareHandler({ env: { APP_ORIGIN: origin, GITHUB_APP_PRIVATE_KEY_PATH: '/must-not-be-opened/private-key.pem' } });
  const response = await handler(request('/api/auth/session'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null, googleEnabled: false, configured: false });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('Cloudflare Web Request streams and response cookies use the shared registration and session logic', async () => {
  const store = memoryStore();
  const handler = createCloudflareHandler({ env: { APP_ORIGIN: origin }, store });
  const register = await handler(request('/api/auth/register', details));
  assert.equal(register.status, 201);
  const user = (await register.json()).user;
  const cookie = register.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-lingotiles-session=/);
  assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const session = await handler(request('/api/auth/session', undefined, { Cookie: cookie.split(';')[0] }));
  assert.equal((await session.json()).user.id, user.id);
  const wrongOrigin = await handler(request('/api/auth/logout', {}, { Origin: 'https://other.example', Cookie: cookie.split(';')[0] }));
  assert.equal(wrongOrigin.status, 403);
  const logout = await handler(request('/api/auth/logout', {}, { Cookie: cookie.split(';')[0] }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0; Secure$/);
  const afterLogout = await handler(request('/api/auth/session', undefined, { Cookie: cookie.split(';')[0] }));
  assert.equal((await afterLogout.json()).user, null);
});

test('Cloudflare preserves separate OAuth and session Set-Cookie headers on successful Google callback', async () => {
  const store = memoryStore();
  const env = { APP_ORIGIN: origin, SESSION_SECRET: 'x'.repeat(48), GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret' };
  let nonce;
  const handler = createCloudflareHandler({ env, store, authOptions: {
    fetch: async () => ({ ok: true, json: async () => ({ id_token: 'signed-token' }) }),
    verifyGoogleToken: async () => ({ sub: 'google-subject', email: 'google@example.com', email_verified: true, nonce, name: 'Google learner' }),
  } });
  const start = await handler(request('/api/auth/google'));
  const destination = new URL(start.headers.get('Location'));
  nonce = destination.searchParams.get('nonce');
  const callback = new URL(origin + '/api/auth/google/callback');
  callback.search = new URLSearchParams({ state: destination.searchParams.get('state'), code: 'one-time-code' });
  const response = await handler(new Request(callback, { headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/?auth=success');
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(value => value.startsWith('__Host-lingotiles-oauth=;') && value.includes('Max-Age=0')));
  assert.ok(cookies.some(value => value.startsWith('__Host-lingotiles-session=') && value.includes('; Secure')));
});

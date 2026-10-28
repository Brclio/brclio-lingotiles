import { createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const scrypt = promisify(nodeScrypt);
const SESSION_AGE = 30 * 24 * 60 * 60;
const OAUTH_AGE = 600;
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10000 });
export const hash = value => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => { throw new HttpError(status, message); };
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function normalizeEmail(value) {
  if (!safeText(value, 254)) fail(400, '请输入有效邮箱地址。');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '请输入有效邮箱地址。');
  return email;
}
function validatePassword(value, registering = false) {
  if (typeof value !== 'string' || value.length < (registering ? 10 : 1) || value.length > 128 || Buffer.byteLength(value) > 256) fail(400, registering ? '密码请使用 10–128 个字符。' : '邮箱或密码不正确。');
  return value;
}
export function publicUser(profile) {
  const { id, email, name, provider, picture } = profile;
  return { id, email, name, provider, ...(picture ? { picture } : {}) };
}
export function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    try { result[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); } catch { /* Invalid cookie is ignored. */ }
  }
  return result;
}

export function createAuthService({ store, config, now = Date.now, fetch: fetcher = globalThis.fetch, verifyGoogleToken } = {}) {
  const sessionName = config.production ? '__Host-lingotiles-session' : 'lingotiles-session';
  const oauthName = config.production ? '__Host-lingotiles-oauth' : 'lingotiles-oauth';
  const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`;
  const sessionPath = token => `sessions/${hash(token).slice(0, 2)}/${hash(token)}.json`;
  const emailPath = email => `auth/email/${hash(email)}.json`;
  const profilePath = id => `users/${id}/profile.json`;
  const checkStore = () => { if (!store) fail(503, '账号服务尚未配置完成，请先以游客身份练习。'); };
  const signState = state => {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
    return `${payload}.${createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')}`;
  };
  const readState = value => {
    if (typeof value !== 'string' || value.length > 3000) fail(400, '登录验证已失效，请重新发起 Google 登录。');
    const [payload, signature, extra] = value.split('.');
    if (extra || !signature || !equal(signature, createHmac('sha256', config.sessionSecret).update(payload).digest('base64url'))) fail(400, '登录验证已失效，请重新发起 Google 登录。');
    let state;
    try { state = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { fail(400, '登录验证已失效，请重新发起 Google 登录。'); }
    if (!state || typeof state.state !== 'string' || typeof state.nonce !== 'string' || typeof state.verifier !== 'string' || !Number.isFinite(state.expiresAt) || state.expiresAt <= now()) fail(400, 'Google 登录已超时，请重新登录。');
    return state;
  };
  const session = (tx, userId) => {
    const token = random();
    tx.set(sessionPath(token), { userId, createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + SESSION_AGE * 1000).toISOString() });
    return cookie(sessionName, token, SESSION_AGE);
  };
  async function revokeExisting(tx, header) {
    const token = parseCookies(header)[sessionName];
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) tx.delete(sessionPath(token));
  }
  async function consumeRateLimit(keys, limit, windowMs = 15 * 60 * 1000) {
    checkStore();
    // Git-backed counters enforce the same bound across Node processes and serverless instances.
    // Hashes avoid storing IP addresses and attempted emails in plain text.
    await store.transaction(async tx => {
      for (const key of keys) {
        const path = `rate-limits/${hash(key)}.json`;
        const previous = await tx.get(path);
        const current = previous && Number.isFinite(previous.resetAt) && previous.resetAt > now() ? previous : { count: 0, resetAt: now() + windowMs };
        if (current.count >= limit) fail(429, '尝试次数较多，请稍后再试。');
        tx.set(path, { count: current.count + 1, resetAt: current.resetAt });
      }
    }, { message: 'Update authentication rate limit' });
  }
  async function currentUser(header) {
    const token = parseCookies(header)[sessionName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    checkStore();
    const stored = await store.get(sessionPath(token));
    if (!stored || !Number.isFinite(Date.parse(stored.expiresAt)) || Date.parse(stored.expiresAt) <= now() || !/^[a-f0-9-]{36}$/.test(stored.userId ?? '')) return null;
    const profile = await store.get(profilePath(stored.userId));
    return profile ? publicUser(profile) : null;
  }
  async function register(body, ip = 'unknown', header = '') {
    checkStore();
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password, true);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!safeText(name, 60) || !name) fail(400, '请填写 1–60 字的昵称。');
    await consumeRateLimit([`register-ip:${ip}`], 10);
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const profile = { id: randomUUID(), email, name, provider: 'password', createdAt: new Date(now()).toISOString() };
    const result = await store.transaction(async tx => {
      if (await tx.get(emailPath(email))) fail(409, '该邮箱已注册，请直接登录。');
      tx.set(profilePath(profile.id), profile);
      tx.set(emailPath(email), { userId: profile.id });
      tx.set(`users/${profile.id}/credentials/password.json`, { algorithm: 'scrypt', salt, hash: derived.toString('hex') });
      await revokeExisting(tx, header);
      return { user: publicUser(profile), cookie: session(tx, profile.id) };
    }, { message: 'Register account' });
    return result;
  }
  async function login(body, ip = 'unknown', header = '') {
    checkStore();
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    await consumeRateLimit([`login-ip:${ip}`, `login-email:${email}`], 20);
    const index = await store.get(emailPath(email));
    const credential = index ? await store.get(`users/${index.userId}/credentials/password.json`) : null;
    // Derive even when an account is unknown to keep the main timing path comparable.
    const salt = credential?.salt || '00000000000000000000000000000000';
    const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    if (credential?.algorithm !== 'scrypt' || !equal(derived.toString('hex'), credential.hash)) fail(401, '邮箱或密码不正确。');
    return store.transaction(async tx => {
      const profile = await tx.get(profilePath(index.userId));
      if (!profile) fail(401, '邮箱或密码不正确。');
      await revokeExisting(tx, header);
      return { user: publicUser(profile), cookie: session(tx, profile.id) };
    }, { message: 'Create login session' });
  }
  async function logout(header) {
    checkStore();
    await store.transaction(tx => revokeExisting(tx, header), { message: 'Revoke login session' });
    return { user: null, cookie: cookie(sessionName, '', 0) };
  }
  async function googleStart(ip = 'unknown') {
    checkStore();
    if (!config.googleEnabled) fail(503, 'Google 登录尚未配置，请先使用邮箱注册或登录。');
    await consumeRateLimit([`google-ip:${ip}`], 20);
    const state = { state: random(), nonce: random(), verifier: random(), expiresAt: now() + OAUTH_AGE * 1000 };
    await store.transaction(tx => tx.set(`auth/oauth/${hash(state.state)}.json`, { expiresAt: state.expiresAt }), { message: 'Start Google sign-in' });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: `${config.origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state: state.state, nonce: state.nonce, code_challenge: createHash('sha256').update(state.verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return { location: url.href, cookie: cookie(oauthName, signState(state), OAUTH_AGE) };
  }
  async function googleCallback(url, header) {
    checkStore();
    if (!config.googleEnabled) fail(503, 'Google 登录尚未配置。');
    const state = readState(parseCookies(header)[oauthName]);
    if (!equal(url.searchParams.get('state'), state.state)) fail(400, 'Google 登录安全校验失败，请重新登录。');
    await store.transaction(async tx => {
      const path = `auth/oauth/${hash(state.state)}.json`;
      const pending = await tx.get(path);
      if (!pending || pending.expiresAt <= now()) fail(400, 'Google 登录已过期或已使用，请重新登录。');
      tx.delete(path);
    }, { message: 'Consume Google sign-in state' });
    if (url.searchParams.has('error')) fail(400, 'Google 登录已取消，可以使用邮箱登录。');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) fail(400, '缺少 Google 授权码，请重新登录。');
    let response;
    try {
      response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.origin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: state.verifier }), signal: AbortSignal.timeout(15000) });
    } catch { fail(502, '暂时无法连接 Google，请稍后重试。'); }
    if (!response.ok) fail(401, 'Google 授权已失效，请重新登录。');
    let token;
    try { token = await response.json(); } catch { fail(502, 'Google 返回内容无效，请重试。'); }
    if (typeof token.id_token !== 'string') fail(401, 'Google 未返回有效的身份凭证。');
    let claims;
    try {
      claims = verifyGoogleToken ? await verifyGoogleToken(token.id_token) : (await jwtVerify(token.id_token, GOOGLE_KEYS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.googleClientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email'], maxTokenAge: '10 minutes', clockTolerance: 10 })).payload;
    } catch { fail(401, 'Google 身份验证失败，请重新登录。'); }
    if ((claims.azp !== undefined && claims.azp !== config.googleClientId) || !equal(claims.nonce, state.nonce) || claims.email_verified !== true || !safeText(claims.sub, 255) || !claims.sub) fail(401, 'Google 身份或邮箱尚未通过验证。');
    const email = normalizeEmail(claims.email);
    const identityPath = `auth/google/${hash(claims.sub)}.json`;
    return store.transaction(async tx => {
      const identity = await tx.get(identityPath);
      let profile;
      if (identity) {
        profile = await tx.get(profilePath(identity.userId));
        if (!profile) fail(401, 'Google 账号记录暂时不可用。');
      } else {
        if (await tx.get(emailPath(email))) fail(409, '该邮箱已注册，请使用原有方式登录，避免建立重复账号。');
        const name = safeText(claims.name, 60) && claims.name.trim() ? claims.name.trim() : email.split('@')[0].slice(0, 60);
        const picture = typeof claims.picture === 'string' && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(claims.picture) && claims.picture.length <= 1000 ? claims.picture : undefined;
        profile = { id: randomUUID(), email, name, provider: 'google', createdAt: new Date(now()).toISOString(), ...(picture ? { picture } : {}) };
        tx.set(profilePath(profile.id), profile);
        tx.set(identityPath, { userId: profile.id });
        tx.set(emailPath(email), { userId: profile.id });
      }
      await revokeExisting(tx, header);
      return { user: publicUser(profile), cookies: [cookie(oauthName, '', 0), session(tx, profile.id)] };
    }, { message: 'Sign in with Google' });
  }
  return { currentUser, register, login, logout, googleStart, googleCallback, consumeRateLimit, clearOAuthCookie: () => cookie(oauthName, '', 0) };
}

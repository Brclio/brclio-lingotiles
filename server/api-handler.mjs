import { GitHubStore, StoreError } from './github-store.mjs';
import { readProgramData } from './program.mjs';
import { createAuthService, HttpError } from './auth.mjs';
import { readLearning, syncLearning } from './learning.mjs';
export function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
function redirect(response, location, cookies) {
  response.statusCode = 303;
  response.setHeader('Location', location);
  if (cookies) response.setHeader('Set-Cookie', cookies);
  response.end();
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, '请使用 JSON 提交请求。');
  const maximum = request.url?.includes('/learning/') ? 2 * 1024 * 1024 : 16 * 1024;
  if (Number(request.headers['content-length']) > maximum) throw new HttpError(413, '提交内容过大，请分批同步。');
  let value;
  if (request.body !== undefined) {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (Buffer.byteLength(raw) > maximum) throw new HttpError(413, '提交内容过大，请分批同步。');
    try { value = JSON.parse(raw); } catch { throw new HttpError(400, '提交内容不是有效的 JSON。'); }
  } else {
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maximum) throw new HttpError(413, '提交内容过大，请分批同步。');
      chunks.push(chunk);
    }
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '提交内容不是有效的 JSON。'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求内容必须是对象。');
  return value;
}
export function setHeaders(response, production) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Inline styles are used for game board geometry; scripts remain same-origin.
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
/** Inject a repository and auth dependencies for deterministic integration tests. */
export function createApiHandler({ store, programStore, config, authOptions = {}, learning = { readLearning, syncLearning } } = {}) {
  if (store === undefined) store = config.storageConfigured ? new GitHubStore(config) : null;
  const auth = createAuthService({ store, config, ...authOptions });
  return async function handler(request, response) {
    setHeaders(response, config.production);
    const base = config.origin || 'http://localhost';
    let url;
    try { url = new URL(request.url, base); } catch { return json(response, 400, { error: '请求地址无效。' }); }
    const path = url.pathname;
    const method = request.method || 'GET';
    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        if (!config.origin || request.headers.origin !== config.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请求来源校验失败，请刷新网站后重试。');
      }
      if (method === 'GET' && path === '/api/health') return json(response, 200, { ok: true });
      if (method === 'GET' && path.startsWith('/api/program/')) {
        if (programStore === undefined) programStore = config.storageConfigured ? new GitHubStore({ ...config, repo: config.programRepo }) : null;
        const resource = await readProgramData(programStore, path.slice('/api/program/'.length));
        response.setHeader('Content-Type', resource.contentType);
        response.setHeader('Cache-Control', resource.cacheControl);
        response.setHeader('ETag', resource.etag);
        response.setHeader('X-Program-Revision', resource.revision);
        const validators = String(request.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
        if (validators.includes(resource.etag) || validators.includes('*')) {
          response.statusCode = 304;
          return response.end();
        }
        response.statusCode = 200;
        return response.end(resource.body);
      }
      if (method === 'GET' && path === '/api/auth/session') {
        return json(response, 200, { user: await auth.currentUser(request.headers.cookie), googleEnabled: Boolean(store && config.googleEnabled), configured: Boolean(store) });
      }
      const ip = config.trustProxy ? String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100) : request.socket?.remoteAddress || 'unknown';
      if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
        const body = await readJson(request);
        const result = path.endsWith('/register') ? await auth.register(body, ip, request.headers.cookie) : await auth.login(body, ip, request.headers.cookie);
        response.setHeader('Set-Cookie', result.cookie);
        return json(response, path.endsWith('/register') ? 201 : 200, { user: result.user, googleEnabled: Boolean(config.googleEnabled) });
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        const result = await auth.logout(request.headers.cookie);
        response.setHeader('Set-Cookie', result.cookie);
        return json(response, 200, { user: null });
      }
      if (method === 'GET' && path === '/api/auth/google') {
        const result = await auth.googleStart(ip);
        return redirect(response, result.location, result.cookie);
      }
      if (method === 'GET' && path === '/api/auth/google/callback') {
        const result = await auth.googleCallback(url, request.headers.cookie);
        return redirect(response, '/?auth=success', result.cookies);
      }
      if ((method === 'GET' && path === '/api/learning') || (method === 'POST' && path === '/api/learning/sync')) {
        const user = await auth.currentUser(request.headers.cookie);
        if (!user) throw new HttpError(401, '请先登录后同步学习数据。');
        if (request.headers['x-lingotiles-account'] !== user.id) throw new HttpError(409, '当前登录账号已变化，请刷新账号状态后重试。');
        if (method === 'GET') return json(response, 200, await learning.readLearning(store, user.id));
        const body = await readJson(request);
        return json(response, 200, await learning.syncLearning(store, user.id, body));
      }
      if (path.startsWith('/api/')) throw new HttpError(404, '接口不存在。');
      throw new HttpError(404, '页面不存在。');
    } catch (error) {
      const proposedStatus = error.status ?? error.statusCode;
      const recognized = error instanceof HttpError || error instanceof StoreError;
      const status = recognized && Number.isInteger(proposedStatus) && proposedStatus >= 400 && proposedStatus <= 599 ? proposedStatus : 503;
      if (config.production && status >= 500) console.error(JSON.stringify({
        event: 'lingotiles_service_error', path, status, kind: error.name,
        githubStatus: error.githubStatus,
        // Only our own sanitized error messages are safe to log.
        reason: error instanceof StoreError ? error.message : undefined,
      }));
      const message = error instanceof HttpError || (error instanceof StoreError && status < 500) ? error.message
        : path.startsWith('/api/program/') ? '程序词库暂时不可用，请稍后重试。'
        : '账号或同步服务暂时不可用，请稍后重试；本机学习数据仍会保留。';
      response.setHeader('Cache-Control', 'no-store');
      if (path === '/api/auth/google/callback') {
        const target = new URL('/', base);
        target.searchParams.set('authError', message);
        return redirect(response, `${target.pathname}${target.search}`, auth.clearOAuthCookie());
      }
      return json(response, status, { error: message });
    }
  };
}

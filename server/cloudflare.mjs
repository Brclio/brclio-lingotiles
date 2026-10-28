import { createApiHandler } from './api-handler.mjs';
import { loadRuntimeConfig } from './config-core.mjs';

/** Standard Request/Response adapter. No node:fs, local PEM path or Node HTTP server. */
export function createCloudflareHandler({ env = {}, store, programStore, authOptions, config: overrides = {} } = {}) {
  const config = { ...loadRuntimeConfig({ ...env, NODE_ENV: 'production', SERVE_STATIC: 'false' }), trustProxy: false, ...overrides };
  const api = createApiHandler({ config, store, programStore, authOptions });
  return async request => {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    const incoming = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      // Cloudflare overwrites this header at the edge. Do not trust client X-Forwarded-For.
      socket: { remoteAddress: request.headers.get('CF-Connecting-IP') || 'unknown' },
      async *[Symbol.asyncIterator]() {
        if (!request.body) return;
        const reader = request.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield Buffer.from(value);
          }
        } finally { reader.releaseLock(); }
      },
    };
    let body = null;
    const reply = {
      statusCode: 200,
      headers: new Headers(),
      setHeader(name, value) {
        this.headers.delete(name);
        for (const item of Array.isArray(value) ? value : [value]) this.headers.append(name, String(item));
      },
      getHeader(name) { return this.headers.get(name); },
      end(value) { body = value ?? null; },
    };
    await api(incoming, reply);
    return new Response(body, { status: reply.statusCode, headers: reply.headers });
  };
}

let cachedEnv;
let cachedHandler;
export async function onCloudflareRequest(context) {
  try {
    // Reuse App installation token caches for requests in the same isolate.
    if (!cachedHandler || cachedEnv !== context.env) {
      cachedEnv = context.env;
      cachedHandler = createCloudflareHandler({ env: context.env });
    }
    return await cachedHandler(context.request);
  } catch {
    return Response.json({ error: '账号服务配置暂时不可用，请稍后重试；本机学习数据仍会保留。' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
}

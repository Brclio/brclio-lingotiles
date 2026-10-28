import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createApiHandler, setHeaders, json } from './api-handler.mjs';
import { HttpError } from './auth.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
async function serveStatic(path, response) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, '文件地址无效。'); }
  if (decoded.includes('\0')) throw new HttpError(400, '文件地址无效。');
  const root = resolve(DIST);
  let candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new HttpError(404, '文件不存在。');
  try {
    const metadata = await stat(candidate);
    if (metadata.isDirectory()) candidate = resolve(candidate, 'index.html');
    const actual = await realpath(candidate);
    if (!actual.startsWith(root + sep)) throw new HttpError(404, '文件不存在。');
    const content = await readFile(actual);
    response.setHeader('Content-Type', MIME[extname(actual)] || 'application/octet-stream');
    response.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    response.end(content);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, '文件不存在，请先构建前端。');
  }
}

/** Native Node wrapper; API logic is also used unchanged by Pages Functions. */
export function createHandler({ store, programStore, config = loadConfig(), authOptions = {}, learning } = {}) {
  const api = createApiHandler({ store, programStore, config, authOptions, ...(learning ? { learning } : {}) });
  return async (request, response) => {
    let path;
    try { path = new URL(request.url, config.origin || 'http://localhost').pathname; }
    catch { return api(request, response); }
    if (path.startsWith('/api/')) return api(request, response);
    setHeaders(response, config.production);
    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && config.serveStatic) return await serveStatic(path, response);
      throw new HttpError(404, '页面不存在。');
    } catch (error) { return json(response, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : '页面暂时不可用。' }); }
  };
}

// Importable by serverless handlers; start listening only when run as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  const server = createServer(createHandler({ config }));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(config.port, '127.0.0.1', () => process.stdout.write(`LingoTiles API: http://127.0.0.1:${config.port}\n`));
}

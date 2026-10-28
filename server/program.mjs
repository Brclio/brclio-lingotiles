import { createHash } from 'node:crypto';
import { StoreError } from './github-store.mjs';

const REVISION = /^[a-f0-9]{24}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const CURRENT_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const PINNED_CACHE = 'public, max-age=31536000, immutable';
const hash = body => createHash('sha256').update(body).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowedPath = path => typeof path === 'string' && path.length <= 250 && (
  /^vocabulary\/[a-z0-9][a-z0-9._-]*\.json$/.test(path)
  || /^illustrations\/index\/[a-z0-9][a-z0-9._-]*\.json$/.test(path)
  || path === 'curriculum/themes.json'
);
const unavailable = () => { throw new StoreError('程序词库尚未发布或发布数据无效，请先运行 npm run program:sync。', 503); };
const notFound = () => { throw new StoreError('程序数据文件不存在。', 404); };
function result(value, revision, cacheControl, publishedAt) {
  const body = JSON.stringify(value);
  return {
    value, body, revision, etag: `"${hash(body)}"`, cacheControl,
    contentType: 'application/json; charset=utf-8',
    ...(publishedAt ? { publishedAt } : {}),
  };
}
function currentPointer(value) {
  if (!plain(value) || value.schemaVersion !== 1 || !REVISION.test(value.revision) || value.manifestPath !== `releases/${value.revision}/manifest.json`) unavailable();
  if (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) unavailable();
  return value;
}
function manifestEntries(manifest, revision) {
  if (!plain(manifest) || manifest.schemaVersion !== 1 || manifest.revision !== revision || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10_000) unavailable();
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!plain(entry) || !allowedPath(entry.path) || !CHECKSUM.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 2 * 1024 * 1024 || entries.has(entry.path)) unavailable();
    entries.set(entry.path, entry);
  }
  return entries;
}

/** Public program data is explicitly allowlisted; this reader never returns identity or credential data. */
export async function readProgramData(store, path) {
  if (!store) throw new StoreError('程序数据服务尚未配置。', 503);
  if (typeof path !== 'string' || path.length > 320 || /[%\\\u0000-\u0020\u007f]/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) notFound();
  let revision, relative = path;
  const pinned = /^releases\/([a-f0-9]{24})\/(.+)$/.exec(path);
  if (pinned) { revision = pinned[1]; relative = pinned[2]; }
  const metadata = !pinned && relative === 'catalog/current.json';
  const isManifest = relative === 'manifest.json';
  if (!metadata && !isManifest && !allowedPath(relative)) notFound();

  return store.transaction(async tx => {
    let pointer;
    if (!pinned) {
      pointer = currentPointer(await tx.get('catalog/current.json'));
      revision = pointer.revision;
    }
    if (metadata) return result(pointer, revision, CURRENT_CACHE, pointer.publishedAt);
    const manifest = await tx.get(`releases/${revision}/manifest.json`);
    if (pinned && manifest === null) notFound();
    const entries = manifestEntries(manifest, revision);
    const cacheControl = pinned ? PINNED_CACHE : CURRENT_CACHE;
    if (isManifest) return result(manifest, revision, cacheControl, pointer?.publishedAt);
    const entry = entries.get(relative);
    if (!entry) notFound();
    const value = await tx.get(`releases/${revision}/${relative}`);
    if (value === null) unavailable();
    const response = result(value, revision, cacheControl, pointer?.publishedAt);
    if (Buffer.byteLength(response.body) !== entry.bytes || response.etag !== `"${entry.sha256}"`) unavailable();
    return response;
  });
}

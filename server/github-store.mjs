import { createHash, createSign } from 'node:crypto';

const API = 'https://api.github.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
export class StoreError extends Error {
  constructor(message, status = 503, githubStatus) { super(message); this.status = status; this.githubStatus = githubStatus; }
}
function pathSegments(path) {
  if (typeof path !== 'string' || !path || path.length > 900 || path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path)) throw new StoreError('存储路径无效。', 400);
  const segments = path.replace(/\/$/, '').split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new StoreError('存储路径无效。', 400);
  return segments;
}
const copy = value => value === null || value === undefined ? value : structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Immutable Git snapshots plus non-force ref updates provide atomic, optimistic transactions. */
export class GitHubStore {
  constructor({ appId, clientId, privateKey, owner, repo, branch = 'main', fetch: fetcher = globalThis.fetch }) {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner ?? '') || !/^[A-Za-z0-9_.-]+$/.test(repo ?? '') || !branch || /[\s~^:?*\[\\]/.test(branch)) throw new StoreError('GitHub 仓库配置无效。');
    if (!privateKey || !(clientId || appId)) throw new StoreError('GitHub App 尚未配置。');
    Object.assign(this, { appId, clientId, privateKey, owner, repo, branch, fetcher });
    // Workers' native fetch must not receive the store instance as its receiver.
    this.fetcher = (...args) => fetcher(...args);
    this.base = `/repos/${owner}/${repo}`;
    this.token = null;
    this.tokenPending = null;
    this.cache = new Map();
  }

  jwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.clientId || this.appId })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(this.privateKey).toString('base64url')}`;
  }

  async raw(path, { method = 'GET', body, token } = {}) {
    // Never incorporate upstream response bodies, tokens or request payloads into errors.
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetcher(`${API}${path}`, {
          method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json', 'User-Agent': 'Brclio-LingoTiles' },
          // Workers supports manual/follow; reject 3xx below without forwarding credentials.
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'manual',
        });
        if (response.ok) return response.status === 204 ? null : await response.json();
      } catch {
        // POST retries can create orphan immutable objects; they can never duplicate logical writes.
        if (attempt < 2) { await delay(150 * (attempt + 1)); continue; }
        throw new StoreError('GitHub 存储连接暂时不可用，请稍后重试。');
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        if (Number.isFinite(seconds) && seconds > 2) throw new StoreError('GitHub 存储繁忙，请稍后重试。', 503, response.status);
        await delay(seconds > 0 ? seconds * 1000 : 200 * (attempt + 1)); continue;
      }
      throw new StoreError(response.status === 403 || response.status === 429 ? 'GitHub App 权限不足或存储请求过于频繁。' : 'GitHub 存储请求失败，请检查仓库授权及分支。', 503, response.status);
    }
  }

  async installationToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.tokenPending) this.tokenPending = (async () => {
      let installation;
      try { installation = await this.raw(`${this.base}/installation`, { token: this.jwt() }); }
      catch (error) {
        if (error.githubStatus === 404) throw new StoreError('请先将 GitHub App 安装到数据仓库所属组织，并授予该私有仓库 Contents 读写权限。');
        throw error;
      }
      const issued = await this.raw(`/app/installations/${installation.id}/access_tokens`, { method: 'POST', token: this.jwt(), body: { repositories: [this.repo], permissions: { contents: 'write' } } });
      const repository = await this.raw(this.base, { token: issued.token });
      if (repository.private !== true) throw new StoreError('数据仓库必须保持私有；已拒绝访问公开仓库。');
      this.token = { value: issued.token, expiresAt: Date.parse(issued.expires_at) };
      return issued.token;
    })().finally(() => { this.tokenPending = null; });
    return this.tokenPending;
  }

  async request(path, options = {}) {
    try { return await this.raw(path, { ...options, token: await this.installationToken() }); }
    catch (error) {
      if (error.githubStatus !== 401) throw error;
      this.token = null;
      return this.raw(path, { ...options, token: await this.installationToken() });
    }
  }

  async cached(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const pending = this.request(`${this.base}${path}`);
    this.cache.set(path, pending);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    try { return await pending; } catch (error) { this.cache.delete(path); throw error; }
  }

  remember(path, value) {
    this.cache.set(path, Promise.resolve(value));
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
  }

  async prefetchBlobs(entries) {
    if (this.graphqlUnavailable) return;
    const missing = [...new Set(entries.map(entry => entry.sha))].filter(sha => /^[a-f0-9]{40,64}$/.test(sha) && !this.cache.has(`/git/blobs/${sha}`));
    for (let offset = 0; offset < missing.length; offset += 50) {
      const batch = missing.slice(offset, offset + 50);
      const fields = batch.map((sha, index) => `b${index}:object(oid:"${sha}"){... on Blob{oid text byteSize isBinary}}`).join(' ');
      let response;
      try {
        response = await this.request('/graphql', { method: 'POST', body: {
          query: `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fields}}}`,
          variables: { owner: this.owner, repo: this.repo },
        } });
      } catch (error) {
        if ([401, 403].includes(error.githubStatus)) throw error;
        if ([400, 404, 405, 422].includes(error.githubStatus)) this.graphqlUnavailable = true;
        return; // REST-only transports fall back; a transient outage does not disable later batching.
      }
      if (response.errors?.some(error => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.type) || ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.extensions?.code))) throw new StoreError('GitHub App 无权批量读取仓库内容。', 503, 403);
      const repository = response.data?.repository;
      if (!repository || response.errors?.length) { this.graphqlUnavailable = true; return; }
      for (let index = 0; index < batch.length; index++) {
        const blob = repository[`b${index}`];
        if (!blob || blob.oid !== batch[index] || blob.isBinary || typeof blob.text !== 'string' || !Number.isSafeInteger(blob.byteSize) || blob.byteSize > MAX_JSON_BYTES || Buffer.byteLength(blob.text) !== blob.byteSize) continue;
        this.remember(`/git/blobs/${blob.oid}`, { encoding: 'base64', content: Buffer.from(blob.text).toString('base64'), size: blob.byteSize });
      }
    }
  }

  async snapshot() {
    let ref;
    try { ref = await this.request(`${this.base}/git/ref/heads/${encodeURIComponent(this.branch)}`); }
    catch (error) {
      if ([404, 409].includes(error.githubStatus)) throw new StoreError('数据仓库或分支尚未初始化，请运行 npm run data:init。', 503, error.githubStatus);
      throw error;
    }
    const commit = await this.cached(`/git/commits/${ref.object.sha}`);
    const root = commit.tree.sha;
    const walk = async segments => {
      let sha = root;
      let entry;
      for (let index = 0; index < segments.length; index++) {
        const tree = await this.cached(`/git/trees/${sha}`);
        if (tree.truncated) throw new StoreError('GitHub 目录过大，无法安全读取。');
        entry = tree.tree.find(item => item.path === segments[index]);
        if (!entry) return null;
        if (index < segments.length - 1 && entry.type !== 'tree') return null;
        sha = entry.sha;
      }
      return entry;
    };
    const userIndexes = new Map();
    const indexUser = async segments => {
      if (segments[0] !== 'users' || segments.length < 2) return;
      const id = segments[1];
      if (!userIndexes.has(id)) userIndexes.set(id, (async () => {
        const entry = await walk(['users', id]);
        if (!entry || entry.type !== 'tree') return;
        let recursive;
        try { recursive = await this.cached(`/git/trees/${entry.sha}?recursive=1`); }
        catch (error) { if ([401, 403].includes(error.githubStatus)) throw error; return; }
        if (recursive.truncated || !Array.isArray(recursive.tree)) return;
        const directories = new Map([['', entry.sha]]), children = new Map();
        for (const child of recursive.tree) {
          pathSegments(child.path);
          const slash = child.path.lastIndexOf('/');
          const parent = slash < 0 ? '' : child.path.slice(0, slash);
          const name = slash < 0 ? child.path : child.path.slice(slash + 1);
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push({ ...child, path: name });
          if (child.type === 'tree') directories.set(child.path, child.sha);
        }
        // A REST-only mock may ignore recursive=1. Never treat its missing descendants as empty.
        if ([...directories.keys()].some(path => path && !children.has(path))) return;
        for (const [path, sha] of directories) this.remember(`/git/trees/${sha}`, { sha, tree: children.get(path) ?? [], truncated: false });
      })());
      await userIndexes.get(id);
    };
    const find = async segments => { await indexUser(segments); return walk(segments); };
    const decode = async entry => {
      if (!entry || entry.type !== 'blob') return null;
      const blob = await this.cached(`/git/blobs/${entry.sha}`);
      if (blob.encoding !== 'base64' || blob.size > MAX_JSON_BYTES) throw new StoreError('GitHub 数据格式或大小无效。');
      try { return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); }
      catch { throw new StoreError('GitHub 数据无法解析。'); }
    };
    const list = async prefix => {
      const segments = pathSegments(prefix);
      const normalized = segments.join('/');
      const entry = await find(segments);
      if (!entry) return [];
      if (entry.type === 'blob') return [{ path: normalized, value: await decode(entry) }];
      const found = [];
      const queue = [{ sha: entry.sha, path: normalized }];
      while (queue.length) {
        const directory = queue.shift();
        const tree = await this.cached(`/git/trees/${directory.sha}`);
        if (tree.truncated) throw new StoreError('GitHub 目录过大，无法安全读取。');
        for (const child of tree.tree) {
          const path = `${directory.path}/${child.path}`;
          if (child.type === 'tree') queue.push({ sha: child.sha, path });
          else if (child.type === 'blob' && path.endsWith('.json')) found.push({ path, entry: child });
        }
      }
      await this.prefetchBlobs(found.map(item => item.entry));
      const values = new Array(found.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, found.length) }, async () => {
        while (next < found.length) {
          const index = next++;
          values[index] = { path: found[index].path, value: await decode(found[index].entry) };
        }
      }));
      return values;
    };
    const prefetch = async paths => {
      const entries = [];
      for (const path of new Set(paths)) {
        const entry = await find(pathSegments(path));
        if (entry?.type === 'blob') entries.push(entry);
      }
      await this.prefetchBlobs(entries);
    };
    return { head: ref.object.sha, tree: root, get: async path => decode(await find(pathSegments(path))), list, prefetch };
  }

  async get(path) { return copy(await (await this.snapshot()).get(path)); }
  async list(prefix) { return copy(await (await this.snapshot()).list(prefix)); }

  async transaction(mutator, { message = 'Update structured LingoTiles data' } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.snapshot();
      const changes = new Map();
      const tx = {
        prefetch: paths => snapshot.prefetch(paths),
        get: async path => {
          pathSegments(path);
          return copy(changes.has(path) ? changes.get(path) : await snapshot.get(path));
        },
        list: async prefix => {
          const normalized = pathSegments(prefix).join('/');
          const values = new Map((await snapshot.list(prefix)).map(item => [item.path, item.value]));
          for (const [path, value] of changes) if (path === normalized || path.startsWith(`${normalized}/`)) {
            if (value === null) values.delete(path); else values.set(path, value);
          }
          return copy([...values].map(([path, value]) => ({ path, value })));
        },
        set: (path, value) => {
          pathSegments(path);
          if (value === undefined || value === null) throw new StoreError('写入内容无效。', 400);
          const serialized = JSON.stringify(value);
          if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) throw new StoreError('单条数据过大。', 413);
          changes.set(path, JSON.parse(serialized));
        },
        delete: path => { pathSegments(path); changes.set(path, null); },
      };
      const result = await mutator(tx);
      const treeEntries = [];
      for (const [path, value] of changes) {
        const old = await snapshot.get(path);
        if (JSON.stringify(old) === JSON.stringify(value)) continue;
        if (value === null) { if (old !== null) treeEntries.push({ path, type: 'blob', mode: '100644', sha: null }); }
        else treeEntries.push({ path, type: 'blob', mode: '100644', content: `${JSON.stringify(value)}\n` });
      }
      if (!treeEntries.length) return result;
      let treeSha = snapshot.tree;
      let batch = [];
      let batchBytes = 0;
      const flushTree = async () => {
        if (!batch.length) return;
        const tree = await this.request(`${this.base}/git/trees`, { method: 'POST', body: { base_tree: treeSha, tree: batch } });
        treeSha = tree.sha; batch = []; batchBytes = 0;
      };
      for (const entry of treeEntries) {
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (batch.length >= 500 || batchBytes + bytes > 3_500_000) await flushTree();
        batch.push(entry); batchBytes += bytes;
      }
      await flushTree();
      const commit = await this.request(`${this.base}/git/commits`, { method: 'POST', body: { message: String(message).slice(0, 200), tree: treeSha, parents: [snapshot.head] } });
      try {
        await this.request(`${this.base}/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return result;
      } catch (error) {
        if (![409, 422].includes(error.githubStatus) || attempt === 4) throw error;
        // Re-run reads and business validation at the new head; never force-overwrite a competing commit.
        await delay(40 * 2 ** attempt + Math.random() * 80);
      }
    }
  }

  async initialize(schema) {
    try { await this.snapshot(); return false; }
    catch (error) { if (![404, 409].includes(error.githubStatus)) throw error; }
    try {
      await this.request(`${this.base}/contents/.lingotiles/schema.json`, {
        method: 'PUT', body: { message: 'Initialize structured LingoTiles storage', branch: this.branch, content: Buffer.from(`${JSON.stringify(schema, null, 2)}\n`).toString('base64') },
      });
      return true;
    } catch (error) {
      if (error.githubStatus !== 422) throw error;
      await this.snapshot();
      return false;
    }
  }
}

export const storageKey = value => createHash('sha256').update(value).digest('hex');

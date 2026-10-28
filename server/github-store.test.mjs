import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { GitHubStore } from './github-store.mjs';
import { syncLearning } from './learning.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const digest = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
class GitHubMock {
  blobs = new Map(); trees = new Map(); commits = new Map(); tokenRequests = 0; refUpdates = 0; installRequests = 0; public = false;
  constructor(initial = {}) { this.head = this.commit(initial); this.requests = 0; this.graphqlRequests = 0; this.recursiveRequests = []; this.restBlobRequests = 0; }
  recursive(sha, prefix = '') { return this.trees.get(sha).tree.flatMap(entry => [{ ...entry, path: prefix + entry.path }, ...(entry.type === 'tree' ? this.recursive(entry.sha, prefix + entry.path + '/') : [])]); }
  build(flat) {
    const entries = [];
    const directories = new Map();
    for (const [path, value] of Object.entries(flat)) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        const content = `${JSON.stringify(value)}\n`, sha = digest(content);
        this.blobs.set(sha, { encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
        entries.push({ path, sha, type: 'blob', mode: '100644' });
      } else {
        const directory = path.slice(0, slash);
        if (!directories.has(directory)) directories.set(directory, {});
        directories.get(directory)[path.slice(slash + 1)] = value;
      }
    }
    for (const [path, files] of directories) entries.push({ path, sha: this.build(files), type: 'tree', mode: '040000' });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const sha = digest(entries); this.trees.set(sha, { sha, tree: entries, truncated: false }); return sha;
  }
  flatten(tree, prefix = '') {
    const result = {};
    for (const entry of this.trees.get(tree).tree) {
      const path = `${prefix}${entry.path}`;
      if (entry.type === 'tree') Object.assign(result, this.flatten(entry.sha, `${path}/`));
      else result[path] = JSON.parse(Buffer.from(this.blobs.get(entry.sha).content, 'base64').toString());
    }
    return result;
  }
  commit(flat, parent = null) {
    const value = { tree: { sha: this.build(flat) }, parents: parent ? [{ sha: parent }] : [] }, sha = digest(value);
    this.commits.set(sha, value); return sha;
  }
  response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
  fetch = async (url, options) => {
    this.requests++;
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    if (path === '/graphql') {
      this.graphqlRequests++;
      if (this.graphqlMode === 'unsupported') return this.response({ message: 'not implemented' }, 404);
      if (this.graphqlMode === 'forbidden') return this.response({ data: { repository: null }, errors: [{ type: 'FORBIDDEN' }] });
      if (this.onGraphql) { const callback = this.onGraphql; this.onGraphql = null; callback(); }
      const repository = {};
      const aliases = [...body.query.matchAll(/b(\d+):object\(oid:"([a-f0-9]+)"\)/g)];
      assert.ok(aliases.length > 0 && aliases.length <= 50);
      for (const [, index, oid] of aliases) {
        const blob = this.blobs.get(oid);
        repository[`b${index}`] = blob ? { oid, text: Buffer.from(blob.content, 'base64').toString(), byteSize: blob.size, isBinary: false } : null;
      }
      return this.response({ data: { repository } });
    }
    if (path.endsWith('/installation')) { this.installRequests++; return this.response({ id: 9 }); }
    if (path === '/app/installations/9/access_tokens') { this.tokenRequests++; return this.response({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }); }
    if (path === '/repos/org/repo') return this.response({ private: !this.public });
    const route = path.replace('/repos/org/repo/git/', '');
    if (route === 'ref/heads/main') return this.response({ object: { sha: this.head } });
    if (route.startsWith('commits/')) return this.response(this.commits.get(route.slice(8)));
    if (route.startsWith('trees/')) {
      if (parsed.searchParams.get('recursive') === '1') { this.recursiveRequests.push(route.slice(6)); return this.response({ sha: route.slice(6), tree: this.recursiveTruncated ? this.recursive(route.slice(6)).slice(0, 1) : this.recursive(route.slice(6)), truncated: Boolean(this.recursiveTruncated) }); }
      return this.response(this.trees.get(route.slice(6)));
    }
    if (route.startsWith('blobs/')) { this.restBlobRequests++; return this.response(this.blobs.get(route.slice(6))); }
    if (route === 'trees' && options.method === 'POST') {
      const flat = this.flatten(body.base_tree);
      for (const entry of body.tree) {
        if (entry.sha === null) delete flat[entry.path]; else flat[entry.path] = JSON.parse(entry.content);
      }
      return this.response({ sha: this.build(flat) }, 201);
    }
    if (route === 'commits' && options.method === 'POST') {
      const commit = { tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })) }, sha = digest(commit);
      this.commits.set(sha, commit); return this.response({ sha }, 201);
    }
    if (route === 'refs/heads/main' && options.method === 'PATCH') {
      assert.equal(body.force, false);
      this.refUpdates++;
      if (this.onPatch) { const callback = this.onPatch; this.onPatch = null; callback(); }
      if (this.commits.get(body.sha).parents[0].sha !== this.head) return this.response({ message: 'Not a fast forward' }, 422);
      this.head = body.sha; return this.response({ object: { sha: this.head } });
    }
    throw Error(`Unexpected mock route: ${path}`);
  };
}
const storeFor = mock => new GitHubStore({ appId: '1', privateKey: pem, owner: 'org', repo: 'repo', fetch: mock.fetch });

test('GitHub transaction atomically writes and deletes separate JSON entities', async () => {
  const mock = new GitHubMock({ 'users/a/profile.json': { name: 'old' }, 'users/a/remove.json': { x: 1 } });
  const store = storeFor(mock);
  const result = await store.transaction(async tx => {
    assert.deepEqual(await tx.get('users/a/profile.json'), { name: 'old' });
    tx.set('users/a/profile.json', { name: 'new' }); tx.set('users/a/cards/x.json', { wordId: 'apple' }); tx.delete('users/a/remove.json');
    assert.equal((await tx.list('users/a')).length, 2);
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(mock.refUpdates, 1);
  assert.equal(await store.get('users/a/remove.json'), null);
  assert.deepEqual(await store.get('users/a/profile.json'), { name: 'new' });
  assert.equal(mock.tokenRequests, 1);
  assert.equal((await store.list('users/a/cards')).length, 1);
});

test('ref conflict re-runs the mutation against new data and preserves the competing writer', async () => {
  const mock = new GitHubMock({ 'counter.json': { count: 1 } });
  const store = storeFor(mock);
  mock.onPatch = () => { mock.head = mock.commit({ 'counter.json': { count: 5 }, 'other.json': { keep: true } }, mock.head); };
  let calls = 0;
  const count = await store.transaction(async tx => {
    calls++;
    const value = await tx.get('counter.json');
    tx.set('counter.json', { count: value.count + 1 });
    return value.count + 1;
  });
  assert.equal(calls, 2); assert.equal(count, 6);
  assert.deepEqual(await store.get('other.json'), { keep: true });
  assert.deepEqual(await store.get('counter.json'), { count: 6 });
});

test('no-op transactions avoid commits and reject unsafe paths', async () => {
  const mock = new GitHubMock({ 'x.json': { x: 1 } }), store = storeFor(mock);
  await store.transaction(tx => tx.set('x.json', { x: 1 }));
  assert.equal(mock.refUpdates, 0);
  await assert.rejects(store.get('../secret.json'), { status: 400 });
  await assert.rejects(store.transaction(tx => tx.set('users//x.json', { a: 1 })), { status: 400 });
});

test('public repositories are rejected before reading or writing user data', async () => {
  const mock = new GitHubMock({}), store = storeFor(mock); mock.public = true;
  await assert.rejects(store.get('x.json'), /必须保持私有/);
  assert.equal(mock.refUpdates, 0);
});

test('successful response headers followed by a body timeout are retried before returning JSON', async () => {
  let requests = 0;
  const store = new GitHubStore({ appId: '1', privateKey: pem, owner: 'org', repo: 'repo', fetch: async () => {
    requests++;
    return {
      ok: true, status: 200,
      async json() {
        if (requests === 1) throw new DOMException('Body stream timed out after successful headers', 'TimeoutError');
        return { object: { sha: 'completed-response-sha' } };
      },
    };
  } });
  const result = await store.raw('/repos/org/repo/git/ref/heads/main', { token: 'test-only-token' });
  assert.deepEqual(result, { object: { sha: 'completed-response-sha' } });
  assert.equal(requests, 2);
});

test('repeated JSON body timeouts exhaust bounded retries and expose only a sanitized storage error', async () => {
  let requests = 0;
  const sensitive = 'upstream-body PRIVATE KEY installation-token /Users/private/secret.pem';
  const store = new GitHubStore({ appId: '1', privateKey: pem, owner: 'org', repo: 'repo', fetch: async () => {
    requests++;
    return { ok: true, status: 200, async json() { throw new DOMException(sensitive, 'TimeoutError'); } };
  } });
  await assert.rejects(store.raw('/repos/org/repo/git/ref/heads/main', { token: 'test-only-token' }), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /GitHub 存储连接暂时不可用/);
    assert.ok(!String(error).includes(sensitive));
    assert.ok(!JSON.stringify(error).includes(sensitive));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 3);
});

test('GitHub fetch works in Workers and never follows redirects with installation credentials', async () => {
  let requests = 0;
  const store = new GitHubStore({ appId: '1', privateKey: pem, owner: 'org', repo: 'repo', fetch: async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/collect' } });
  } });
  await assert.rejects(store.raw('/repos/org/repo', { token: 'test-only-token' }), { status: 503, githubStatus: 302 });
  assert.equal(requests, 1);
});

test('fetch is called without binding the GitHubStore as its receiver, as required by Workers', async () => {
  let requests = 0;
  const store = new GitHubStore({ appId: '1', privateKey: pem, owner: 'org', repo: 'repo', fetch: async function (url, options) {
    // Workers native fetch throws Illegal invocation if called as store.fetcher(...).
    assert.equal(this, undefined);
    requests++;
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } });
  assert.deepEqual(await store.raw('/repos/org/repo', { token: 'test-only-token' }), { ok: true });
  assert.equal(requests, 1);
});

test('cold account listing batches 300 JSON blobs and indexes only that user subtree', async () => {
  const flat = {};
  for (let index = 0; index < 300; index++) {
    const key = digest(index);
    flat[`users/alice/cards/${key.slice(0, 2)}/${key}.json`] = { wordId: `word-${index}`, count: 1 };
    flat[`users/bob/cards/${key.slice(0, 2)}/${key}.json`] = { private: true, owner: 'bob', index };
  }
  const mock = new GitHubMock(flat), store = storeFor(mock);
  const root = mock.commits.get(mock.head).tree.sha;
  const users = mock.trees.get(root).tree.find(entry => entry.path === 'users').sha;
  const alice = mock.trees.get(users).tree.find(entry => entry.path === 'alice').sha;
  const records = await store.list('users/alice/cards');
  assert.equal(records.length, 300);
  assert.ok(records.every(record => record.path.startsWith('users/alice/cards/') && !record.value.private));
  assert.deepEqual(mock.recursiveRequests, [alice]);
  assert.equal(mock.graphqlRequests, 6);
  assert.equal(mock.restBlobRequests, 0);
  assert.ok(mock.requests <= 15, `cold listing used ${mock.requests} requests`);
  const snapshot = await store.snapshot();
  const before = mock.requests;
  assert.deepEqual(await snapshot.get(records[0].path), records[0].value);
  assert.equal(mock.requests, before, 'individual get reuses SHA-addressed tree and blob caches');
});

test('truncated account recursion falls back to complete directory traversal', async () => {
  const mock = new GitHubMock({ 'users/alice/cards/aa/one.json': { id: 1 }, 'users/alice/cards/bb/two.json': { id: 2 } });
  mock.recursiveTruncated = true;
  const values = await storeFor(mock).list('users/alice/cards');
  assert.equal(values.length, 2);
  assert.deepEqual(values.map(value => value.value.id).sort(), [1, 2]);
});

test('GraphQL fallback supports REST-only transports while preserving authorization errors', async () => {
  const initial = { 'users/alice/cards/aa/one.json': { id: 1 } };
  const unsupported = new GitHubMock(initial); unsupported.graphqlMode = 'unsupported';
  assert.equal((await storeFor(unsupported).list('users/alice/cards')).length, 1);
  assert.equal(unsupported.restBlobRequests, 1);
  const forbidden = new GitHubMock(initial); forbidden.graphqlMode = 'forbidden';
  await assert.rejects(storeFor(forbidden).list('users/alice/cards'), error => error.status === 503 && error.githubStatus === 403);
  assert.equal(forbidden.restBlobRequests, 0);
});

test('GraphQL reads remain pinned to the immutable snapshot when another commit changes the branch', async () => {
  const path = 'users/alice/cards/aa/one.json';
  const mock = new GitHubMock({ [path]: { revision: 'old' } }), store = storeFor(mock);
  mock.onGraphql = () => { mock.head = mock.commit({ [path]: { revision: 'new' } }, mock.head); };
  assert.deepEqual((await store.list('users/alice/cards'))[0].value, { revision: 'old' });
  assert.deepEqual(await store.get(path), { revision: 'new' });
});

test('cold retries can prefetch hundreds of mutation reads without individual REST blob calls', async () => {
  const flat = {};
  for (let index = 0; index < 300; index++) {
    const key = digest(index);
    flat[`users/alice/words/${key.slice(0, 2)}/${key}.json`] = { wordId: `word-${index}`, firstSeenAt: '2026-01-01T00:00:00.000Z' };
  }
  const mock = new GitHubMock(flat), store = storeFor(mock);
  await store.transaction(async tx => {
    await tx.prefetch(Object.keys(flat));
    for (const [path, value] of Object.entries(flat)) {
      assert.deepEqual(await tx.get(path), value);
      tx.set(path, value); // A network retry of already committed data remains a no-op.
    }
  });
  assert.equal(mock.graphqlRequests, 6);
  assert.equal(mock.restBlobRequests, 0);
  assert.equal(mock.refUpdates, 0);
  assert.ok(mock.requests <= 15, `cold retry used ${mock.requests} requests`);
});

test('full cold retry of 300 collected cards and seen words stays below the Workers request budget', async () => {
  const mock = new GitHubMock({});
  const cards = Array.from({ length: 300 }, (_, index) => ({ wordId: `word-${index}`, word: `word-${index}`, pos: 'n.', meaning: '词义', collectedAt: '2026-10-01T08:00:00.000Z', sourceId: `run-${index}` }));
  const payload = { progress: { completed: {}, seen: cards.map(card => card.wordId), saved: [], sessions: 0, lastPlayed: null, streak: 0 }, cards };
  await syncLearning(storeFor(mock), 'alice', payload);
  mock.requests = 0; mock.graphqlRequests = 0; mock.restBlobRequests = 0;
  const before = mock.refUpdates;
  const result = await syncLearning(storeFor(mock), 'alice', payload);
  assert.equal(result.cards.length, 300);
  assert.ok(result.cards.every(card => card.count === 1));
  assert.equal(result.progress.seen.length, 300);
  assert.equal(mock.refUpdates, before, 'a retry never creates another commit');
  assert.equal(mock.restBlobRequests, 0);
  assert.ok(mock.graphqlRequests <= 19);
  assert.ok(mock.requests <= 30, `cold full sync used ${mock.requests} requests`);
});

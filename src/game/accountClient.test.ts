import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readOutbox } from '../account/outbox.ts';
import { AccountClient } from '../account/client.ts';
import { emptyAccount, mergeProgress, type AccountUser, type LearningData } from '../account/data.ts';
import { LEVELS } from '../data/vocabulary.ts';
import type { CompletionRecord } from './history.ts';

function harness() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const remote = new Map<string, LearningData>();
  let user: AccountUser | null = null;
  let pause: (() => Promise<void>) | null = null;
  let offline = false;
  const cardEvents = new Map<string, Set<string>>();
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input, init) => {
    const path = String(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/auth/session') return response({ user, googleEnabled: false });
    if (path === '/api/auth/login') { user = { id: body.email.split('@')[0], email: body.email, name: body.email }; return response({ user }); }
    if (path === '/api/auth/logout') { user = null; return response({ user: null }); }
    const expected = new Headers(init?.headers).get('X-LingoTiles-Account');
    if (expected !== user?.id) return new Response(JSON.stringify({error:'session changed'}), {status:409});
    const id = user!.id;
    if (!remote.has(id)) { const value = emptyAccount(); remote.set(id, { ...value, records: [], preferences: null }); }
    let cloud = remote.get(id)!;
    if (path === '/api/learning/sync') {
      if (offline) throw new Error('offline');
      const known = cardEvents.get(id) ?? new Set<string>(); cardEvents.set(id, known);
      const cards = new Map(cloud.cards.map(card => [card.wordId, card]));
      for (const card of body.cards) {
        const key = `${card.wordId}:${card.sourceId}`;
        if (known.has(key)) continue;
        known.add(key);
        const previous = cards.get(card.wordId);
        cards.set(card.wordId, { ...card, count: (previous?.count ?? 0) + 1 });
      }
      cloud = { ...cloud, cards: [...cards.values()], progress: mergeProgress(cloud.progress, body.progress, body.favoriteChanges), records: [...new Map([...cloud.records, ...body.records].map(item => [item.id, item])).values()], preferences: body.preferences };
      remote.set(id, cloud);
      if (pause) await pause();
    }
    return response(cloud);
  }) as typeof fetch;
  return { remote, offline: (value: boolean) => { offline = value; }, pause: (task: (() => Promise<void>) | null) => { pause = task; } };
}
const record: CompletionRecord = { id: 'test-run', levelId: 1, levelTitle: '词汇花园', mode: 'theme', wordCount: 9, gameSeconds: 10, studySeconds: 20, totalSeconds: 30, score: 900, stars: 3, assists: 0, completedAt: new Date().toISOString() };

test('switching accounts isolates progress, cards and history; logout restores guest', async () => {
  harness();
  const client = new AccountClient();
  await client.initialize();
  const word = LEVELS[0].words[0];
  client.setProgress(previous => ({ ...previous, saved: [word.id] }));
  client.collect(word, 'guest-run');
  await client.appendCompletion(record);
  await client.authenticate('login', { email: 'alice@example.com', password: 'a-password' });
  assert.equal(client.getSnapshot().scope, 'alice');
  assert.deepEqual(client.getSnapshot().progress.saved, []);
  assert.equal(client.getSnapshot().cards.length, 0);
  assert.equal((await client.getSnapshot().history.records()).length, 0);
  client.setProgress(previous => ({ ...previous, saved: [word.id] }));
  await client.appendCompletion({ ...record, id: 'alice-run' });
  await client.logout();
  assert.equal(client.getSnapshot().scope, 'guest');
  assert.deepEqual(client.getSnapshot().progress.saved, [word.id]);
  assert.equal(client.getSnapshot().cards.length, 1);
  assert.deepEqual((await client.getSnapshot().history.records()).map(item => item.id), ['test-run']);
  await client.authenticate('login', { email: 'bob@example.com', password: 'b-password' });
  assert.equal(client.getSnapshot().cards.length, 0);
  assert.deepEqual(client.getSnapshot().progress.saved, []);
  assert.equal((await client.getSnapshot().history.records()).length, 0);
  await client.logout();
});

test('response from old account cannot replace guest after logout', async () => {
  const server = harness();
  const client = new AccountClient();
  await client.initialize();
  await client.authenticate('login', { email: 'alice@example.com', password: 'a-password' });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  server.pause(() => pending);
  client.setProgress(previous => ({ ...previous, saved: [LEVELS[0].words[0].id] }));
  const sync = client.sync();
  await client.logout();
  release();
  await sync;
  assert.equal(client.getSnapshot().scope, 'guest');
  assert.deepEqual(client.getSnapshot().progress.saved, []);
  assert.equal(client.getSnapshot().status, 'local');
});

test('offline pending favorite survives reload and uploads when account returns', async () => {
  const server = harness();
  const client = new AccountClient();
  await client.initialize();
  await client.authenticate('login', { email: 'alice@example.com', password: 'a-password' });
  const id = LEVELS[0].words[0].id;
  client.setProgress(previous => ({ ...previous, saved: [id] }));
  await client.logout();
  const reloaded = new AccountClient();
  await reloaded.initialize();
  await reloaded.authenticate('login', { email: 'alice@example.com', password: 'a-password' });
  assert.deepEqual(reloaded.getSnapshot().progress.saved, [id]);
  assert.deepEqual(server.remote.get('alice')?.progress.saved, [id]);
  assert.equal(reloaded.getSnapshot().pending.favorites.length, 0);
  await reloaded.logout();
});

test('shared cookie changes cannot upload old account facts into the new account', async () => {
  const server = harness();
  const client = new AccountClient();
  await client.initialize();
  await client.authenticate('login', { email: 'alice@example.com', password: 'a-password' });
  client.collect(LEVELS[0].words[0], 'alice-offline-run');
  await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({email:'bob@example.com',password:'b-password'}) });
  await client.sync();
  assert.equal(client.getSnapshot().scope, 'bob');
  assert.deepEqual(client.getSnapshot().cards, []);
  assert.deepEqual(server.remote.get('bob')?.progress.saved, []);
  assert.match(client.getSnapshot().notice, /其他标签页/);
  await client.authenticate('login', {email:'alice@example.com',password:'a-password'});
  assert.equal(client.getSnapshot().scope, 'alice');
  await client.logout();
});

test('two offline tabs preserve every card and history event across reload', async () => {
  const server = harness();
  const a = new AccountClient(); await a.initialize();
  await a.authenticate('login', {email:'alice@example.com',password:'a-password'});
  const b = new AccountClient(); await b.initialize();
  server.offline(true);
  a.collect(LEVELS[0].words[0], 'tab-a-run');
  b.collect(LEVELS[0].words[1], 'tab-b-run');
  await a.appendCompletion({...record,id:'tab-a-history'});
  await b.appendCompletion({...record,id:'tab-b-history'});
  const recovered = new AccountClient(); await recovered.initialize();
  assert.deepEqual(recovered.getSnapshot().cards.map(card=>card.wordId).sort(), LEVELS[0].words.slice(0,2).map(word=>word.id).sort());
  assert.equal(recovered.getSnapshot().pending.records.length,2);
  assert.ok(recovered.getSnapshot().cards.every(card=>card.count===1));
  server.offline(false); await recovered.sync();
  assert.equal(server.remote.get('alice')?.cards.length,2);
  assert.ok(server.remote.get('alice')?.cards.every(card=>card.count===1));
  assert.equal(server.remote.get('alice')?.records.length,2);
  await a.logout(); await b.logout(); await recovered.logout();
});

test('acknowledging an earlier tab request cannot delete a later tab mutation', async () => {
  const server = harness();
  const a = new AccountClient(); await a.initialize();
  await a.authenticate('login', {email:'alice@example.com',password:'a-password'});
  const b = new AccountClient(); await b.initialize();
  let release!:()=>void; const responseReady=new Promise<void>(resolve=>{release=resolve;});
  server.pause(()=>responseReady);
  a.collect(LEVELS[0].words[0],'tab-a-run'); const sending=a.sync();
  b.collect(LEVELS[0].words[1],'tab-b-run');
  release(); await sending; server.pause(null);
  assert.ok(a.getSnapshot().pending.cards.some(card=>card.wordId===LEVELS[0].words[1].id));
  await a.sync();
  assert.equal(server.remote.get('alice')?.cards.length,2);
  assert.ok(server.remote.get('alice')?.cards.every(card=>card.count===1));
  await a.logout(); await b.logout();
});

test('legacy whole-cache queues migrate once without double counting cards', async () => {
  const server=harness();
  await fetch('/api/auth/login',{method:'POST',body:JSON.stringify({email:'alice@example.com',password:'a-password'})});
  const base=emptyAccount(), word=LEVELS[0].words[0];
  const card={wordId:word.id,word:word.word,pos:word.pos,meaning:word.meaning,collectedAt:new Date().toISOString(),sourceId:'legacy-run'};
  localStorage.setItem('lingotiles.account.alice.v1',JSON.stringify({...base,cards:[{...card,count:1}],pending:{...base.pending,dirty:true,cards:[card]}}));
  const a=new AccountClient(); await a.initialize();
  assert.equal(a.getSnapshot().cards.length,1); assert.equal(a.getSnapshot().cards[0].count,1);
  const b=new AccountClient(); await b.initialize();
  assert.equal(b.getSnapshot().cards[0].count,1);
  assert.equal(server.remote.get('alice')?.cards[0].count,1);
  await a.logout(); await b.logout();
});

test('malformed immutable queue entries cannot poison valid offline changes', async () => {
  const server=harness(), a=new AccountClient(); await a.initialize();
  await a.authenticate('login',{email:'alice@example.com',password:'a-password'});
  server.offline(true); a.collect(LEVELS[0].words[0],'valid-run');
  const malformed=[
    {kind:'progress',value:{seen:null}},
    {kind:'progress',value:{...emptyAccount().progress,seen:['../bad']}},
    {kind:'card',value:{wordId:'apple',sourceId:'missing-meaning',collectedAt:new Date().toISOString()}},
    {kind:'favorite',value:{wordId:'apple',saved:'true',updatedAt:new Date().toISOString()}},
    {kind:'favorite',value:{wordId:'apple',saved:true,updatedAt:'not-a-date'}},
    {kind:'preferences',value:{matchAnimation:'true',updatedAt:new Date().toISOString()}},
    {kind:'preferences',value:{matchAnimation:true,updatedAt:'2999-01-01T00:00:00Z'}},
    {kind:'record',value:{...record,stars:8}},
  ];
  malformed.forEach((value,index)=>localStorage.setItem(`lingotiles.outbox.v1:alice:damaged-${index}`,JSON.stringify(value)));
  localStorage.setItem('lingotiles.outbox.v1:alice:invalid-json','{');
  const recovered=new AccountClient(); await recovered.initialize();
  assert.equal(recovered.getSnapshot().pending.cards.length,1);
  server.offline(false); await recovered.sync();
  assert.equal(server.remote.get('alice')?.cards.length,1);
  assert.equal(readOutbox('alice').length,0);
  assert.equal(recovered.getSnapshot().status,'synced');
  await a.logout(); await recovered.logout();
});

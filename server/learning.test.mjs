import test from 'node:test';
import assert from 'node:assert/strict';
import { readLearning, syncLearning } from './learning.mjs';

class MemoryStore {
  data = new Map();
  async transaction(mutator) {
    const next = new Map(structuredClone([...this.data]));
    const result = await mutator({
      get: async path => structuredClone(next.get(path) ?? null),
      list: async prefix => structuredClone([...next].filter(([path]) => path === prefix || path.startsWith(`${prefix}/`)).map(([path, value]) => ({ path, value }))),
      set: (path, value) => next.set(path, structuredClone(value)),
      delete: path => next.delete(path),
    });
    this.data = next;
    return result;
  }
}
const stamp = '2026-10-01T08:00:00.000Z';
const later = '2026-10-02T08:00:00.000Z';
const progress = { completed: { 1: { stars: 2, bestScore: 400, bestTime: 30 } }, seen: ['apple'], saved: ['apple'], sessions: 1, lastPlayed: '2026-10-01', streak: 1 };
const record = { id: 'session-1', levelId: 1, levelTitle: '词汇花园', mode: 'theme', wordCount: 8, gameSeconds: 40, studySeconds: 60, totalSeconds: 100, score: 700, stars: 3, assists: 1, completedAt: stamp };
const card = { wordId: 'apple', word: 'apple', pos: 'n.', meaning: '苹果', collectedAt: stamp, sourceId: 'run-1:apple' };

test('structured sync deduplicates history and card events across retries', async () => {
  const store = new MemoryStore();
  await syncLearning(store, 'user-a', { progress, records: [record], cards: [card] });
  const result = await syncLearning(store, 'user-a', { progress, records: [record, { ...record, completedAt: later }], cards: [card, card] });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].completedAt, stamp);
  assert.equal(result.cards[0].count, 1);
  assert.deepEqual(result.progress.completed['1'], { stars: 3, bestScore: 700, bestTime: 30 });
  assert.equal(result.progress.sessions, 1);
  assert.ok([...store.data.keys()].some(path => /^users\/user-a\/favorites\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(path)));
  assert.ok([...store.data.keys()].some(path => path.startsWith('users/user-a/history/2026/10/')));
  assert.ok(![...store.data.keys()].includes('users/user-a/learning.json'));
});

test('favorites tombstones survive stale devices and retries; newer explicit save wins', async () => {
  const store = new MemoryStore();
  await syncLearning(store, 'a', { progress });
  await syncLearning(store, 'a', { favoriteChanges: [{ wordId: 'apple', saved: false, updatedAt: later }] });
  let result = await syncLearning(store, 'a', { progress, favoriteChanges: [{ wordId: 'apple', saved: true, updatedAt: stamp }] });
  assert.deepEqual(result.progress.saved, []);
  result = await syncLearning(store, 'a', { favoriteChanges: [{ wordId: 'apple', saved: true, updatedAt: '2026-10-03T08:00:00.000Z' }] });
  assert.deepEqual(result.progress.saved, ['apple']);
});

test('independent best values, words and card collections merge without replacing other devices', async () => {
  const store = new MemoryStore();
  await syncLearning(store, 'a', { progress, cards: [card] });
  const result = await syncLearning(store, 'a', { progress: { ...progress, seen: ['leaf'], completed: { 1: { stars: 1, bestScore: 900, bestTime: 20 } }, sessions: 2 }, cards: [{ ...card, sourceId: 'run-2:apple', collectedAt: later }] });
  assert.deepEqual(result.progress.seen, ['apple', 'leaf']);
  assert.deepEqual(result.progress.completed['1'], { stars: 2, bestScore: 900, bestTime: 20 });
  assert.equal(result.cards[0].count, 2);
  assert.equal(result.cards[0].collectedAt, stamp);
  assert.equal(result.cards[0].lastCollectedAt, later);
});

test('learning and preferences are isolated by authenticated user id', async () => {
  const store = new MemoryStore();
  await syncLearning(store, 'a', { progress, preferences: { matchAnimation: true, updatedAt: later } });
  const empty = await readLearning(store, 'b');
  assert.deepEqual(empty.progress.seen, []);
  assert.deepEqual(empty.progress.saved, []);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.preferences, null);
  await syncLearning(store, 'a', { preferences: { matchAnimation: false, updatedAt: stamp } });
  assert.equal((await readLearning(store, 'a')).preferences.matchAnimation, true);
});

test('invalid payloads fail atomically; user-supplied ids cannot traverse paths', async () => {
  const store = new MemoryStore();
  await assert.rejects(syncLearning(store, '../other', { progress }), { status: 401 });
  await assert.rejects(syncLearning(store, 'a', { cards: [card, { ...card, sourceId: 'x', meaning: '' }] }), { status: 400 });
  assert.equal(store.data.size, 0);
  await assert.rejects(syncLearning(store, 'a', { records: [{ ...record, totalSeconds: 0 }] }), { status: 400 });
  await assert.rejects(syncLearning(store, 'a', { favoriteChanges: [{ wordId: '../../other', saved: true, updatedAt: stamp }] }), { status: 400 });
  await assert.rejects(syncLearning(store, 'a', { preferences: { matchAnimation: true, updatedAt: '2099-01-01' } }), { status: 400 });
  assert.equal(store.data.size, 0);
});

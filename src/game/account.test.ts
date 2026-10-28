import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAccount, emptyPending, mergeProgress, reconcileResponse, type LearningData } from '../account/data.ts';
import { cleanProgress } from './progress.ts';

const word = 'apple';
test('cloud favorite tombstone is not revived by stale local snapshot', () => {
  const stale = cleanProgress({ saved: [word], seen: [word] });
  const merged = mergeProgress(cleanProgress({ saved: [] }), stale);
  assert.deepEqual(merged.saved, []);
  assert.deepEqual(merged.seen, [word]);
});
test('explicit offline favorite deletion wins when response arrives', () => {
  const local = emptyAccount();
  const cloud: LearningData = { progress: cleanProgress({ saved: [word] }), cards: [], records: [], preferences: null };
  local.pending = { ...emptyPending(), dirty: true, revision: 2, favorites: [{ wordId: word, saved: false, updatedAt: '2026-10-28T00:00:02.000Z' }] };
  const next = reconcileResponse(cloud, local, { ...emptyPending(), dirty: true, revision: 1 });
  assert.deepEqual(next.progress.saved, []);
  assert.equal(next.pending.dirty, true);
  assert.equal(next.pending.favorites.length, 1);
});
test('response acknowledges only sent events and preserves changes made during upload', () => {
  const local = emptyAccount();
  const old = { wordId: word, saved: true, updatedAt: '2026-10-28T00:00:00.000Z' };
  const newer = { ...old, saved: false, updatedAt: '2026-10-28T00:00:02.000Z' };
  const sent = { ...emptyPending(), dirty: true, revision: 1, favorites: [old] };
  local.pending = { ...sent, revision: 2, favorites: [newer] };
  const next = reconcileResponse({ progress: cleanProgress({ saved: [word] }), cards: [], records: [], preferences: null }, local, sent);
  assert.deepEqual(next.pending.favorites, [newer]);
  assert.deepEqual(next.progress.saved, []);
});
test('best stars, score and time merge independently across devices', () => {
  const merged = mergeProgress(cleanProgress({ completed: { 1: { stars: 3, bestScore: 700, bestTime: 60 } } }), cleanProgress({ completed: { 1: { stars: 2, bestScore: 800, bestTime: 30 } } }));
  assert.deepEqual(merged.completed['1'], { stars: 3, bestScore: 800, bestTime: 30 });
});
test('acknowledged card event is not counted a second time', () => {
  const local = emptyAccount();
  const card = { wordId: word, word: 'apple', pos: 'n.', meaning: '苹果', collectedAt: '2026-10-28T00:00:00.000Z', sourceId: 'run:apple' };
  local.pending = { ...emptyPending(), dirty: true, revision: 1, cards: [card] };
  const cloud: LearningData = { progress: cleanProgress(null), records: [], cards: [{ ...card, count: 1 }], preferences: null };
  const next = reconcileResponse(cloud, local, local.pending);
  assert.equal(next.cards[0].count, 1);
  assert.equal(next.pending.cards.length, 0);
  assert.equal(next.pending.dirty, false);
});
test('partial upload retains unsent facts and schedules the next batch', () => {
  const local = emptyAccount();
  local.pending = { ...emptyPending(), dirty: true, revision: 1, seen: ['apple', 'bloom'] };
  const sent = { ...local.pending, seen: ['apple'] };
  const next = reconcileResponse({ progress: cleanProgress({ seen: ['apple'] }), cards: [], records: [], preferences: null }, local, sent);
  assert.deepEqual(next.pending.seen, ['bloom']);
  assert.equal(next.pending.dirty, true);
});

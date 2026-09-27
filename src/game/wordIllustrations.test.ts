import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { getWordIllustration, IllustrationQueue, WORD_ILLUSTRATIONS } from './wordIllustrations.ts';

const KEY = 'lingotiles.illustrations.pending.v1';
const apple = { word: 'apple', pos: 'n.', meaning: '苹果' };
const unseen = { word: 'morning', pos: 'n.', meaning: '早晨' };
function storage(initial = '[]') {
  const values = new Map([[KEY, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('images match exact senses, independent of word IDs, without guessing other meanings', () => {
  assert.equal(getWordIllustration(apple)?.src, './images/words/apple.webp');
  assert.equal(getWordIllustration({ word: ' APPLE ', pos: ' n. ', meaning: ' 苹果 ' })?.src, './images/words/apple.webp');
  assert.equal(getWordIllustration({ ...apple, meaning: '苹果公司' }), null);
  assert.equal(getWordIllustration({ word: 'water', pos: 'v.', meaning: '浇水' }), null);
  assert.equal(getWordIllustration({ word: 'grow', pos: 'v.', meaning: '种植' }), null);
  assert.equal(getWordIllustration(unseen), null);
});

test('every approved illustration has a distinct project asset and meaningful alternative text', () => {
  assert.equal(WORD_ILLUSTRATIONS.length, 6);
  assert.equal(new Set(WORD_ILLUSTRATIONS.map(item => item.src)).size, 6);
  for (const item of WORD_ILLUSTRATIONS) {
    assert.ok(existsSync(new URL(`../../public/${item.src.slice(2)}`, import.meta.url)), item.src);
    assert.ok(item.alt.length > 5);
  }
});

test('actual-play queue survives reload, deduplicates and keeps distinct senses', () => {
  const store = storage();
  const queue = new IllustrationQueue(store);
  assert.equal(queue.add(unseen, '2026-09-27T00:00:00.000Z'), true);
  assert.equal(queue.add(unseen, '2026-09-27T01:00:00.000Z'), true);
  assert.equal(queue.add({ word: 'water', pos: 'v.', meaning: '浇水' }), true);
  assert.equal(queue.add(apple), true);
  const reloaded = new IllustrationQueue(store).list();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[0].word, 'morning');
  assert.equal(reloaded[0].firstPlayedAt, '2026-09-27T00:00:00.000Z');
});

test('a new approved image removes its sense from old pending batches', () => {
  const queue = new IllustrationQueue(storage(JSON.stringify([
    { ...apple, firstPlayedAt: '2026-09-27T00:00:00.000Z' },
    { ...unseen, firstPlayedAt: '2026-09-27T00:00:01.000Z' },
  ])));
  assert.deepEqual(queue.list().map(item => item.word), ['morning']);
});

test('malformed or denied storage cannot interrupt matching or lose in-session export data', () => {
  for (const raw of ['{broken', 'null', '{}', '[null,{},12]']) {
    const queue = new IllustrationQueue(storage(raw));
    assert.deepEqual(queue.list(), []);
    assert.equal(queue.add(unseen), true);
    assert.equal(queue.list().length, 1);
  }
  for (const store of [null, { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); } }]) {
    const queue = new IllustrationQueue(store);
    assert.equal(queue.add(unseen), false);
    assert.equal(queue.add(unseen), false);
    assert.equal(queue.list().length, 1);
    assert.equal(queue.add(apple), true);
  }
});

test('queue validates untrusted saved records and exports only the defined data fields', () => {
  const queue = new IllustrationQueue(storage(JSON.stringify([
    { ...unseen, firstPlayedAt: 'bad date' },
    { ...apple, word: '', firstPlayedAt: '2026-09-27' },
    { ...unseen, firstPlayedAt: '2026-09-27', unexpected: 'discard' },
  ])));
  assert.deepEqual(queue.list(), [{ ...unseen, firstPlayedAt: '2026-09-27' }]);
  assert.equal(queue.add({ ...unseen, meaning: '' }), false);
  assert.equal(queue.list().length, 1);
});

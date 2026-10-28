import test from 'node:test';
import assert from 'node:assert/strict';
import { readOutbox } from '../account/outbox.ts';
import { cleanProgress } from './progress.ts';

test('a Shanghai calendar day after local midnight is valid before UTC midnight', () => {
  const originalNow = Date.now;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // Shanghai is 00:30 on October 29; UTC midnight on that day is still 7.5 hours away.
  Date.now = () => Date.parse('2026-10-28T16:30:00.000Z');
  const entries = new Map<string, string>([
    ['lingotiles.outbox.v1:alice:local-day', JSON.stringify({kind:'progress',value:cleanProgress({lastPlayed:'2026-10-29',sessions:1,streak:1})})],
    ['lingotiles.outbox.v1:alice:invalid-day', JSON.stringify({kind:'progress',value:{...cleanProgress(null),lastPlayed:'2026-02-30'}})],
    ['lingotiles.outbox.v1:alice:future-event', JSON.stringify({kind:'favorite',value:{wordId:'apple',saved:true,updatedAt:'2026-10-29T00:30:00.000Z'}})],
  ]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
  } });
  try {
    const recovered = readOutbox('alice');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].change.kind, 'progress');
    if (recovered[0].change.kind === 'progress') assert.equal(recovered[0].change.value.lastPlayed, '2026-10-29');
  } finally {
    Date.now = originalNow;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

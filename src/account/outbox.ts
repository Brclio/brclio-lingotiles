import { cleanProgress, type Progress } from '../game/progress.ts';
import { validateCompletion, type CompletionRecord } from '../game/history.ts';
import { emptyPending, mergeCards, mergeProgress, type CardEvent, type FavoriteChange, type LocalAccount, type Pending, type Preferences } from './data.ts';

type Change = { kind: 'progress'; value: Progress } | { kind: 'card'; value: CardEvent } | { kind: 'record'; value: CompletionRecord } | { kind: 'favorite'; value: FavoriteChange } | { kind: 'preferences'; value: Preferences };
export type OutboxEntry = { key: string; change: Change };
const prefix = (scope: string) => `lingotiles.outbox.v1:${encodeURIComponent(scope)}:`;
const eventIdentity = (card: CardEvent) => `${card.wordId}\n${card.sourceId}`;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const wordId = (value: unknown): value is string => text(value) && (/^[a-zA-Z0-9_-]+$/.test(value) || /^dict:[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()&/+_-]*$/u.test(value));
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 60) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0) && time <= Date.now() + 300_000;
};
const calendarDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
function parseChange(source: unknown): Change | null {
  if (!plain(source) || !plain(source.value)) return null;
  const value = source.value;
  switch (source.kind) {
    case 'progress': {
      if (!Array.isArray(value.seen) || !value.seen.every(wordId) || !Array.isArray(value.saved) || !value.saved.every(wordId) || !plain(value.completed)) return null;
      if (!['sessions', 'streak'].every(key => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
      if (value.lastPlayed !== null && !calendarDay(value.lastPlayed)) return null;
      return { kind: 'progress', value: cleanProgress(value) };
    }
    case 'card': {
      if (!wordId(value.wordId) || !text(value.word) || !text(value.pos, 40) || !text(value.meaning, 2000) || !text(value.sourceId) || !date(value.collectedAt)) return null;
      if (!['phonetic', 'example', 'exampleZh'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value[key])))) return null;
      return { kind: 'card', value: value as CardEvent };
    }
    case 'record': {
      if (!validateCompletion(value as CompletionRecord) || !date(value.completedAt) || !text(value.id) || !text(value.levelTitle)) return null;
      if (!/^(?:[1-6]|1[0-5][0-9]{4}|160000)$/.test(String(value.levelId)) || (value.wordCount as number) > 10_000) return null;
      if (['score', 'assists'].some(key => (value[key] as number) > 1_000_000) || ['gameSeconds', 'studySeconds', 'totalSeconds'].some(key => (value[key] as number) > 604_800)) return null;
      if (value.round !== undefined && (value.round as number) > 60_000) return null;
      return { kind: 'record', value: value as CompletionRecord };
    }
    case 'favorite': return wordId(value.wordId) && typeof value.saved === 'boolean' && date(value.updatedAt) ? { kind: 'favorite', value: value as FavoriteChange } : null;
    case 'preferences': return typeof value.matchAnimation === 'boolean' && date(value.updatedAt) ? { kind: 'preferences', value: value as Preferences } : null;
    default: return null;
  }
}
export function readOutbox(scope: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix(scope))) continue;
      try {
        const change = parseChange(JSON.parse(localStorage.getItem(key) ?? 'null'));
        if (change) entries.push({ key, change });
      } catch { /* A damaged entry must not prevent other records from recovering. */ }
    }
  } catch { /* The active client retains its in-memory queue when storage is unavailable. */ }
  return entries;
}
/** Each mutation receives its own key. Tabs never overwrite another tab's queue. */
export function enqueue(scope: string, change: Change, stableId?: string): void {
  localStorage.setItem(prefix(scope) + (stableId ?? crypto.randomUUID()), JSON.stringify(change));
}
export function queueChanges(scope: string, previous: LocalAccount, patch: Partial<LocalAccount>): void {
  const pending = patch.pending;
  for (const card of pending?.cards ?? []) if (!previous.pending.cards.some(old => eventIdentity(old) === eventIdentity(card))) enqueue(scope, { kind: 'card', value: card });
  for (const record of pending?.records ?? []) if (!previous.pending.records.some(old => old.id === record.id)) enqueue(scope, { kind: 'record', value: record });
  for (const favorite of pending?.favorites ?? []) if (!previous.pending.favorites.some(old => old.wordId === favorite.wordId && old.saved === favorite.saved && old.updatedAt === favorite.updatedAt)) enqueue(scope, { kind: 'favorite', value: favorite });
  if (patch.preferences) enqueue(scope, { kind: 'preferences', value: patch.preferences });
  if (patch.progress) {
    const next = patch.progress;
    const completed = Object.fromEntries(Object.entries(next.completed).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(previous.progress.completed[id])));
    const seen = next.seen.filter(id => !previous.progress.seen.includes(id));
    for (let start = 0; start < Math.max(1, seen.length); start += 500) enqueue(scope, { kind: 'progress', value: { ...next, completed: start ? {} : completed, seen: seen.slice(start, start + 500), saved: [] } });
  }
}
/** Copy older whole-cache queues once, with deterministic keys so interrupted migration is safe. */
export function migrateOutbox(scope: string, local: LocalAccount): void {
  const stable = (kind: string, id: string) => `legacy:${kind}:${encodeURIComponent(id)}`;
  for (const card of local.pending.cards) enqueue(scope, { kind: 'card', value: card }, stable('card', eventIdentity(card)));
  for (const record of local.pending.records) enqueue(scope, { kind: 'record', value: record }, stable('record', record.id));
  for (const favorite of local.pending.favorites) enqueue(scope, { kind: 'favorite', value: favorite }, stable('favorite', `${favorite.wordId}\n${favorite.updatedAt}\n${favorite.saved}`));
  if (local.pending.dirty) {
    const seen = local.pending.seen;
    for (let start = 0; start < Math.max(1, seen.length); start += 500) enqueue(scope, { kind: 'progress', value: { ...local.progress, seen: seen.slice(start, start + 500), saved: [] } }, stable('progress', String(start)));
    enqueue(scope, { kind: 'preferences', value: local.preferences }, stable('preferences', local.preferences.updatedAt));
  }
}
export function recoverOutbox(local: LocalAccount, entries: OutboxEntry[]): LocalAccount {
  let progress = local.progress, preferences = local.preferences;
  const cards = new Map<string, CardEvent>(), records = new Map<string, CompletionRecord>(), favorites = new Map<string, FavoriteChange>();
  const seen = new Set<string>();
  for (const { change } of entries) {
    switch (change.kind) {
      case 'progress': {
        const value = cleanProgress(change.value);
        progress = mergeProgress(progress, value);
        value.seen.forEach(id => seen.add(id));
        break;
      }
      case 'card': cards.set(eventIdentity(change.value), change.value); break;
      case 'record': records.set(change.value.id, change.value); break;
      case 'favorite': {
        const old = favorites.get(change.value.wordId);
        if (!old || change.value.updatedAt > old.updatedAt || (change.value.updatedAt === old.updatedAt && !change.value.saved)) favorites.set(change.value.wordId, change.value);
        break;
      }
      case 'preferences': if (change.value.updatedAt > preferences.updatedAt) preferences = change.value; break;
    }
  }
  const favoriteValues = [...favorites.values()], cardValues = [...cards.values()];
  const represented = new Set(local.pending.cards.map(eventIdentity));
  return { ...local, progress: mergeProgress(progress, progress, favoriteValues), preferences,
    cards: mergeCards(local.cards, cardValues.filter(card => !represented.has(eventIdentity(card)))),
    pending: { ...emptyPending(), dirty: entries.length > 0, revision: local.pending.revision, favorites: favoriteValues, cards: cardValues, records: [...records.values()], seen: [...seen] } };
}
/** Acknowledge immutable keys captured before the request; later mutations have different keys. */
export function acknowledgeOutbox(entries: OutboxEntry[], sent: Pending, preferences: Preferences): void {
  for (const { key, change } of entries) {
    const acknowledged = change.kind === 'card' ? sent.cards.some(card => eventIdentity(card) === eventIdentity(change.value))
      : change.kind === 'record' ? sent.records.some(record => record.id === change.value.id)
      : change.kind === 'favorite' ? sent.favorites.some(value => value.wordId === change.value.wordId && value.updatedAt >= change.value.updatedAt)
      : change.kind === 'progress' ? change.value.seen.every(id => sent.seen.includes(id))
      : preferences.updatedAt >= change.value.updatedAt;
    if (acknowledged) try { localStorage.removeItem(key); } catch { /* Retrying an acknowledged fact is idempotent on the server. */ }
  }
}

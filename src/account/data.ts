import { cleanProgress, type Progress } from '../game/progress.ts';
import type { Word } from '../data/vocabulary.ts';
import type { CompletionRecord } from '../game/history.ts';

export type AccountUser = { id: string; email: string; name: string; picture?: string; provider?: string };
export type Preferences = { matchAnimation: boolean; updatedAt: string };
export type FavoriteChange = { wordId: string; saved: boolean; updatedAt: string };
export type CardEvent = { wordId: string; word: string; pos: string; meaning: string; phonetic?: string; example?: string; exampleZh?: string; collectedAt: string; sourceId: string };
export type CollectedCard = Omit<CardEvent, 'sourceId'> & { lastCollectedAt?: string; count?: number };
export type LearningData = { progress: Progress; records: CompletionRecord[]; cards: CollectedCard[]; preferences: Preferences | null };
export type Pending = { favorites: FavoriteChange[]; cards: CardEvent[]; records: CompletionRecord[]; seen: string[]; revision: number; dirty: boolean };
export type LocalAccount = { progress: Progress; cards: CollectedCard[]; preferences: Preferences; pending: Pending; importedGuest?: boolean };

export function emptyPending(): Pending { return { favorites: [], cards: [], records: [], seen: [], revision: 0, dirty: false }; }
export function emptyAccount(): LocalAccount {
  return { progress: cleanProgress(null), cards: [], preferences: { matchAnimation: false, updatedAt: '2000-01-01T00:00:00.000Z' }, pending: emptyPending() };
}
/** Best values merge independently; explicit cloud favorites remain authoritative. */
export function mergeProgress(cloud: Progress, local: Progress, changes: FavoriteChange[] = []): Progress {
  const a = cleanProgress(cloud), b = cleanProgress(local);
  const completed = { ...a.completed };
  for (const [id, value] of Object.entries(b.completed)) {
    const old = completed[id];
    completed[id] = old ? { stars: Math.max(old.stars, value.stars), bestScore: Math.max(old.bestScore, value.bestScore), bestTime: Math.min(old.bestTime, value.bestTime) } : value;
  }
  const saved = new Set(a.saved);
  for (const change of [...changes].sort((x, y) => x.updatedAt.localeCompare(y.updatedAt))) {
    if (change.saved) saved.add(change.wordId); else saved.delete(change.wordId);
  }
  const last = (a.lastPlayed ?? '') >= (b.lastPlayed ?? '') ? a : b;
  return cleanProgress({ ...last, completed, seen: [...new Set([...a.seen, ...b.seen])], saved: [...saved], sessions: Math.max(a.sessions, b.sessions) });
}
export function mergeCards(existing: CollectedCard[], events: CardEvent[]): CollectedCard[] {
  const cards = new Map(existing.map(card => [card.wordId, card]));
  for (const event of events) {
    const { sourceId: _, ...value } = event;
    const previous = cards.get(event.wordId);
    cards.set(event.wordId, previous ? { ...previous, lastCollectedAt: value.collectedAt, count: (previous.count ?? 1) + 1 } : { ...value, count: 1, lastCollectedAt: value.collectedAt });
  }
  return [...cards.values()];
}
export function cardWord(card: CollectedCard): Word {
  return { id: card.wordId, word: card.word, pos: card.pos, meaning: card.meaning, phonetic: card.phonetic ?? '', example: card.example ?? '', exampleZh: card.exampleZh ?? '' };
}
export function reconcileResponse(cloud: LearningData, local: LocalAccount, sent: Pending): LocalAccount {
  const favorites = local.pending.favorites.filter(item => !sent.favorites.some(ack => ack.wordId === item.wordId && ack.updatedAt === item.updatedAt && ack.saved === item.saved));
  const cards = local.pending.cards.filter(item => !sent.cards.some(ack => ack.sourceId === item.sourceId && ack.wordId === item.wordId));
  const records = local.pending.records.filter(item => !sent.records.some(ack => ack.id === item.id));
  const seen = local.pending.seen.filter(id => !sent.seen.includes(id));
  const dirty = local.pending.revision !== sent.revision || favorites.length > 0 || cards.length > 0 || records.length > 0 || seen.length > 0;
  return { ...local, progress: mergeProgress(cloud.progress, local.progress, favorites), cards: mergeCards(cloud.cards, cards),
    preferences: !cloud.preferences || local.preferences.updatedAt > cloud.preferences.updatedAt ? local.preferences : cloud.preferences,
    pending: { favorites, cards, records, seen, revision: local.pending.revision, dirty } };
}

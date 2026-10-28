import { CompletionHistoryStore, validateCompletion, type CompletionRecord, type CompletionWrite } from '../game/history.ts';
import { cleanProgress, loadProgress, saveProgress, type Progress } from '../game/progress.ts';
import { loadMatchAnimation, saveMatchAnimation } from '../game/preferences.ts';
import type { Word } from '../data/vocabulary.ts';
import { acknowledgeOutbox, migrateOutbox, queueChanges, readOutbox, recoverOutbox } from './outbox.ts';
import { emptyAccount, emptyPending, mergeCards, mergeProgress, reconcileResponse, type AccountUser, type CardEvent, type LearningData, type LocalAccount } from './data.ts';

export type AccountSnapshot = LocalAccount & { user: AccountUser | null; ready: boolean; googleEnabled: boolean; status: 'local' | 'syncing' | 'synced' | 'pending' | 'error'; error: string; persisted: boolean; history: CompletionHistoryStore; historyRevision: number; scope: string; notice: string };
const CACHE_PREFIX = 'lingotiles.account.';
function loadLocal(id: string | null): LocalAccount {
  const initial = emptyAccount();
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${id ?? 'guest'}.v1`);
    const source = raw ? JSON.parse(raw) : {};
    const parsed = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const progress = cleanProgress(parsed.progress);
    const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const validCard = (value: unknown): boolean => {
      const card = value as CardEvent | null;
      return !!card && typeof card.wordId === 'string' && typeof card.word === 'string' && typeof card.pos === 'string' && typeof card.meaning === 'string' && validDate(card.collectedAt) && ['phonetic', 'example', 'exampleZh'].every(key => (card as unknown as Record<string, unknown>)[key] === undefined || typeof (card as unknown as Record<string, unknown>)[key] === 'string');
    };
    const array = <T>(value: unknown, check: (item: unknown) => boolean): T[] => Array.isArray(value) ? value.filter(check) as T[] : [];
    const queue = parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {};
    const value: LocalAccount = {
      progress, cards: array(parsed.cards, validCard), importedGuest: parsed.importedGuest === true,
      preferences: { matchAnimation: parsed.preferences?.matchAnimation === true, updatedAt: validDate(parsed.preferences?.updatedAt) ? parsed.preferences.updatedAt : initial.preferences.updatedAt },
      pending: { ...emptyPending(), dirty: queue.dirty === true, revision: Number.isSafeInteger(queue.revision) ? queue.revision : 0,
        seen: cleanProgress({ seen: queue.seen }).seen,
        records: array(queue.records, record => !!record && validateCompletion(record as CompletionRecord)),
        cards: array(queue.cards, item => validCard(item) && typeof (item as CardEvent).sourceId === 'string'),
        favorites: array(queue.favorites, item => {
          const change = item as { wordId?: unknown; saved?: unknown; updatedAt?: unknown } | null;
          return !!change && typeof change.wordId === 'string' && typeof change.saved === 'boolean' && validDate(change.updatedAt);
        }),
      },
    };
    const local = id ? value : { ...value, progress: loadProgress(), preferences: { ...value.preferences, matchAnimation: loadMatchAnimation() } };
    const scope = id ?? 'guest';
    if (parsed.outboxVersion !== 1) {
      try {
        migrateOutbox(scope, local);
        localStorage.setItem(`${CACHE_PREFIX}${scope}.v1`, JSON.stringify({ ...parsed, outboxVersion: 1 }));
      } catch { return local; }
    }
    return recoverOutbox(local, readOutbox(scope));
  } catch { return id ? initial : { ...initial, progress: loadProgress() }; }
}
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('账号服务暂时无法连接，请稍后重试。'); }
  if (!response.ok) {
    const message = (data as { error?: unknown }).error;
    throw new ApiError(typeof message === 'string' ? message : '请求未能完成，请重试。', response.status);
  }
  return data as T;
}
export class AccountClient {
  private snapshot: AccountSnapshot;
  private listeners = new Set<() => void>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing = new Set<number>();
  private stores = new Map<string, CompletionHistoryStore>();
  private boot: Promise<void> | null = null;
  constructor() {
    const history = new CompletionHistoryStore();
    this.stores.set('guest', history);
    this.snapshot = { ...loadLocal(null), user: null, ready: false, googleEnabled: false, status: 'local', error: '', persisted: true, history, historyRevision: 0, scope: 'guest', notice: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AccountSnapshot>, persist = false) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (persist) {
      const { progress, cards, preferences, pending, importedGuest, user } = this.snapshot;
      try {
        localStorage.setItem(`${CACHE_PREFIX}${user?.id ?? 'guest'}.v1`, JSON.stringify({ progress, cards, preferences, pending, importedGuest, outboxVersion: 1 }));
        this.snapshot.persisted = user ? true : saveProgress(progress) && saveMatchAnimation(preferences.matchAnimation);
      } catch { this.snapshot.persisted = false; }
    }
    this.listeners.forEach(listener => listener());
  }
  initialize = () => {
    if (this.boot) return this.boot;
    this.boot = api<{ user: AccountUser | null; googleEnabled: boolean }>('/api/auth/session').then(async result => {
      this.update({ googleEnabled: result.googleEnabled, ready: true });
      if (result.user) await this.activate(result.user);
    }).catch(error => this.update({ ready: true, error: error.message, status: 'error' }));
    return this.boot;
  };
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.snapshot.user) this.timer = setTimeout(() => { void this.sync(); }, 1200);
  }
  private refreshLocal() {
    if (this.snapshot.persisted) this.update(loadLocal(this.snapshot.user?.id ?? null));
  }
  private change(patch: Partial<LocalAccount>) {
    let queued = true;
    try { queueChanges(this.snapshot.scope, this.snapshot, patch); } catch { queued = false; }
    this.update({ ...patch, pending: { ...(patch.pending ?? this.snapshot.pending), revision: this.snapshot.pending.revision + 1, dirty: true }, status: this.snapshot.user ? 'pending' : 'local', error: '' }, true);
    if (!queued) this.update({ persisted: false });
    this.schedule();
  }
  setProgress = (value: Progress | ((previous: Progress) => Progress)) => {
    this.refreshLocal();
    const previous = this.snapshot.progress;
    const next = cleanProgress(typeof value === 'function' ? value(previous) : value);
    const changed = [...new Set([...previous.saved, ...next.saved])].filter(id => previous.saved.includes(id) !== next.saved.includes(id));
    const now = new Date().toISOString();
    const favorites = [...this.snapshot.pending.favorites.filter(item => !changed.includes(item.wordId)), ...changed.map(wordId => ({ wordId, saved: next.saved.includes(wordId), updatedAt: now }))];
    this.change({ progress: next, pending: { ...this.snapshot.pending, favorites, seen: [...new Set([...this.snapshot.pending.seen, ...next.seen.filter(id => !previous.seen.includes(id))])] } });
  };
  setMatchAnimation = (matchAnimation: boolean) => { this.refreshLocal(); this.change({ preferences: { matchAnimation, updatedAt: new Date().toISOString() } }); };
  collect = (word: Word, runId: string) => {
    this.refreshLocal();
    const event: CardEvent = { wordId: word.id, word: word.word, pos: word.pos, meaning: word.meaning, phonetic: word.phonetic, example: word.example, exampleZh: word.exampleZh, collectedAt: new Date().toISOString(), sourceId: runId };
    if (this.snapshot.pending.cards.some(item => item.sourceId === event.sourceId && item.wordId === event.wordId)) return;
    this.change({ cards: mergeCards(this.snapshot.cards, [event]), pending: { ...this.snapshot.pending, cards: [...this.snapshot.pending.cards, event] } });
  };
  appendCompletion = async (record: CompletionRecord): Promise<CompletionWrite> => {
    this.refreshLocal();
    const generation = this.generation, history = this.snapshot.history;
    // Persist the upload queue synchronously before yielding to IndexedDB.
    if (!this.snapshot.pending.records.some(item => item.id === record.id)) this.change({ pending: { ...this.snapshot.pending, records: [...this.snapshot.pending.records, record] } });
    const result = await history.append(record);
    if (generation === this.generation) this.update({ historyRevision: this.snapshot.historyRevision + 1 });
    return result;
  };
  private async activate(user: AccountUser | null) {
    const generation = ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    const scope = user?.id ?? 'guest';
    let history = this.stores.get(scope);
    if (!history) { history = new CompletionHistoryStore(undefined, `lingotiles.history.account.${scope}.v1`); this.stores.set(scope, history); }
    this.update({ ...loadLocal(user?.id ?? null), user, scope, history, historyRevision: 0, status: user ? 'syncing' : 'local', error: '', notice: '' });
    // A failed previous IndexedDB write remains recoverable from the durable queue.
    const recovery = this.snapshot.pending.records;
    for (const record of recovery) await history.append(record);
    if (generation !== this.generation) return;
    this.update({ historyRevision: this.snapshot.historyRevision + 1 });
    if (user) await this.sync();
  }
  authenticate = async (mode: 'login' | 'register', fields: { email: string; password: string; name?: string }) => {
    const response = await api<{ user: AccountUser }>(`/api/auth/${mode}`, fields);
    await this.activate(response.user);
  };
  logout = async () => {
    await api('/api/auth/logout', {});
    await this.activate(null);
  };
  importGuest = async () => {
    this.refreshLocal();
    if (!this.snapshot.user) return;
    const generation = this.generation;
    const history = this.snapshot.history;
    const guest = loadLocal(null);
    const records = await this.stores.get('guest')!.records();
    if (generation !== this.generation) return;
    const now = new Date().toISOString();
    const favoriteChanges = guest.progress.saved.map(wordId => ({ wordId, saved: true, updatedAt: now }));
    const events = guest.pending.cards.length ? guest.pending.cards : guest.cards.map(card => ({ ...card, sourceId: 'guest-import' }));
    this.change({ importedGuest: true, progress: mergeProgress(this.snapshot.progress, guest.progress, favoriteChanges), cards: mergeCards(this.snapshot.cards, events),
      pending: { ...this.snapshot.pending, seen: [...new Set([...this.snapshot.pending.seen, ...guest.progress.seen])], favorites: [...this.snapshot.pending.favorites, ...favoriteChanges], cards: [...this.snapshot.pending.cards, ...events], records: [...new Map([...this.snapshot.pending.records, ...records].map(item => [item.id, item])).values()] } });
    for (const record of records) await history.append(record);
    if (generation !== this.generation) return;
    this.update({ historyRevision: this.snapshot.historyRevision + 1 });
    await this.sync();
  };
  refreshSession = async () => {
    const generation = this.generation;
    try {
      const result = await api<{ user: AccountUser | null; googleEnabled: boolean }>('/api/auth/session');
      if (generation !== this.generation) return;
      this.update({ googleEnabled: result.googleEnabled });
      if ((result.user?.id ?? null) !== (this.snapshot.user?.id ?? null)) {
        await this.activate(result.user);
        this.update({ notice: result.user ? `其他标签页更改了登录账号，当前页面已切换为 ${result.user.name || result.user.email}。原账号的待同步记录仍保留。` : '其他标签页已退出登录，当前页面已恢复游客模式。原账号的待同步记录仍保留。' });
      } else if (result.user) await this.sync();
    } catch (error) {
      if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : '暂时无法确认账号状态。', status: 'error' });
    }
  };
  sync = async () => {
    const generation = this.generation;
    if (!this.snapshot.user || this.syncing.has(generation)) return;
    this.syncing.add(generation);
    this.refreshLocal();
    const outbox = readOutbox(this.snapshot.scope);
    const pending = structuredClone(this.snapshot.pending);
    const sent = { ...pending, records: pending.records.slice(0, 100), cards: pending.cards.slice(0, 100), favorites: pending.favorites.slice(0, 200), seen: pending.seen.slice(0, 500) };
    const data = this.snapshot;
    this.update({ status: 'syncing', error: '' });
    try {
      const cloud = await api<LearningData>('/api/learning' + (sent.dirty ? '/sync' : ''), sent.dirty ? { progress: { ...data.progress, seen: sent.seen, saved: [] }, records: sent.records, cards: sent.cards, preferences: data.preferences, favoriteChanges: sent.favorites } : undefined, { 'X-LingoTiles-Account': data.user!.id });
      if (generation !== this.generation) return;
      for (const record of cloud.records) await data.history.append(record);
      if (generation !== this.generation) return;
      const next = reconcileResponse(cloud, this.snapshot, sent);
      this.update({ ...next, historyRevision: this.snapshot.historyRevision + 1 }, true);
      acknowledgeOutbox(outbox, sent, data.preferences);
      this.refreshLocal();
      this.update({ status: this.snapshot.pending.dirty ? 'pending' : 'synced' }, true);
      if (this.snapshot.pending.dirty) this.schedule();
    } catch (error) {
      if (generation === this.generation && error instanceof ApiError && (error.status === 409 || error.status === 401)) {
        await this.refreshSession();
        if (generation === this.generation) this.update({ status: 'error', error: '登录状态已更新，请重试同步。' });
        return;
      }
      if (generation === this.generation) this.update({ status: 'error', error: error instanceof Error ? error.message : '同步失败，学习数据已保留在本机。' });
    } finally { this.syncing.delete(generation); }
  };
}

import { StoreError, storageKey } from './github-store.mjs';

const MAX_ITEMS = 2000;
const MAX_WORDS = 100_000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const number = (value, max = 1_000_000, integer = true) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isInteger(value));
const invalid = message => { throw new StoreError(message || '学习数据格式无效。', 400); };
const wordId = id => text(id) && (/^[a-zA-Z0-9_-]+$/.test(id) || /^dict:[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()&/+_-]*$/u.test(id));
const levelId = id => /^[1-6]$/.test(String(id)) || (/^\d{6}$/.test(String(id)) && Number(id) >= 100001 && Number(id) <= 160000);
const array = (value, maximum = MAX_ITEMS) => { if (!Array.isArray(value) || value.length > maximum) invalid('学习数据条数超出限制。'); return value; };
function timestamp(value) {
  if (typeof value !== 'string') invalid();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0) || ms > Date.now() + 300_000) invalid('学习数据的时间无效。');
  return new Date(ms).toISOString();
}
function day(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function userRoot(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new StoreError('账号身份无效。', 401);
  return `users/${userId}`;
}
function cleanProgress(value) {
  if (!plain(value)) invalid();
  const { seen = [], saved = [], completed = {}, sessions = 0, streak = 0, lastPlayed = null } = value;
  const seenIds = array(seen, MAX_WORDS), savedIds = array(saved, MAX_WORDS);
  if (!seenIds.every(wordId) || !savedIds.every(wordId) || !plain(completed) || Object.keys(completed).length > 60_006) invalid();
  if (!number(sessions) || !number(streak) || (lastPlayed !== null && !day(lastPlayed))) invalid();
  const levels = {};
  for (const [id, result] of Object.entries(completed)) {
    if (!levelId(id) || !plain(result) || !number(result.stars, 3) || result.stars < 1 || !number(result.bestScore) || !number(result.bestTime, 604_800, false)) invalid();
    levels[id] = { stars: result.stars, bestScore: result.bestScore, bestTime: result.bestTime };
  }
  return { seen: [...new Set(seenIds)], saved: [...new Set(savedIds)], completed: levels, sessions, streak, lastPlayed };
}
function cleanCompletion(value) {
  if (!plain(value)) invalid();
  if (!text(value.id) || !levelId(value.levelId) || !text(value.levelTitle) || !['theme', 'curriculum'].includes(value.mode)) invalid();
  for (const key of ['stageId', 'stageTitle']) if (value[key] !== undefined && !text(value[key])) invalid();
  if (value.round !== undefined && (!number(value.round, 60_000) || value.round < 1)) invalid();
  for (const key of ['wordCount', 'score', 'stars', 'assists']) if (!number(value[key])) invalid();
  if (value.wordCount < 1 || value.wordCount > 10_000 || value.stars < 1 || value.stars > 3) invalid();
  for (const key of ['gameSeconds', 'studySeconds', 'totalSeconds']) if (!number(value[key], 604_800, false)) invalid();
  if (Math.abs(value.totalSeconds - value.gameSeconds - value.studySeconds) > 0.001) invalid();
  return Object.fromEntries([
    ...['id', 'levelId', 'levelTitle', 'mode', 'stageId', 'stageTitle', 'round', 'wordCount', 'gameSeconds', 'studySeconds', 'totalSeconds', 'score', 'stars', 'assists'].filter(key => value[key] !== undefined).map(key => [key, value[key]]),
    ['completedAt', timestamp(value.completedAt)],
  ]);
}
function cleanCard(value) {
  if (!plain(value) || !wordId(value.wordId) || !text(value.word) || !text(value.pos, 40) || !text(value.meaning, 2000) || !text(value.sourceId)) invalid('收集词卡的数据无效。');
  for (const key of ['phonetic', 'example', 'exampleZh']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 2000 || /[\u0000-\u001f\u007f]/.test(value[key]))) invalid();
  return { ...Object.fromEntries(['wordId', 'word', 'pos', 'meaning', 'phonetic', 'example', 'exampleZh', 'sourceId'].filter(key => value[key] !== undefined).map(key => [key, value[key]])), collectedAt: timestamp(value.collectedAt) };
}
function cleanInput(body) {
  if (!plain(body)) invalid();
  const progress = body.progress === undefined ? null : cleanProgress(body.progress);
  const records = body.records === undefined ? [] : array(body.records).map(cleanCompletion);
  const cards = body.cards === undefined ? [] : array(body.cards).map(cleanCard);
  const favoriteChanges = (body.favoriteChanges === undefined ? [] : array(body.favoriteChanges)).map(value => {
    if (!plain(value) || !wordId(value.wordId) || typeof value.saved !== 'boolean') invalid('收藏变更无效。');
    return { wordId: value.wordId, saved: value.saved, updatedAt: timestamp(value.updatedAt) };
  });
  let preferences = null;
  if (body.preferences !== undefined && body.preferences !== null) {
    if (!plain(body.preferences) || typeof body.preferences.matchAnimation !== 'boolean') invalid('学习设置无效。');
    preferences = { matchAnimation: body.preferences.matchAnimation, updatedAt: timestamp(body.preferences.updatedAt) };
  }
  return { progress, records, cards, favoriteChanges, preferences };
}
const entityPath = (root, collection, id) => { const key = storageKey(String(id)); return `${root}/${collection}/${key.slice(0, 2)}/${key}.json`; };
const mergeLevel = (previous, value) => ({
  stars: Math.max(previous?.stars ?? 0, value.stars),
  bestScore: Math.max(previous?.bestScore ?? 0, value.bestScore),
  bestTime: previous ? Math.min(previous.bestTime, value.bestTime) : value.bestTime,
});

async function learningFrom(tx, root) {
  const [words, favorites, levels, history, cards, summary, preferences] = await Promise.all([
    tx.list(`${root}/words`), tx.list(`${root}/favorites`), tx.list(`${root}/levels`), tx.list(`${root}/history`),
    tx.list(`${root}/cards`), tx.get(`${root}/progress/summary.json`), tx.get(`${root}/preferences/settings.json`),
  ]);
  const records = history.map(entry => entry.value).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id));
  return {
    progress: {
      completed: Object.fromEntries(levels.map(({ value }) => [String(value.levelId), { stars: value.stars, bestScore: value.bestScore, bestTime: value.bestTime }])),
      seen: words.map(entry => entry.value.wordId).sort(),
      saved: favorites.map(entry => entry.value).filter(value => value.saved).map(value => value.wordId).sort(),
      sessions: Math.max(summary?.sessions ?? 0, records.length),
      lastPlayed: summary?.lastPlayed ?? null,
      streak: summary?.streak ?? 0,
    },
    records,
    cards: cards.map(entry => entry.value).sort((a, b) => b.lastCollectedAt.localeCompare(a.lastCollectedAt) || a.wordId.localeCompare(b.wordId)),
    preferences: preferences ?? null,
  };
}

export async function readLearning(store, userId) {
  const root = userRoot(userId);
  return store.transaction(tx => learningFrom(tx, root));
}

/** Merge additive facts, immutable history and timestamped changes inside one atomic Git commit. */
export async function syncLearning(store, userId, body) {
  const root = userRoot(userId);
  const data = cleanInput(body); // Validate the entire request before performing any writes.
  const now = new Date().toISOString();
  return store.transaction(async tx => {
    // Resolve just the entities this mutation may read, then batch immutable blob reads.
    // REST-only/in-memory repositories can keep their original get/list implementation.
    if (tx.prefetch) {
      const paths = new Set();
      if (data.progress) {
        paths.add(`${root}/progress/summary.json`);
        for (const id of data.progress.seen) paths.add(entityPath(root, 'words', id));
        for (const id of data.progress.saved) paths.add(entityPath(root, 'favorites', id));
        for (const id of Object.keys(data.progress.completed)) paths.add(entityPath(root, 'levels', id));
      }
      for (const change of data.favoriteChanges) paths.add(entityPath(root, 'favorites', change.wordId));
      for (const record of data.records) {
        paths.add(entityPath(root, 'history-ids', record.id));
        paths.add(entityPath(root, 'levels', record.levelId));
      }
      for (const card of data.cards) {
        paths.add(entityPath(root, 'words', card.wordId));
        paths.add(entityPath(root, 'cards', card.wordId));
        paths.add(`${root}/card-events/${storageKey(card.wordId)}/${storageKey(card.sourceId)}.json`);
      }
      if (data.preferences) paths.add(`${root}/preferences/settings.json`);
      await tx.prefetch([...paths]);
    }
    const remember = async id => {
      const path = entityPath(root, 'words', id);
      if (!await tx.get(path)) tx.set(path, { wordId: id, firstSeenAt: now });
    };
    const addLevel = async (id, result) => {
      const path = entityPath(root, 'levels', id);
      const previous = await tx.get(path);
      tx.set(path, { levelId: String(id), ...mergeLevel(previous, result) });
    };
    if (data.progress) {
      for (const id of data.progress.seen) await remember(id);
      for (const id of data.progress.saved) {
        const path = entityPath(root, 'favorites', id);
        // A legacy snapshot may import a missing favorite, but can never undo a tombstone.
        if (!await tx.get(path)) tx.set(path, { wordId: id, saved: true, updatedAt: '2000-01-01T00:00:00.000Z' });
      }
      for (const [id, result] of Object.entries(data.progress.completed)) await addLevel(id, result);
      const path = `${root}/progress/summary.json`;
      const previous = await tx.get(path);
      const lastPlayed = [previous?.lastPlayed, data.progress.lastPlayed].filter(Boolean).sort().at(-1) ?? null;
      const sameDay = previous?.lastPlayed === data.progress.lastPlayed;
      const streak = sameDay ? Math.max(previous?.streak ?? 0, data.progress.streak) : lastPlayed === data.progress.lastPlayed ? data.progress.streak : previous?.streak ?? 0;
      tx.set(path, { sessions: Math.max(previous?.sessions ?? 0, data.progress.sessions), lastPlayed, streak });
    }
    for (const change of data.favoriteChanges) {
      const path = entityPath(root, 'favorites', change.wordId);
      const previous = await tx.get(path);
      if (!previous || change.updatedAt > previous.updatedAt || (change.updatedAt === previous.updatedAt && !change.saved)) tx.set(path, change);
    }
    for (const record of data.records) {
      // IDs are hashed, so arbitrary client IDs can never create directories or escape an account.
      const idIndex = entityPath(root, 'history-ids', record.id);
      if (await tx.get(idIndex)) continue;
      const path = `${root}/history/${record.completedAt.slice(0, 4)}/${record.completedAt.slice(5, 7)}/${storageKey(record.id)}.json`;
      tx.set(path, record); tx.set(idIndex, { path });
      await addLevel(record.levelId, { stars: record.stars, bestScore: record.score, bestTime: Math.floor(record.gameSeconds) });
    }
    for (const card of data.cards) {
      const key = storageKey(card.wordId);
      const eventPath = `${root}/card-events/${key}/${storageKey(card.sourceId)}.json`;
      if (await tx.get(eventPath)) continue;
      tx.set(eventPath, { sourceId: card.sourceId, collectedAt: card.collectedAt });
      const path = entityPath(root, 'cards', card.wordId);
      const previous = await tx.get(path);
      const { sourceId: _sourceId, ...details } = card;
      const collectedAt = [previous?.collectedAt, card.collectedAt].filter(Boolean).sort()[0];
      const lastCollectedAt = [previous?.lastCollectedAt, card.collectedAt].filter(Boolean).sort().at(-1);
      const snapshot = previous && previous.lastCollectedAt > card.collectedAt ? previous : details;
      tx.set(path, { ...snapshot, collectedAt, lastCollectedAt, count: Math.min(1_000_000, (previous?.count ?? 0) + 1) });
      await remember(card.wordId);
    }
    if (data.preferences) {
      const path = `${root}/preferences/settings.json`;
      const previous = await tx.get(path);
      if (!previous || data.preferences.updatedAt > previous.updatedAt) tx.set(path, data.preferences);
    }
    return learningFrom(tx, root);
  }, { message: 'Sync learning records, favorites and collected cards' });
}

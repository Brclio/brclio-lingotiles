/** Illustrations are approved for an exact spelling + part of speech + meaning. */
export type IllustratedSense = { word: string; pos: string; meaning: string };
export type WordIllustration = { src: string; alt: string };

export const WORD_ILLUSTRATIONS: ReadonlyArray<IllustratedSense & WordIllustration> = [
  { word: 'apple', pos: 'n.', meaning: '苹果', src: './images/words/apple.webp', alt: '一颗带绿叶的红苹果' },
  { word: 'leaf', pos: 'n.', meaning: '叶子', src: './images/words/leaf.webp', alt: '一片叶脉清晰的绿色叶子' },
  { word: 'water', pos: 'n.', meaning: '水', src: './images/words/water.webp', alt: '清水倒入透明玻璃杯' },
  { word: 'grow', pos: 'v.', meaning: '生长', src: './images/words/grow.webp', alt: '植物从萌芽逐渐长成枝叶茂盛的小苗' },
  { word: 'fresh', pos: 'adj.', meaning: '新鲜的', src: './images/words/fresh.webp', alt: '带着露珠的刚采摘的蔬菜' },
  { word: 'slowly', pos: 'adv.', meaning: '缓慢地', src: './images/words/slowly.webp', alt: '一只蜗牛缓慢地爬过花园小路' },
];

function senseKey(sense: IllustratedSense): string {
  return JSON.stringify([sense.word.trim().toLowerCase(), sense.pos.trim().toLowerCase(), sense.meaning.normalize('NFC').trim()]);
}
const illustrations = new Map(WORD_ILLUSTRATIONS.map(item => [senseKey(item), item]));

export function getWordIllustration(word: IllustratedSense): WordIllustration | null {
  return illustrations.get(senseKey(word)) ?? null;
}

const preloaded = new Map<string, HTMLImageElement>();
/** Warm only this level's images. Never block the memorization or match timers. */
export function preloadWordIllustrations(words: IllustratedSense[]): void {
  if (typeof Image === 'undefined') return;
  for (const word of words) {
    const image = getWordIllustration(word);
    if (!image || preloaded.has(image.src)) continue;
    const element = new Image();
    preloaded.set(image.src, element);
    element.onerror = () => { preloaded.delete(image.src); };
    element.src = image.src;
  }
}

export type PendingIllustration = IllustratedSense & { firstPlayedAt: string };
const QUEUE_KEY = 'lingotiles.illustrations.pending.v1';
type QueueStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): QueueStorage | null {
  if (typeof window === 'undefined') return null;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function isPending(value: unknown): value is PendingIllustration {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['word', 'pos', 'meaning'].every(key => typeof record[key] === 'string' && (record[key] as string).trim().length > 0 && (record[key] as string).length <= 1000)
    && typeof record.firstPlayedAt === 'string' && Number.isFinite(Date.parse(record.firstPlayedAt));
}

/** Records only words actually matched; no dictionary-wide guessing or remote calls. */
export class IllustrationQueue {
  private temporary = new Map<string, PendingIllustration>();
  private storage: QueueStorage | null;
  constructor(storage: QueueStorage | null = browserStorage()) { this.storage = storage; }

  list(): PendingIllustration[] {
    const records = new Map<string, PendingIllustration>();
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(QUEUE_KEY) ?? '[]');
      if (Array.isArray(parsed)) for (const value of parsed) if (isPending(value)) {
        const { word, pos, meaning, firstPlayedAt } = value;
        records.set(senseKey(value), { word, pos, meaning, firstPlayedAt });
      }
    } catch { /* Keep any in-session records available when local storage fails. */ }
    for (const [key, value] of this.temporary) if (!records.has(key)) records.set(key, value);
    return [...records.values()].filter(value => !getWordIllustration(value)).sort((a, b) => a.firstPlayedAt.localeCompare(b.firstPlayedAt));
  }

  add(word: IllustratedSense, now = new Date().toISOString()): boolean {
    if (getWordIllustration(word)) return true;
    const value = { word: word.word, pos: word.pos, meaning: word.meaning, firstPlayedAt: now };
    if (!isPending(value)) return false;
    const records = this.list();
    const key = senseKey(word);
    if (!records.some(item => senseKey(item) === key)) records.push(value);
    this.temporary = new Map(records.map(item => [senseKey(item), item]));
    try {
      if (!this.storage) return false;
      this.storage.setItem(QUEUE_KEY, JSON.stringify(records));
      this.temporary.clear();
      return true;
    } catch { return false; }
  }
}

const queue = new IllustrationQueue();
export const recordIllustrationPractice = (word: IllustratedSense): boolean => queue.add(word);
export const getMissingIllustrations = (): PendingIllustration[] => queue.list();

/** Downloading a batch does not erase it. Newly approved senses disappear automatically. */
export function exportMissingIllustrations(): void {
  const words = queue.list();
  const blob = new Blob([JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), words }, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `lingotiles-待配图-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

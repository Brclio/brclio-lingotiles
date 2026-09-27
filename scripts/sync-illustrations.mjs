#!/usr/bin/env node
/** Publish only reviewed, real assets; never treat a planned prompt as a finished image. */
import { readFile, readdir, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../src/data/vocabulary.ts';
import { illustrationBucket, illustrationSenseKey } from '../src/data/illustrationSchema.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const vocabulary = JSON.parse(await readFile(resolve(root, 'public/vocabulary/manifest.json'), 'utf8'));
const curated = new Map(LEVELS.flatMap(level => level.words).map(word => [word.word.toLowerCase(), word]));
const senses = new Set();
for (const stage of vocabulary.stages) for (const chunk of stage.chunks) {
  const words = JSON.parse(await readFile(resolve(root, `public${chunk.path}`), 'utf8'));
  for (const word of words) senses.add(illustrationSenseKey(curated.get(word.word.toLowerCase()) ?? word));
}
if (senses.size !== vocabulary.total) throw Error('词库义项数量不一致');
const seedBefore = JSON.parse(await readFile(resolve(root, 'src/data/illustrations.seed.json'), 'utf8').catch(() => '[]'));
const oldAlt = new Map(seedBefore.map(value => [illustrationSenseKey(value), value.alt]));
const accepted = new Map();
const usedPaths = new Set();
const imageRoot = await realpath(resolve(root, 'public/images/words'));
for (const file of (await readdir(resolve(root, 'docs/imagegen'))).filter(name => name.endsWith('.json')).sort()) {
  const metadata = JSON.parse(await readFile(resolve(root, 'docs/imagegen', file), 'utf8'));
  for (const asset of metadata.assets ?? []) {
    if (asset.reviewed !== true) continue;
    if (!(metadata.tool === 'image_gen' || /built[ -]?in|builtin/.test(metadata.mode ?? ''))) throw Error(`${file}: 缺少内置 imagegen 来源记录`);
    if (['pending', 'generating', 'failed', 'rejected'].includes(asset.status)) throw Error(`${file}: 非完成资源不能标记已审核`);
    for (const key of ['word', 'pos', 'meaning', 'prompt', 'source', 'savedPath']) {
      if (typeof asset[key] !== 'string' || !asset[key].trim()) throw Error(`${file}: missing ${key}`);
    }
    const key = illustrationSenseKey(asset);
    if (!senses.has(key)) throw Error(`${file}: not an exact game sense: ${asset.word}`);
    if (accepted.has(key)) throw Error(`${file}: duplicate reviewed sense: ${asset.word}`);
    const fullPath = resolve(root, asset.savedPath);
    const local = relative(resolve(root, 'public/images/words'), fullPath);
    if (local.startsWith('..') || !local.endsWith('.webp')) throw Error(`非法资源路径: ${asset.savedPath}`);
    const physicalPath = await realpath(fullPath);
    if (relative(imageRoot, physicalPath).startsWith('..')) throw Error(`图片位于资源目录之外: ${asset.savedPath}`);
    if (usedPaths.has(physicalPath)) throw Error(`多个义项使用同一张图片: ${asset.savedPath}`);
    usedPaths.add(physicalPath);
    const bytes = await readFile(fullPath);
    if (bytes.length <= 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error(`不是有效 WebP: ${asset.savedPath}`);
    const alt = asset.alt ?? oldAlt.get(key) ?? `${asset.word}：${asset.meaning}的词义插图`;
    const src = `./${relative(resolve(root, 'public'), fullPath).replaceAll('\\', '/')}`;
    accepted.set(key, { word: asset.word, pos: asset.pos, meaning: asset.meaning, src, alt });
  }
}
const entries = [...accepted.values()].sort((a, b) => illustrationSenseKey(a).localeCompare(illustrationSenseKey(b), 'en'));
const grouped = new Map();
for (const entry of entries) {
  const bucket = illustrationBucket(entry);
  if (!grouped.has(bucket)) grouped.set(bucket, []);
  grouped.get(bucket).push(entry);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const revision = hash(JSON.stringify(entries)).slice(0, 16);
const index = { version: 1, total: vocabulary.total, ready: entries.length, pending: vocabulary.total - entries.length, revision, buckets: {} };
const outputs = new Map();
for (const [bucket, values] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
  const data = `${JSON.stringify(values)}\n`;
  const path = `images/words/index/${bucket}.json`;
  index.buckets[bucket] = { path, count: values.length, sha256: hash(data) };
  outputs.set(`public/${path}`, data);
}
outputs.set('public/images/words/index/manifest.json', `${JSON.stringify(index, null, 2)}\n`);
const curatedKeys = new Set([...curated.values()].map(illustrationSenseKey));
outputs.set('src/data/illustrations.seed.json', `${JSON.stringify(entries.filter(entry => curatedKeys.has(illustrationSenseKey(entry))), null, 2)}\n`);
for (const [path, data] of outputs) {
  const target = resolve(root, path);
  if (check) {
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing !== data) throw Error(`配图索引需要同步: ${path}`);
  } else {
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, data);
  }
}
console.log(JSON.stringify({ total: index.total, ready: index.ready, pending: index.pending, buckets: grouped.size, seed: entries.filter(entry => curatedKeys.has(illustrationSenseKey(entry))).length, checked: check }, null, 2));

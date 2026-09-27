#!/usr/bin/env node
/** Local, deterministic generation inventory; this script never calls an image API. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEVELS } from '../src/data/vocabulary.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARD_SIZE = 1000;
const VERSION = 1;
const sha256 = data => createHash('sha256').update(data).digest('hex');
// Keep this normalization identical to src/game/wordIllustrations.ts.
export const senseKey = sense => JSON.stringify([sense.word.trim().toLowerCase(), sense.pos.trim().toLowerCase(), sense.meaning.normalize('NFC').trim()]);
export const senseId = sense => sha256(senseKey(sense));
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const relative = file => path.relative(ROOT, file).split(path.sep).join('/');

function inside(root, file) {
  const relation = path.relative(root, file);
  return relation !== '' && !relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation);
}

export function makePrompt(word) {
  return [
    'Use case: scientific-educational',
    'Asset type: one square illustration for an English vocabulary memory card.',
    `Exact target sense: ${JSON.stringify({ word: word.word, pos: word.pos, meaning: word.meaning })}.`,
    'Primary request: depict only this part of speech and Chinese meaning, never another sense of the spelling.',
    ...(word.example ? [`Sense context (not image text): ${word.example} ${word.exampleZh ?? ''}`] : []),
    'Subject: a recognizable object for a concrete noun; an unmistakable action for a verb; a specific visible property for an adjective. For abstract meanings and function words, use a concrete, neutral everyday vignette that demonstrates the precise relationship or concept. Do not substitute a generic decorative picture. If the supplied sense cannot be represented accurately, flag it for human review before generation.',
    'Style/medium: hand-painted gouache with subtle colored-pencil texture on warm off-white paper, matching the existing garden vocabulary illustrations.',
    'Composition: one clear subject or tightly related scene centered within the middle 70 percent, generous empty space, fully visible and legible on a small card. Soft daylight, natural muted green, blue and coral as appropriate.',
    'Constraints: no letters, numbers, written labels, logos, watermarks, borders or card UI; no unrelated objects; no generic stock icon.',
  ].join('\n');
}

export async function readVocabulary() {
  const manifestFile = path.join(ROOT, 'public/vocabulary/manifest.json');
  const manifest = await readJson(manifestFile);
  const curated = new Map(LEVELS.flatMap(level => level.words).map(word => [word.word.toLowerCase(), word]));
  assert(curated.size === 54 && manifest.curatedWordCount === curated.size, 'Expected exactly 54 curated overrides.');
  assert(manifest.total === 100000 && manifest.stages.length === 6, 'Expected 100,000 words in six stages.');
  const words = [], spellings = new Set(), identifiers = new Set(), sourceIds = new Set(), seenCurated = new Set();
  const stageIds = new Set();
  for (const stage of manifest.stages) {
    assert(hasText(stage.id) && !stageIds.has(stage.id), `Invalid or duplicate stage ${stage.id}.`);
    stageIds.add(stage.id);
    let stageCount = 0;
    for (const chunk of stage.chunks) {
      assert(chunk.start === stageCount, `Noncontiguous vocabulary chunk ${chunk.path}.`);
      const file = path.resolve(ROOT, 'public', chunk.path.replace(/^\//, ''));
      assert(inside(path.join(ROOT, 'public/vocabulary'), file), `Unsafe vocabulary path ${chunk.path}.`);
      const bytes = await fs.readFile(file);
      assert(bytes.length === chunk.bytes && sha256(bytes) === chunk.sha256, `Vocabulary source checksum mismatch: ${chunk.path}.`);
      const rows = JSON.parse(bytes.toString('utf8'));
      assert(Array.isArray(rows) && rows.length === chunk.count, `Vocabulary chunk count mismatch: ${chunk.path}.`);
      for (const raw of rows) {
        assert(['id', 'word', 'pos', 'meaning'].every(key => hasText(raw[key])), `Incomplete vocabulary row in ${chunk.path}.`);
        assert(raw.stageId === stage.id, `Unexpected stage for ${raw.word}.`);
        const original = curated.get(raw.word.toLowerCase());
        // This is the exact overlay applied by library.ts, including id/POS/meaning.
        const word = original ? { ...raw, ...original } : raw;
        if (original) seenCurated.add(raw.word.toLowerCase());
        const spelling = word.word.toLowerCase();
        const id = senseId(word);
        assert(!spellings.has(spelling), `Duplicate spelling: ${word.word}.`);
        assert(!identifiers.has(id), `Duplicate sense: ${word.word}.`);
        assert(!sourceIds.has(raw.id), `Duplicate source ID: ${raw.id}.`);
        spellings.add(spelling); identifiers.add(id); sourceIds.add(raw.id);
        words.push({ senseId: id, wordId: word.id, sourceId: raw.id, word: word.word, pos: word.pos, meaning: word.meaning, stageId: stage.id, curated: !!original, example: word.example, exampleZh: word.exampleZh });
      }
      stageCount += rows.length;
    }
    assert(stageCount === stage.count, `Stage count mismatch: ${stage.id}.`);
  }
  assert(words.length === manifest.total, 'Total vocabulary count mismatch.');
  assert(seenCurated.size === curated.size, 'A curated override is missing from the dictionary.');
  return { words, manifest, vocabularySha256: sha256(await fs.readFile(manifestFile)), curatedSha256: sha256(await fs.readFile(path.join(ROOT, 'src/data/vocabulary.ts'))) };
}

async function inspectImage(file) {
  const bytes = await fs.readFile(file);
  const webp = bytes.length > 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  const png = bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length > 32 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  assert(webp || png || jpeg, 'File is not a complete recognized WebP, PNG or JPEG.');
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

export async function readGeneratedAssets(words) {
  const senses = new Set(words.map(word => senseId(word)));
  const assets = new Map(), issues = [], usedPaths = new Map();
  const directory = path.join(ROOT, 'docs/imagegen');
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json')).sort();
  for (const filename of files) {
    const metadataPath = `docs/imagegen/${filename}`;
    let metadata;
    try { metadata = await readJson(path.join(directory, filename)); }
    catch (error) { issues.push({ metadataPath, reason: `Unreadable metadata: ${error.message}` }); continue; }
    if (!Array.isArray(metadata.assets)) { issues.push({ metadataPath, reason: 'No assets array; no generated images accepted.' }); continue; }
    const builtin = metadata.tool === 'image_gen' || /built[ -]?in|builtin/.test(metadata.mode ?? '');
    for (const [assetIndex, asset] of metadata.assets.entries()) {
      const label = { metadataPath, assetIndex, word: asset.word ?? null };
      try {
        assert(builtin, 'Missing built-in image_gen provenance.');
        assert(['word', 'pos', 'meaning', 'prompt', 'source', 'savedPath'].every(key => hasText(asset[key])), 'Incomplete generation metadata (pending).');
        assert(asset.reviewed === true, 'Image has not been explicitly visually reviewed.');
        assert(!['pending', 'generating', 'failed', 'rejected'].includes(asset.status), `Generation status is ${asset.status}.`);
        const id = senseId(asset);
        assert(senses.has(id), 'Spelling/POS/meaning does not match an exact game sense.');
        const file = path.resolve(ROOT, asset.savedPath);
        assert(inside(path.join(ROOT, 'public/images/words'), file), 'Saved image is outside public/images/words.');
        const realFile = await fs.realpath(file);
        assert(inside(path.join(ROOT, 'public/images/words'), realFile), 'Image symlink is outside the project image directory.');
        const inspected = await inspectImage(file);
        const savedPath = relative(file);
        assert(!usedPaths.has(savedPath) || usedPaths.get(savedPath) === id, 'The same file is assigned to different senses.');
        usedPaths.set(savedPath, id);
        assert(!assets.has(id) || assets.get(id).sha256 === inspected.sha256, 'Conflicting generated images for the same sense.');
        if (!assets.has(id)) assets.set(id, { ...inspected, savedPath, metadataPath, assetIndex, source: asset.source, mode: 'built-in image_gen', reviewed: true, prompt: asset.prompt });
      } catch (error) { issues.push({ ...label, reason: error.message }); }
    }
  }
  return { assets, issues };
}

export async function buildCatalog() {
  const vocabulary = await readVocabulary();
  const { assets, issues } = await readGeneratedAssets(vocabulary.words);
  const jobs = vocabulary.words.map(({ example, exampleZh, ...word }) => {
    const generated = assets.get(word.senseId);
    return {
      ...word,
      prompt: makePrompt({ ...word, example, exampleZh }),
      desiredAssetPath: `public/images/words/${word.senseId.slice(0, 2)}/${word.senseId}.webp`,
      status: generated ? 'ready' : 'pending',
      ...(generated ? { asset: generated } : {}),
    };
  });
  const shards = [], index = {};
  for (const stage of vocabulary.manifest.stages) {
    const stageJobs = jobs.filter(job => job.stageId === stage.id);
    for (let start = 0; start < stageJobs.length; start += SHARD_SIZE) {
      const subset = stageJobs.slice(start, start + SHARD_SIZE);
      const file = `jobs/${stage.id}-${String(start / SHARD_SIZE + 1).padStart(3, '0')}.json`;
      const content = `[\n${subset.map(job => JSON.stringify(job)).join(',\n')}\n]\n`;
      const ready = subset.filter(job => job.status === 'ready').length;
      shards.push({ file, stageId: stage.id, count: subset.length, ready, pending: subset.length - ready, bytes: Buffer.byteLength(content), sha256: sha256(content), content });
      subset.forEach((job, position) => { index[job.senseId] = [file, position]; });
    }
  }
  const indexContent = `${JSON.stringify(index)}\n`;
  const manifest = {
    version: VERSION,
    scope: 'all 100000 unique game vocabulary entries with the 54 curated overrides applied',
    execution: 'local generation plan only; no automatic imagegen or API worker',
    source: { ...vocabulary.manifest.source, vocabularyManifestSha256: vocabulary.vocabularySha256, curatedSourceSha256: vocabulary.curatedSha256 },
    senseIdAlgorithm: 'SHA256(UTF8(JSON.stringify([word.trim().toLowerCase(),pos.trim().toLowerCase(),meaning.normalize("NFC").trim()])))',
    total: jobs.length,
    ready: assets.size,
    pending: jobs.length - assets.size,
    curated: { total: 54, ready: jobs.filter(job => job.curated && job.status === 'ready').length },
    readyMeaning: 'Exact game sense, built-in generation metadata, explicit reviewed:true and saved image bytes verified; application registration is checked separately.',
    stages: vocabulary.manifest.stages.map(stage => ({ id: stage.id, title: stage.title, total: stage.count, ready: jobs.filter(job => job.stageId === stage.id && job.status === 'ready').length })),
    index: { file: 'index.json', count: jobs.length, bytes: Buffer.byteLength(indexContent), sha256: sha256(indexContent) },
    shards: shards.map(({ content, ...shard }) => shard),
    metadataIssues: issues,
  };
  return { jobs, manifest, shards, indexContent };
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, file);
}

async function saveCatalog(catalog, out) {
  for (const shard of catalog.shards) await atomicWrite(path.join(out, shard.file), shard.content);
  await atomicWrite(path.join(out, 'index.json'), catalog.indexContent);
  // Publish the manifest last, so incomplete writes fail --check instead of looking complete.
  await atomicWrite(path.join(out, 'manifest.json'), `${JSON.stringify(catalog.manifest, null, 2)}\n`);
}

export async function checkCatalog(catalog, out) {
  const saved = await readJson(path.join(out, 'manifest.json'));
  assert(JSON.stringify(saved) === JSON.stringify(catalog.manifest), 'Saved manifest is stale or modified. Run the command without --check to rebuild.');
  const indexBytes = await fs.readFile(path.join(out, 'index.json'));
  assert(sha256(indexBytes) === saved.index.sha256 && indexBytes.length === saved.index.bytes, 'Index checksum mismatch.');
  const index = JSON.parse(indexBytes.toString('utf8'));
  const seen = new Set();
  let ready = 0, pending = 0;
  for (const shard of saved.shards) {
    const bytes = await fs.readFile(path.join(out, shard.file));
    assert(bytes.length === shard.bytes && sha256(bytes) === shard.sha256, `Job shard checksum mismatch: ${shard.file}.`);
    const jobs = JSON.parse(bytes.toString('utf8'));
    assert(jobs.length === shard.count, `Job shard count mismatch: ${shard.file}.`);
    for (const [position, job] of jobs.entries()) {
      assert(job.senseId === senseId(job) && !seen.has(job.senseId), `Duplicate or invalid sense ID: ${job.word}.`);
      assert(JSON.stringify(index[job.senseId]) === JSON.stringify([shard.file, position]), `Index mismatch: ${job.word}.`);
      assert(job.stageId === shard.stageId, `Wrong stage: ${job.word}.`);
      assert(job.status === 'ready' || job.status === 'pending', `Unexpected status: ${job.word}.`);
      if (job.status === 'ready') {
        const image = await inspectImage(path.join(ROOT, job.asset.savedPath));
        assert(image.sha256 === job.asset.sha256 && image.bytes === job.asset.bytes, `Saved image changed: ${job.word}.`);
        ready++;
      } else { assert(!job.asset, `Pending job has an accepted asset: ${job.word}.`); pending++; }
      seen.add(job.senseId);
    }
  }
  assert(seen.size === 100000 && Object.keys(index).length === 100000, 'Expected 100,000 indexed, unique jobs.');
  assert(ready === saved.ready && pending === saved.pending && ready + pending === 100000, 'Ready/pending counts do not reconcile.');
  return { total: seen.size, ready, pending, shards: saved.shards.length, metadataIssues: saved.metadataIssues.length };
}

export function nextJobs(jobs, count) {
  const themeOrder = new Map(LEVELS.flatMap(level => level.words).map((word, index) => [senseId(word), index]));
  return jobs.filter(job => job.status === 'pending').sort((a, b) => (themeOrder.get(a.senseId) ?? Infinity) - (themeOrder.get(b.senseId) ?? Infinity)).slice(0, count);
}

async function main() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'output/illustration-plan'), check = false, next;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--out') { assert(args[i + 1] && !args[i + 1].startsWith('--'), '--out needs a directory.'); out = path.resolve(args[++i]); }
    else if (args[i] === '--next') { next = Number(args[++i]); assert(Number.isInteger(next) && next > 0 && next <= 100000, '--next needs an integer from 1 to 100000.'); }
    else if (args[i] === '--help') {
      console.log('node scripts/illustration-catalog.mjs [--out DIR] [--check] [--next N]\nDefault: rebuild the local resumable plan. --check: verify existing plan against current sources and assets. --next N: rebuild and print N pending jobs as JSON (unless combined with --check). No image generation or network calls.');
      return;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  assert(!inside(path.join(ROOT, 'public'), out) && out !== path.join(ROOT, 'public'), 'The generation plan must stay outside public/ to avoid shipping 100,000 prompts.');
  assert(!inside(path.join(ROOT, 'src'), out) && out !== path.join(ROOT, 'src'), 'The generation plan must stay outside src/.');
  const catalog = await buildCatalog();
  if (!check) await saveCatalog(catalog, out);
  const result = await checkCatalog(catalog, out);
  const summary = { ...result, out, execution: 'plan only; image generation is not running' };
  if (next !== undefined) { console.error(JSON.stringify(summary)); console.log(JSON.stringify(nextJobs(catalog.jobs, next), null, 2)); }
  else console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Illustration catalog: ${error.message}`); process.exitCode = 1; });
}

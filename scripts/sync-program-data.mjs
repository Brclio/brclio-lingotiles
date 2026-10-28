#!/usr/bin/env node
/** Publish versioned vocabulary shards and illustration metadata to the private program-data repo. */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GitHubStore } from '../server/github-store.mjs';
import { LEVELS } from '../src/data/vocabulary.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--check', '--write'].includes(arg)) || (args.has('--check') && args.has('--write'))) throw Error('Usage: node scripts/sync-program-data.mjs [--check | --write]');
const hash = value => createHash('sha256').update(value).digest('hex');
const entries = [];
async function collect(directory, target) {
  for (const name of (await readdir(resolve(root, directory))).filter(name => name.endsWith('.json')).sort()) {
    const value = JSON.parse(await readFile(resolve(root, directory, name), 'utf8'));
    entries.push({ path: `${target}/${name}`, value, sha256: hash(JSON.stringify(value)), bytes: Buffer.byteLength(JSON.stringify(value)) });
  }
}
await collect('public/vocabulary', 'vocabulary');
await collect('public/images/words/index', 'illustrations/index');
const themes = { version: 1, levels: LEVELS };
entries.push({ path: 'curriculum/themes.json', value: themes, sha256: hash(JSON.stringify(themes)), bytes: Buffer.byteLength(JSON.stringify(themes)) });
const revision = hash(entries.map(entry => `${entry.path}:${entry.sha256}`).join('\n')).slice(0, 24);
const manifest = { schemaVersion: 1, revision, vocabularyTotal: entries.find(entry => entry.path === 'vocabulary/manifest.json')?.value.total, files: entries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`Program data: ${entries.length} JSON shards; ${(bytes / 1024 / 1024).toFixed(1)} MiB; revision ${revision}.`);
if (!args.size) {
  console.log('Dry run only. Use --write to publish; --check to verify the complete remote revision.');
  process.exit(0);
}
if (!process.env.GITHUB_APP_PRIVATE_KEY && !process.env.GITHUB_APP_PRIVATE_KEY_PATH) throw Error('Configure GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH before accessing the data repository.');
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') || await readFile(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
const store = new GitHubStore({
  appId: process.env.GITHUB_APP_ID || '5506935', clientId: process.env.GITHUB_APP_CLIENT_ID || 'Iv23liuSlQBY4hKFPGFD', privateKey,
  owner: process.env.GITHUB_DATA_OWNER || process.env.GITHUB_OWNER || 'BrclioData',
  repo: process.env.GITHUB_PROGRAM_REPO || process.env.GITHUB_DATA_REPO || 'Brclio-LingoTiles-Data', branch: process.env.GITHUB_DATA_BRANCH || process.env.GITHUB_BRANCH || 'main',
});
const prefix = `releases/${revision}`;
if (args.has('--check')) {
  const current = await store.get('catalog/current.json');
  if (current?.revision !== revision) throw Error('Remote program revision does not match the local vocabulary and illustrations.');
  await store.transaction(async tx => {
    const remote = await tx.get(`${prefix}/manifest.json`);
    if (JSON.stringify(remote) !== JSON.stringify(manifest)) throw Error('Remote program manifest does not match.');
    for (const entry of entries) {
      const value = await tx.get(`${prefix}/${entry.path}`);
      if (value === null || hash(JSON.stringify(value)) !== entry.sha256) throw Error(`Remote shard mismatch: ${entry.path}`);
    }
  });
  console.log('All remote shards and the publication pointer verified.');
} else {
  // Keep each Git tree request below GitHub's payload limit. The public pointer moves only last.
  let batch = [];
  let batchBytes = 0;
  let written = 0;
  const flush = async () => {
    if (!batch.length) return;
    const chunk = batch;
    await store.transaction(tx => {
      for (const entry of chunk) tx.set(`${prefix}/${entry.path}`, entry.value);
    }, { message: `Stage program data ${revision}` });
    written += chunk.length;
    console.log(`Staged ${written}/${entries.length} shards.`);
    batch = []; batchBytes = 0;
  };
  for (const entry of entries) {
    if (batch.length >= 25 || batchBytes + entry.bytes > 2_500_000) await flush();
    batch.push(entry); batchBytes += entry.bytes;
  }
  await flush();
  await store.transaction(tx => {
    tx.set(`${prefix}/manifest.json`, manifest);
    tx.set('catalog/current.json', { schemaVersion: 1, revision, manifestPath: `${prefix}/manifest.json`, publishedAt: new Date().toISOString() });
  }, { message: `Publish program data ${revision}` });
  console.log('Private program-data revision published. Run --check to verify all remote contents.');
}

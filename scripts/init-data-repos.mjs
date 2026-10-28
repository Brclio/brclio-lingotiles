import { loadConfig } from '../server/config.mjs';
import { GitHubStore } from '../server/github-store.mjs';

const config = loadConfig();
const checkOnly = process.argv.includes('--check');
const schemaPath = 'schema/version.json';
const repositories = [
  { repo: config.programRepo, kind: 'program', collections: ['vocabulary', 'curriculum', 'illustrations'] },
  { repo: config.repo, kind: 'users', collections: ['users', 'auth', 'sessions', 'rate-limits'] },
];
try {
  for (const { repo, kind, collections } of repositories) {
    const store = new GitHubStore({ ...config, repo });
    const metadata = await store.request(store.base);
    if (metadata.private !== true) throw new Error(`${config.owner}/${repo} 必须是私有仓库。`);
    let existing;
    try { existing = await store.request(`${store.base}/contents/${schemaPath}?ref=${encodeURIComponent(config.branch)}`); }
    catch (error) { if (![404, 409].includes(error.githubStatus)) throw error; }
    if (existing) {
      console.log(`${config.owner}/${repo}: private，schema 已存在。`);
      continue;
    }
    if (checkOnly) {
      console.log(`${config.owner}/${repo}: private，尚未初始化。请运行 npm run data:init。`);
      process.exitCode = 1;
      continue;
    }
    const schema = { version: 1, kind, collections, createdAt: new Date().toISOString() };
    await store.request(`${store.base}/contents/${schemaPath}`, {
      method: 'PUT',
      body: { message: `Initialize structured LingoTiles ${kind} storage`, branch: config.branch, content: Buffer.from(JSON.stringify(schema, null, 2) + '\n').toString('base64') },
    });
    console.log(`${config.owner}/${repo}: private，初始化完成。`);
  }
} catch (error) {
  console.error(error.message);
  console.error('请确认 App 已安装到 BrclioData，选中两个私有仓库，且 Contents 权限为读写。');
  console.error('安装地址：https://github.com/apps/brclio-lingotiles-app/installations/new');
  process.exitCode = 1;
}

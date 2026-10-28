import { readFileSync } from 'node:fs';
import { loadRuntimeConfig } from './config-core.mjs';

/** Node-only adapter: a local PEM path is never used by the Cloudflare runtime. */
export function loadConfig(env = process.env) {
  const privateKey = env.GITHUB_APP_PRIVATE_KEY || (env.GITHUB_APP_PRIVATE_KEY_PATH ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8') : '');
  return loadRuntimeConfig({ ...env, GITHUB_APP_PRIVATE_KEY: privateKey });
}

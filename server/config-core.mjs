/** Pure environment parsing shared by Node and Cloudflare. Secrets never enter VITE_. */
export function loadRuntimeConfig(env = {}) {
  const production = env.NODE_ENV === 'production';
  const configuredOrigin = env.APP_ORIGIN || (production ? '' : 'http://127.0.0.1:5173');
  let origin = '';
  if (configuredOrigin) {
    const url = new URL(configuredOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGIN 必须是完整的网站源地址（不含路径）。');
    if (production && url.protocol !== 'https:') throw new Error('生产环境 APP_ORIGIN 必须使用 HTTPS。');
    origin = url.origin;
  }
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replaceAll('\\n', '\n') || '';
  const sessionSecret = env.SESSION_SECRET || '';
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (googleConfigured && sessionSecret.length < 32) throw new Error('启用 Google 登录需要至少 32 字符的 SESSION_SECRET。');
  if (production && privateKey && !origin) throw new Error('生产环境账号服务需要配置 APP_ORIGIN。');
  return {
    production, origin, sessionSecret, privateKey,
    appId: env.GITHUB_APP_ID || '5506935',
    clientId: env.GITHUB_APP_CLIENT_ID || 'Iv23liuSlQBY4hKFPGFD',
    owner: env.GITHUB_DATA_OWNER || env.GITHUB_OWNER || 'BrclioData',
    repo: env.GITHUB_USER_REPO || 'Brclio-LingoTiles-UserData',
    programRepo: env.GITHUB_PROGRAM_REPO || env.GITHUB_DATA_REPO || 'Brclio-LingoTiles-Data',
    branch: env.GITHUB_DATA_BRANCH || 'main',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    googleEnabled: googleConfigured && Boolean(origin),
    storageConfigured: Boolean(privateKey),
    port: Number(env.PORT || 8787),
    trustProxy: env.TRUST_PROXY === 'true' || Boolean(env.VERCEL),
    serveStatic: env.SERVE_STATIC !== 'false',
  };
}

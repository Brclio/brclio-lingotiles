# 账号、云同步与部署

正式网站：https://lingo.brclio.com 。现有 Cloudflare Pages 项目为 `brclio-lingotiles`，生产分支为 `main`。前端由 Pages 分发，`functions/api/[[path]].js` 处理账号与学习接口，采用 Node.js 兼容模式。无需新数据库服务。

## 本地运行

Node.js 22.18+。复制 `.env.example` 为 `.env`，填写服务端配置，然后运行：

```sh
npm install
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`；Vite 将 `/api` 代理至 Node 的 8787 端口。`npm run dev:client` 仅启动前端；`npm run dev:server` 仅启动账号服务。`npm run build && npm start` 使用 Node 直接提供生产静态文件与 API。Node 生产服务须将 `APP_ORIGIN` 设为实际 HTTPS 来源并通过反向代理接入。

## Cloudflare Pages

`wrangler.toml` 保留现有项目名与正式来源。生产加密变量：

| 名称 | 值 |
| --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App PEM 私钥全文，保留换行 |
| `SESSION_SECRET` | 至少 32 字符的随机密钥，用于签署 OAuth 临时状态 |
| `GOOGLE_CLIENT_ID` | Google Web OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google Web OAuth Client Secret |

普通变量（仓库名、App ID、正式来源）位于 Wrangler 配置。不要把密钥放入 `vars` 或任何 `VITE_` 变量，不要上传本地 `.env` 或 PEM。Cloudflare 中不使用本机私钥文件路径。

```sh
npm test
npm run build
npx wrangler pages deploy dist --project-name brclio-lingotiles --branch main
```

Google 控制台：应用类型选 Web 应用，JavaScript 来源填写 `https://lingo.brclio.com`，重定向 URI 填写 `https://lingo.brclio.com/api/auth/google/callback`。权限只有 `openid email profile`。若 Google 项目仍处测试阶段，在 Google Auth Platform 的目标对象中添加测试用户；向所有用户开放须按 Google 控制台要求发布。更改凭据后重新部署 Pages。

## GitHub App 与仓库

App ID `5506935`，Client ID `Iv23liuSlQBY4hKFPGFD`。安装到 `BrclioData`，选择以下两个私有仓库并授予 Contents 读写权限：

- `Brclio-LingoTiles-Data`：课程、词库分片、配图索引与版本发布清单。
- `Brclio-LingoTiles-UserData`：身份、会话与按用户隔离的学习数据。

安装链接：https://github.com/apps/brclio-lingotiles-app/installations/new 。服务端以 App JWT 换取短期安装令牌，令牌按仓库限制并缓存至到期前。目标仓库变为公开时服务端拒绝访问。

```sh
npm run data:init        # 初始化缺失的 schema/version.json，也支持空仓库
npm run data:check       # 只读检查访问权限、私有性和初始化状态
npm run data:sync        # dry-run：统计程序分片，不写入
npm run data:sync -- --write
npm run data:sync -- --check
```

程序数据在 `releases/<内容哈希>/` 按原分片结构发布，最后原子更新 `catalog/current.json`。未完成的发布不会成为当前版本。校验检查全部分片的哈希与字节数。网站随包保留相同静态词库，游戏不依赖每次从 GitHub 下载词库。`GET /api/program/vocabulary/manifest.json` 等只读接口可读取清单内的已发布程序数据，使用 ETag 和版本缓存；没有暴露仓库令牌。

## 用户数据结构

目录和文件名由服务端生成，邮箱与第三方 subject 索引采用 SHA-256。每个实体独立 JSON，按哈希前两位分桶；不会将全部账号或学习记录写入单一文件。

```text
schema/version.json
auth/email/<邮箱哈希>.json
auth/google/<Google subject 哈希>.json
auth/oauth/<状态哈希>.json
sessions/<前两位>/<令牌哈希>.json
rate-limits/<键哈希>.json
users/<UUID>/
  profile.json
  credentials/password.json
  preferences/settings.json
  progress/summary.json
  words/<前两位>/<单词哈希>.json
  favorites/<前两位>/<单词哈希>.json
  levels/<前两位>/<关卡哈希>.json
  cards/<前两位>/<单词哈希>.json
  card-events/<单词哈希>/<本局ID哈希>.json
  history/YYYY/MM/<记录ID哈希>.json
  history-ids/<前两位>/<记录ID哈希>.json
```

收藏保留带时间戳的删除标记，避免其他设备的旧快照恢复已取消的收藏。历史按记录 ID 去重；每次重玩使用新的 ID。词卡在真实配对成功时收集，不依赖动画或是否通关，同一词同一局只累计一次。关卡星数、分数和最快用时分别保留最佳值。跨文件写入创建一个 Git 提交，更新引用时禁止强推；并发冲突重新读取并合并。

## 账号与同步行为

邮箱注册使用 10–128 字符密码，服务端只保存独立盐值的 scrypt 哈希。会话使用高熵随机令牌，仓库只保存令牌哈希及过期时间；生产 Cookie 为 HttpOnly、Secure、SameSite=Lax，退出时撤销。Google 登录验证 state、PKCE、nonce、签名、issuer、audience、过期时间及已验证邮箱；已有同邮箱账号不会未经验证自动关联。

每个账号拥有独立本地缓存和 IndexedDB 历史库。登录后不会自动上传游客数据；用户可在账号面板明确选择导入。退出后恢复游客数据，未完成的同步保留在对应账号的本地队列中；下次登录、恢复网络或点击“立即同步”会重试。队列分批上传，只有已确认批次才出队，较大历史不会被静默截断。待同步变更按账号保存为具有独立键的不可变事件，避免多个离线标签页相互覆盖。学习接口要求 `X-LingoTiles-Account` 与当前会话账号一致；其他标签页切换登录账号时，旧标签页停止上传并刷新账号状态。

当前未接入邮件发送服务，因此不提供邮箱所有权验证、找回密码或密码重置。账号数据由具有私有数据仓库权限的维护者可读；Git 提交历史也会保留旧版本。GitHub 存储受其 API 速率和仓库容量限制，Cloudflare 运行受实际套餐 CPU 与子请求额度限制；面向更大规模用户时应在保留结构化归档的同时增加专用查询存储与分页同步。

## 检查

```sh
npm test
npm run build
npm audit
```

测试覆盖认证、Google 防重放、跨账号隔离、并发注册、Git 原子提交冲突、取消收藏、词卡与历史幂等、离线队列、切换账号期间的旧响应、HTTP 来源与体积校验，以及 Node/Cloudflare 共享路由。

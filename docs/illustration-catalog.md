# 全词库配图任务目录

`scripts/illustration-catalog.mjs` 为游戏的 **100,000 个唯一单词**建立可重复生成、可续接的本地配图任务目录。它读取真实词库分片，并按照 `src/data/library.ts` 相同规则应用 `src/data/vocabulary.ts` 的 **54 个原主题词覆写**。例如 `tidy` 使用游戏里的 `adj. / 整洁的`，而不是原始字典的其他词性和释义。

**生成计划不等于已经生成图片。此脚本没有自动 imagegen / API worker，也不会发起网络请求。** 当前真实图片数量以输出清单的 `ready` 和实际资源为准，剩余均为 `pending`。它不会给缺图单词套上无关图片，也不会把一个图片文件复用于不同词义。

## 使用

要求使用支持 TypeScript 类型擦除的 Node.js（与项目现有 `node --test src/game/*.test.ts` 相同的运行方式）。在仓库根目录执行：

```sh
# 建立或刷新全量计划，自动识别新增的、已经审核的图片。
node scripts/illustration-catalog.mjs

# 只校验已保存计划；源词库、覆写、图片或审核状态变化后会提示先刷新。
node scripts/illustration-catalog.mjs --check

# 刷新计划，导出下一批未完成任务。诊断写 stderr，stdout 是可解析 JSON。
node scripts/illustration-catalog.mjs --next 12 > output/illustration-plan/next-12.json

# 可指定其他本地输出目录；不允许放进 public/ 或 src/。
node scripts/illustration-catalog.mjs --out output/illustration-plan-copy
```

`--next N` 先按原主题顺序补完缺图词，随后按小学、初中、高中、四级、六级、大学拓展以及原词库顺序返回任务。所有 `ready` 项目都会跳过；再次运行不会重新生成或修改图片，也不会清除已有图。它不会把任务标记为“生成中”，不充当多进程任务锁。

默认输出在已被 Git 忽略的 `output/illustration-plan/`，不参与网页首屏加载、应用 bundle 或 GitHub 推送：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 总数、已审核且文件存在数、待生成数、各阶段数量、源版本、校验和、元数据问题及分片清单 |
| `index.json` | 100,000 个词义 ID 到 `[任务分片路径, 分片内索引]` 的定位表 |
| `jobs/<stage>-<number>.json` | 每片最多 1,000 个独立生成任务，当前共 102 片 |

任务包含 `senseId`、精确 `word / pos / meaning`、`wordId`（游戏实际 ID）、`sourceId`（原字典 ID）、`stageId`、完整 `prompt`、`desiredAssetPath`、`status`。已完成任务另含 `asset`：实际路径、字节数、SHA256、imagegen 元数据位置、原始生成来源、审核标记和实际使用的提示词。已有图片可以继续使用原路径；`desiredAssetPath` 是新图片的确定性目标，不会强行移动旧图片。

词义 ID 是下面 UTF-8 字符串的完整 SHA256，与前端配图查询的词义规范化方式一致：

```js
JSON.stringify([
  word.trim().toLowerCase(),
  pos.trim().toLowerCase(),
  meaning.normalize('NFC').trim(),
])
```

任务中保留原始游戏显示文本。大小写或 Unicode 规范化不会改写玩家看到的释义。含义或词性真正改变后，会得到不同 ID，不会错误借用旧义项的图片。

## 一批图片的完成条件

1. 使用**内置 imagegen**逐词生成，每个独立资产使用独立调用。任务提示词是准确词义的起点；抽象词、功能词、专业词需要先确定可解释的具体场景，不能直接替换为装饰图。
2. 检视实际输出，确认词性、词义、画面内容及小尺寸可读性；未审核或不准确的结果不进入可用配图。
3. 将审核通过的成品等比缩小并编码为 WebP，保存到仓库 `public/images/words/` 内，可使用任务的 `desiredAssetPath`。原始生成源可以保留在本地，不要把全部原图复制进任务计划。
4. 在 `docs/imagegen/*.json` 添加来源记录，每条资产包含精确 `word / pos / meaning`、实际 `prompt`、生成结果 `source`、仓库相对 `savedPath` 和 **`reviewed: true`**。文件顶层声明 `mode: "built-in image_gen"`，或 `mode: "builtin", tool: "image_gen"`。
5. 运行 `npm run illustrations:sync` 生成前端 seed 与按需分片索引，验证记忆词卡、合成词卡、收获区与单词本能读取它，再运行 `npm run illustrations:plan` 和 `npm run illustrations:check`。单词本复用同一精确义项索引，按当前页加载；后续批次同步并发布后，刷新页面即可显示新增配图，无需在单词本中另行注册。

本地目录只有同时满足以下条件时才计为 `ready`：精确义项存在于实际游戏词库；有内置 imagegen 来源及实际提示词；明确 `reviewed: true`；目标文件真实存在于项目图片目录内；文件具有受支持图片格式的文件签名和有效字节。WebP 另校验 RIFF 声明长度。未保存、未审核、错误词义、重复冲突、越界路径或缺失来源都会保留为待完成，并记入 `metadataIssues`。

该校验不是图片语义识别模型，也不代替人工/代理对图片本身的视觉检查；`ready` 核对的是已记录的审核证据与文件一致性。前端是否完成注册需要项目测试另外验证。PNG/JPEG 签名检查不代替完整解码。

## 提示词规范与验证

全量提示词固定使用 `scientific-educational`：暖白纸面、手绘水粉与彩铅质感，明确主体居中、四周留白、柔和自然光，图片本身不出现文字、数字、标签、Logo 或卡片 UI。具体名词展示对象，动词展示动作，形容词展示可见性质；抽象词和功能词采用体现对应关系的具体中性场景。原主题例句会进入语义上下文，但不应绘制成文字。实际生成时采用的最终提示词应写入对应 imagegen 来源记录。

`--check` 会验证源词库每片的 SHA256、字节数、连续偏移、阶段数、100,000 个拼写/源 ID/词义 ID 的唯一性、54 个覆写全部命中，以及计划各分片、索引和图片字节的一致性。总数必须满足 `ready + pending = 100000`。清单不写运行时间，数据和已审核资产相同时可重复得到相同字节；新增审核资源后刷新即可续接。

脚本本身不调用生图或提供后台生成服务。用户已明确限定只使用内置 imagegen。Codex 中另有每小时续接本任务的跟进，分批领取未完成词义并执行生成、审核和内置；调度及工具是否可运行取决于 Codex 环境和可用额度。不能把清单条数描述成图片完成数。

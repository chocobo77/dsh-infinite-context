# dsh-infinite-context

DeepSeek Harness 的上下文管家插件。它让 AI 助手在超长对话中不"失忆"、不"爆窗"：旧对话自动整理成摘要并存档，重要的事情每轮主动提醒，需要细节时随时找回原文。

## English

[跳到英文说明](#english)

---

## 中文

### 它解决什么问题

和 AI 助手长期协作时，你会遇到两个问题：

1. **窗口装不下** —— 对话太长，超出模型一次能读取的上限，请求直接报错。
2. **压缩即失忆** —— 普通的压缩会把旧对话直接丢掉：做过什么决定、试过什么方案、有什么约束，全都没了。

本插件的思路是**压缩不等于删除**：旧对话被折叠成一份结构化摘要，原文完整存档、随时可取回；同时把"当前任务进行到哪了"主动放在模型眼前，不靠它自己想起来去查。

### 核心功能

**1. 智能折叠：像整理会议纪要**

对话接近上限时，较早的内容自动折叠成一份结构化摘要——总目标、关键决定、改过的文件、遇到的问题、待办事项，一目了然。

折叠的时机和深度不是死规则：

- 看阶段：模型正在连续调用工具时推迟，一段话说完的间隙才动手；
- 看内容：大量工具输出适合折深一些，重要指令则尽量保留原文；
- 会自我修正：每次折叠记录"实际结果与计划的偏差"，下次自动补偿；
- 有安全底线：模型正在思考或回答时**绝不**动手，两次折叠之间有最小间隔，避免反复折腾。

**2. 一切可恢复**

折叠前，原文完整存档，摘要开头给出一个取回编号（如 `fl_ab12cd34ef56`）。模型或你随时可以用 `memory_expand` 工具读回原文，支持分页和关键词定位；读不完会明确告知总长度和下一次怎么取。

超长的工具输出（一次大文件读取、一份长日志）同样先存档，再用一个带编号的短摘要占位——需要细节时一键展开。

**3. 记忆金字塔**

每次折叠的摘要存入本地数据库（重启不丢）。积攒多了，插件会自动把**主题相近**的几条合并成更高层的"长期记忆"；新对话或新问题时，最相关的历史记忆自动检索并注入给模型。

**4. 任务状态提醒（工作记忆）**

每次折叠后，插件从摘要中提取"总目标 / 待办 / 下一步 / 关键约束"，之后**每一轮**都主动放在模型眼前。

这解决一个真实痛点：记忆检索靠"相似度"，而五十轮之前的待办和当前问题往往并不相似——靠模型自己想起来去查，生产环境中一次也没发生过。主动提醒才是可靠的。

**5. 提前准备，而不是让你等**

快到折叠点时，插件会在后台提前把摘要写好；真正需要折叠时直接取用，现场零等待。如果后台准备会和你的对话抢同一个模型服务器的位置（本地小窗口部署时可能发生），它会自动让路——对话永远优先。

**6. 会自己学习的参数**

- 每个模型路线"摘要实际需要多久"，由插件持续测量并自动调整等待时间——本地部署的大模型慢但健康，等待会自动放宽；云端卡死的流不会浪费第二次机会。
- 每次折叠"实际落点与计划的偏差"持续记录，下一次自动补偿。
- 提供商报"装不下"时，记下服务器的真实容量，之后按真实容量规划，而不是按声明值硬撑。
- 你在配置里手工指定的值优先级最高，学习只在未指定时生效。

**7. 其他能力**

- 工具结果即时提炼：大段输出先提取关键行（错误、计数、文件路径），原文存档备用。
- 本地部署优化：自动识别 127.0.0.1 / 局域网上的模型，按探测到的真实窗口规划、注入精简指令、放宽等待。
- 中英文双语场景：摘要格式与关键信息提取都覆盖中文的错误、警告与超时行。

### 模型可用的工具

| 工具 | 作用 |
|---|---|
| `memory_search` | 搜索全部历史记忆 |
| `memory_expand` | 展开被折叠/存档的原文（支持分页、关键词） |
| `memory_status` | 查看记忆系统状态与用量统计 |
| `memory_index` | 浏览记忆索引 |
| `memory_maintain` | 记忆库体检：重复、冲突、低价值条目 |

### 配置

所有配置在 `cordis.yml`，每一项都有注释。最常用的：

| 配置 | 作用 | 默认 |
|---|---|---|
| `compaction_governance` | 统一折叠调度（建议保持开启） | `true` |
| `summarization_timeout_ms` | 单次摘要的等待上限（毫秒）；`0` = 不限制 | 自动：本地 240s / 云端 90s，随输入伸缩，并随实测学习 |
| `task_state_enabled` | 每轮注入任务状态提醒 | `true` |
| `speculative_fold` | 后台提前准备折叠摘要 | `true` |
| `tool_archive` | 超长工具结果存档 | `true` |
| `rag_top_k` 等检索项 | 每轮注入多少条相关记忆 | 见 `cordis.yml` |

完整清单与每项的详细说明见 `cordis.yml` 内注释。

### 安装

需要 Node.js ≥ 22.19.0 和 DSH 0.2.x。

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

安装后**重启 DSH** 生效。数据（记忆、存档、统计）存放在 DSH 数据目录的 `storages` 下，升级插件不会丢失。

### 兼容性说明

- 折叠通过 DSH 自带的 `compaction-basic` 完成，工具调用与结果的配对永远完整。
- 本地模型（127.0.0.1 / 内网地址）自动识别：按探测到的真实窗口规划、放宽摘要等待、注入精简指令。
- 默认的语义向量化是内置实现，零第三方依赖；需要更强的语义检索可自行安装 `@huggingface/transformers`。
- 本地模型只支持特定推理档位时，摘要调用沿用会话当前的档位设置。

### 许可

MIT

---

## English

### What problem does it solve

Long-running sessions with an AI assistant hit two walls:

1. **The window fills up** — the conversation outgrows what the model can read at once and requests start failing.
2. **Compaction means amnesia** — naive compaction throws old context away: decisions made, approaches tried, constraints stated — all gone.

This plugin's principle: **compaction is not deletion**. Old turns are folded into a structured summary while the original text is archived and retrievable on demand; and the current task state is actively placed in front of the model every turn instead of relying on it to remember.

### Core features

**1. Smart folding, like meeting minutes**

As the conversation nears its limit, older turns fold into a structured summary — goals, decisions, files changed, problems hit, pending work.

When and how deep to fold is not a fixed rule:

- It watches the phase: deferred while tools run in a loop, applied at turn boundaries;
- It watches the content: tool-heavy bulk folds deep, important instructions stay verbatim;
- It self-corrects: each fold records how far the result landed from the plan and compensates next time;
- It has hard safety rails: the model is **never** interrupted mid-generation, and a minimum interval prevents fold churn.

**2. Everything is recoverable**

Before folding, the original text is archived and the summary carries a reference (e.g. `fl_ab12cd34ef56`). The model — or you — can read the exact original back via the `memory_expand` tool, with paging and keyword search; truncated reads state the full length and the exact next call.

Oversized tool outputs (a big file read, a long log) are archived the same way and replaced by a short stub that carries the reference.

**3. The memory pyramid**

Every fold summary is persisted locally (survives restarts). As they accumulate, topically-similar summaries are consolidated into higher-level long-term memories; the most relevant ones are retrieved and injected for new questions automatically.

**4. Task-state reminders (working memory)**

After each fold the plugin extracts "goal / pending / next step / key constraints" from the summary and places it in front of the model **every single turn**.

This fixes a real gap: memory retrieval works by similarity, and a fifty-turn-old pending job is rarely similar to the current question — in production the model never once searched on its own. Pushing beats hoping.

**5. Prepared in advance, instead of making you wait**

As the surface approaches the fold trigger, the summary is precomputed in the BACKGROUND; the actual fold consumes it with zero waiting. If the background call would contend with your conversation for the same local server (possible on small local deployments), it stands down — the conversation always wins.

**6. Parameters that learn**

- How long a summary takes per model route is measured continuously and the wait adjusts itself — a big locally-deployed model is slow but alive, so waits widen; a dead cloud stream does not get a second patient chance.
- How far each fold actually landed from its plan is tracked and compensated.
- When a provider rejects a request for size, the server's real capacity is recorded and future folds plan against reality, not the declared number.
- Values you set explicitly always win; learning only applies where you did not.

**7. Also included**

- Immediate distillation of tool results: signal lines (errors, counts, paths) extracted, full text archived.
- Local-deployment optimizations: automatic discovery of 127.0.0.1 / LAN models, planning against probed real windows, concise-mode directives.
- Bilingual (Chinese/English) summaries and signal extraction, including Chinese error and warning lines.

### Tools available to the model

| Tool | Purpose |
|---|---|
| `memory_search` | Search all stored memories |
| `memory_expand` | Expand folded/archived original text (paging, keyword) |
| `memory_status` | Memory system status and usage statistics |
| `memory_index` | Browse the memory index |
| `memory_maintain` | Health check: duplicates, conflicts, stale entries |

### Configuration

Everything lives in `cordis.yml` with a comment on every key. The common ones:

| Key | Purpose | Default |
|---|---|---|
| `compaction_governance` | Unified fold scheduling (keep on) | `true` |
| `summarization_timeout_ms` | Per-attempt summary deadline (ms); `0` = unlimited | auto: local 240s / cloud 90s, scaled by input, refined by learning |
| `task_state_enabled` | Per-turn task-state reminder | `true` |
| `speculative_fold` | Background precomputation of fold summaries | `true` |
| `tool_archive` | Archive oversized tool results | `true` |
| `rag_top_k` etc. | How many memories to inject per turn | see `cordis.yml` |

The full list with per-key explanations is in the comments of `cordis.yml`.

### Install

Requires Node.js ≥ 22.19.0 and DSH 0.2.x.

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

**Restart DSH** after installing. Data (memories, archives, statistics) lives under the DSH data directory's `storages` folder and survives upgrades.

### Compatibility

- Folding runs through DSH's built-in `compaction-basic`; tool call/result pairing is always preserved.
- Local models (127.0.0.1 / private LAN) are detected automatically: planning against probed real windows, wider summary deadlines, concise-mode directives.
- The default embedder is built in with zero third-party dependencies; install `@huggingface/transformers` yourself for stronger semantic retrieval.
- When a local model only accepts specific reasoning levels, summary calls follow the session's current setting.

### License

MIT

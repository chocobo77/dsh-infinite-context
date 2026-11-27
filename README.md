# dsh-infinite-context

DeepSeek Harness 的上下文治理插件：长会话不爆窗、不丢事，折掉的每一句都能找回来。

一台本地小模型带着这个插件连续工作 **31 小时**、吞吐 **1.04 亿 token**，插件自动折叠了 **19 次**——每一次都有存档可回读，最后一次落库前没有丢过任何一份摘要。下面的数字全部来自这次运行的本地账本，装上插件你也能查到同样的一套。

该组数字来自单次生产运行的本地账本，仓库内没有对应的产物可供直接核对；`bench-results/` 是另一项摘要保真对照实验，不是这组数字的来源。

| 实测（单次生产长会话，本地部署的量化模型） | |
|---|---|
| 连续工作时长 | 31 小时，656 次请求，无人值守过夜 |
| 吞吐 | 1.04 亿 token（缓存读 0.99 亿 + 输入 365 万 + 输出 51 万） |
| 自动折叠 | 19 次，**19 份原文存档、19 份检查点记忆，一一对齐，零丢失** |
| 折叠净节省 | 511,890 token |
| 折叠后缓存命中率 | 92%–100%（折叠一次缓存前缀全部重建，重建成本已单独计量为 dip= 指标） |
| 摘要保真 | 折叠区关键锚点缺失 **1.1%**；无核对的降级摘要缺 **71.2%**（同一批内容对照回放） |
| 折叠节奏 | 16 分钟到 3.4 小时自适应，由插件自己学出来 |
| 运行时依赖 | 零第三方包（SQLite、zstd 用 Node 内建） |

直接装：

```sh
dsh plugin --profile <profile> add https://github.com/chocobo77/dsh-infinite-context/releases/latest/download/dsh-infinite-context.tgz
```

## English

[跳到英文说明](#english)

---

## 中文

### 它解决什么问题

和 AI 助手长期协作，你会撞上两面墙：

1. **窗口装不下** —— 对话超出模型一次能读的上限，请求直接报错。
2. **压缩即失忆** —— 常见的压缩把旧对话直接丢掉：做过什么决定、试过什么方案、有什么约束，全都没了。

本插件的原则是**压缩不等于删除**：旧对话折叠成结构化摘要，原文完整存档、随时取回；"当前任务进行到哪了"由插件主动放到模型眼前，不指望它自己想起来查。

### 和普通方案差在哪

| 方案 | 长会话会发生什么 |
|---|---|
| 什么都不装 | 窗口满了报错；手动开新会话，上下文从零开始 |
| 普通压缩 | 旧对话被摘要替换、原文丢弃——决定、约束、踩过的坑全部蒸发，模型在幻觉里继续干活 |
| 纯 RAG 检索 | 靠"相似度"想起旧事：五十轮前的待办和当前问题不相似，生产实测模型自发检索 **0 次** |
| **本插件** | 折叠 + 原文存档 + 每轮任务提醒 + 机械保真核对（锚点缺失 1.1% vs 无核对 71.2%），节奏自学习、深度由 AI 判断（可一路放到结构底） |

### 六个机制

**1. 折叠成纪要，原文永不删**

接近上限时，较早的对话折叠成一份结构化摘要——总目标、关键决定、改过的文件、踩过的坑、待办。折叠前原文完整存档，摘要开头给出取回编号（如 `fl_ab12cd34ef56`），模型或你随时用 `memory_expand` 读回，支持分页和关键词定位，读不完会告知总长度和下一次从哪取。用户贴过的截图和文件同样登记引用，折叠不丢。

超长工具输出（大文件读取、长日志）先存档再占位；已经离开工作焦点的旧工具结果也有保质期——折叠时收缩成要点（错误行、计数、路径），全文仍在存档里。

**2. 摘要保真，不靠模型自觉**

摘要落地后，插件机械核对：折叠区里的文件路径、存档编号、报错原文，凡摘要漏掉的原样补回一节"折叠证据"。同一批内容做过对照回放——带核对的摘要关键锚点缺失 1.1%，不带核对的降级摘要缺 71.2%，差 65 倍。

区域太长时拆成小段分别摘要，再按章节机械合并——小模型摘要小段落更可靠，合并绝不发明内容。

**3. 该折才折，折多深也由 AI 定**

折叠的时机和深度都不是死规则：模型连续调用工具时推迟，一段话说完的间隙才动手。**折叠深度完全由 AI 的两个判断决定**——"现在是不是干净接缝"（回合结束/里程碑）与"这段内容有多可弃"，两者取强者连续选线：从保守的 55% 水位一路放到结构底（保留尾 + 摘要 + 系统头），中间没有任何人工地板。接缝处回合节奏与学习节奏双双让路，turn-end 的折叠机会不会被间隔挡掉；每次折叠记录"实际落点与计划的偏差"，下次自动补偿；折出的内容若被频繁回读，自学习会自动收窄下一轮深度。模型正在思考或回答时**绝不**动手。

**4. 任务状态主动提醒（变化必达 + 周期再锚定）**

每次折叠后提取"总目标 / 待办 / 下一步 / 关键约束"，在**下一次模型请求前**放回模型眼前；内容未变的轮次不再重复灌同一段文本，每 6 轮再锚定一次。这解决一个实测痛点：记忆检索靠相似度，五十轮之前的待办和当前问题往往不相似——生产环境里模型自己想起来去查，一次都没发生过。主动提醒才是可靠的，逐轮复述同一段话不是。

**5. 后台提前写好，现场零等待**

按会话增长速度和摘要耗时做预测，在合适的时机提前于后台把摘要写好，真正要折叠时直接取用。生产中投机命中时折叠提交零等待。增长停滞不空跑；后台调用会和对话抢同一台本地服务器时自动让路——对话永远优先。

**6. 参数自己学**

- 每条模型路线"摘要实际要多久"持续测量、自动调整等待——本地大模型慢但健康就放宽，云端卡死的流不给第二次耐心。
- 折叠触发点与幅度来自对实际周期的观察：两次折叠间的余量、缓存命中起伏、摘要被回读的频率都影响下一次判断。一次真实长会话里，触发系数从 1.05 一路学到 2.50（增长快就拉开折叠间隔）。**折叠深度不在学习范围里——它由意图档位直接决定**（见机制 3）：接缝越干净、内容越可弃，放水越深，直到结构底。
- 提供商报"装不下"时记下服务器真实容量，之后按真实容量规划，不按声明值硬撑。
- 你在配置里指定的值优先级最高，学习只在未指定时生效。但折叠**节奏**的自学习会被锚点钉扎：配置里写了 `compress_trigger_ratio` 或 `compress_target_ratio` 任意一行，就被当作手工钉扎，节奏自学习随之停用。出厂 `cordis.yml` 恰好写了这两行，所以默认安装的这一项其实是关的；要自学习就得删掉这两行——单独写 `fold_learning: true` 解不开钉扎，钉扎优先。

**之外还有**：折叠触发点与摘要历史的语义比对（模型从不主动回读摘要时，召回信号照常积累）；Agent 空闲时自动整理记忆库、把被取代的检查点合并成长期记忆；模型可以主动往记忆里写事实（每会话 20 条上限，防滥用）；一轮回复只产出思考、没有任何可见结果时自动补一步，不静默丢单。

### 模型可用的工具

12 个，全部随插件注册：

| 工具 | 作用 |
|---|---|
| `memory_search` | 语义检索全部历史记忆 |
| `memory_expand` | 读回折叠/存档原文（分页、关键词定位、附件清单） |
| `memory_write` | 主动沉淀一条事实（每会话 20 条上限） |
| `memory_status` | 记忆系统状态 + 用量统计 |
| `memory_forget` | 跑一轮遗忘清理（零产出连续两次即拒绝再调） |
| `memory_consolidate` / `memory_maintain` / `memory_index` | 合并、体检、浏览索引 |
| `memory_ingest` | 手动把工具结果收进记忆 |
| `memory_model_probe` / `memory_force_compress` / `memory_reset` | 模型窗口探测 / 立即折叠（会话空闲时自动排队到下一步执行）/ 重置（需确认） |

### 数字从哪来

上面首屏的数字读自插件自己的 SQLite 账本（`fold_cycle`、`compaction_saved_tokens`、`folded_ranges`、`expand_restore` 等逐次记录），装上后用 `memory_status` 或直接查库即可复核。摘要保真的对照回放用的是同一台本地模型：10 段真实会话内容分别走"折叠管线摘要 / 无核对的降级摘要 / 原文截断"三条路，数关键锚点的缺失比例。该对照的评分由同一台模型自己判（self-judging，`bench-results/9df5ae49-…/report.md` 第 3 行已标注 `judge on (self-judging bias)`），两个百分比应当作同一批内容下的相对差距来读，不是绝对错误率。

### 配置

所有配置在 `cordis.yml`，每项都有注释。最常用的：

| 配置 | 作用 | 默认 |
|---|---|---|
| `compaction_governance` | **已废弃（no-op since 0.8.6）**：车道接管是无条件的，写了这个键不生效，也没有可退回的旧按 lane 模式 | `true`（出厂 cordis.yml 仍带，纯兼容占位） |
| `fold_learning` | 折叠节奏自学习（触发时机与幅度随实测周期调）。**配置里写了 `compress_trigger_ratio` 或 `compress_target_ratio` 任意一行即视为手工钉扎，自学习自动关闭** | `true`，但出厂 cordis.yml 写了那两个 ratio，所以默认安装下实际是关的 |
| `fold_seam_floor` | AI 定深线的下限：0 = 深度完全交给 AI（选线可到结构底）；设正值即人工压浅 | `0` |
| `fold_seam_min_timing` | 接缝门：intent timing 高于此值即视为干净接缝（免两道节奏，turn-end 穿越不再丢失） | `0.7` |
| `rag_staleness_half_life_days` | 注入得分陈旧度半衰期（天）：short 档记忆按此衰减、mid 2×、long 不衰减，0 关闭。配套收紧：注入预算 2000、minScore 0.35、topK 2，单条 ≤40% 预算（超长截断并给 memory_expand 指针），检查点类记忆不再逐轮注入 | `14` |
| `summarization_timeout_ms` | 单次摘要等待上限（毫秒）；`0` = 不限制 | 自动：本地 240s / 云端 90s，随输入伸缩，随实测学习 |
| `task_state_enabled` | 每轮注入任务状态提醒 | `true` |
| `speculative_fold` | 后台提前准备折叠摘要 | `true` |
| `fold_evidence_check` | 折叠后锚点核对与补挂 | `true` |
| `fold_implicit_recall` | 折叠摘要语义比对，召回信号自动积累 | `true` |
| `sleep_consolidate` | Agent 空闲时整理记忆库 | `true` |
| `degenerate_retry` | 空产出 turn 自动补一步 | `true` |
| `tool_archive` | 超长工具结果存档 | `true` |

完整清单与逐项说明见 `cordis.yml` 内注释。

### 安装

需要 Node.js ≥ 22.19.0 和 DSH 0.2.x。

一条命令，直接装最新发布版：

```sh
dsh plugin --profile <profile> add https://github.com/chocobo77/dsh-infinite-context/releases/latest/download/dsh-infinite-context.tgz
```

从源码打包安装（本地开发）：

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

安装后**重启 DSH** 生效。数据（记忆、存档、统计）存放在 DSH 数据目录的 `storages` 下，升级插件不会丢失。

### 兼容性说明

- 折叠通过 DSH 自带的 `compaction-basic` 完成，工具调用与结果的配对永远完整。
- 本地模型（127.0.0.1 / 内网地址）自动识别：按探测到的真实窗口规划、放宽摘要等待、注入精简指令。
- 默认语义向量化内置，零第三方依赖；要更强的语义检索可自行安装 `@huggingface/transformers`。
- 本地模型只支持特定推理档位时，摘要调用沿用会话当前档位——插件不会替会话挑档位。
- 网关拒绝 `thinking` 参数时（例如用 OpenAI 兼容地址转 Anthropic 版式的网关会要求 `thinking.budget_tokens`，报 `missing field "budget_tokens"`），该路线后续的摘要调用改请求"关闭思考"，折叠照旧落地；日志会给出路线侧的根治配置——`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `id: llm-pi-ai` → `providers.<路线>.models[].compat.thinkingFormat`（或 `reasoningEfforts: false`），或把路线留在 off 档位。

### 许可

MIT

---

## English

### What problem does it solve

Long-running sessions with an AI assistant hit two walls:

1. **The window fills up** — the conversation outgrows what the model can read at once and requests start failing.
2. **Compaction means amnesia** — naive compaction throws old context away: decisions made, approaches tried, constraints stated — all gone.

This plugin's principle: **compaction is not deletion**. Old turns fold into a structured summary while the original text is archived and retrievable on demand; and the current task state is placed in front of the model every turn instead of relying on it to remember.

### How it compares

| Approach | What happens to a long session |
|---|---|
| Nothing installed | The window fills up and requests fail; starting a new session restarts from zero |
| Naive compaction | Old turns are replaced by a summary and discarded — decisions, constraints, pitfalls evaporate while the model keeps working on guesses |
| Pure RAG retrieval | Recall depends on similarity: a fifty-turn-old pending job is rarely similar to the current question — production measured **0** spontaneous retrievals |
| **This plugin** | Folds + archived originals + per-turn task reminders + mechanical fidelity audit (1.1% vs 71.2% anchor loss), with self-learned rhythm and an AI-judged fold depth (down to the structural floor) |

### Measured, not claimed

One locally-deployed quantized model ran **31 hours** with this plugin, through **104 million tokens** (99.84M cache reads + 3.65M input + 0.51M output), folding automatically **19 times** — 19 archives, 19 checkpoint memories, nothing lost. All numbers below come from that run's local ledger:

These figures are from a single production run's local ledger; the repository holds no artifact to check them against directly. `bench-results/` is a separate summary-fidelity experiment, not the source of this set.

| Measured (single production session) | |
|---|---|
| Session | 31 hours, 656 requests, unattended overnight |
| Throughput | 104M tokens |
| Folds | 19, **19 archives + 19 checkpoints, aligned, zero loss** |
| Net savings | 511,890 tokens |
| Cache hit after folds | 92%–100% |
| Summary fidelity | **1.1%** key anchors missing vs **71.2%** for unchecked fallback summaries (same content, controlled replay) |
| Fold rhythm | 16 min – 3.4 h, learned by the plugin itself |
| Runtime deps | zero third-party packages (Node built-in SQLite, zstd) |

### How it works

**1. Fold into minutes, never delete the original**

Older turns fold into a structured summary (goals, decisions, files, problems, pending). The original is archived first; the summary carries a reference (`fl_ab12cd34ef56`), and `memory_expand` reads it back with paging and keyword search, always stating where the next page starts. Images and files the user posted are registered as attachment references — folds don't lose them.

Oversized tool outputs are archived and stubbed; results that leave the working set age into signal stubs (errors, counts, paths), full text still archived.

**2. Fidelity that doesn't depend on the model's diligence**

After a summary lands, the plugin mechanically audits it: file paths, archive references, error lines from the folded region that the summary dropped are re-attached verbatim under a "Folded Evidence" heading. Controlled replay on the same content: 1.1% anchors missing with the audit vs 71.2% without — a 65× gap. Oversized regions are summarized segment by segment and merged mechanically — small models summarize small spans reliably, and the merge invents nothing.

**3. Fold only when it should — and let the AI decide how deep**

Phase-aware (deferred during tool loops, applied at turn boundaries) and self-correcting (each fold records the landing deviation and compensates). **The fold DEPTH is AI-owned**: the stronger of two judgments — "is this a clean seam" (turn end / milestone) and "how disposable is this content" — picks the target line continuously, from the conservative 55% anchor all the way down to the structural floor (retained tail + summary + pinned head); there is no manual plate in between. Both pacing gates yield at a seam, so a turn-end crossing is never lost, and summaries that keep getting read back automatically narrow the next fold. The model is **never** interrupted mid-generation.

**4. Task state, re-anchored on change**

After each fold the plugin extracts goal / pending / next step / constraints and puts them in front of the model **before the next model request**; turns where nothing changed no longer re-send the identical text — a re-anchor runs every 6 turns instead. Retrieval works by similarity, and a fifty-turn-old pending job is rarely similar to the current question — in production the model never once searched on its own. Pushing beats hoping; repeating the same paragraph every turn does not.

**5. Prepared in the background, zero waiting at fold time**

The plugin predicts the launch moment from growth speed and summary duration and precomputes the summary; the fold consumes it with zero waiting (production-verified). Idle sessions don't speculate, and a background call contending with your conversation for the same local server stands down — the conversation wins.

**6. Parameters that learn**

Per-route summary latency is measured continuously and waits adjust themselves; the fold trigger and amplitude come from observed cycles (one real session's trigger coefficient learned from 1.05 to 2.50); real server capacity is recorded when a provider rejects a request for size. **Fold DEPTH is outside the learning loop — the intent dial decides it directly** (see #3): the cleaner the seam and the more disposable the content, the deeper the drain, down to the structural floor. Values you set explicitly always win — and for fold **tempo**, writing either `compress_trigger_ratio` or `compress_target_ratio` counts as manually pinning the anchor, which stands the self-learning down. The shipped `cordis.yml` writes both lines, so on a default install this learning is off; delete those two lines to get it — `fold_learning: true` on its own does not unpin it, the pin wins.

**Also included**: semantic matching between new input and fold summaries (recall signal accumulates even when the model never reads back); idle-time memory consolidation; agent-curated memory writes (20/session cap); an invisible retry when a turn ends with zero visible output.

### Tools available to the model

12, all registered with the plugin:

| Tool | Purpose |
|---|---|
| `memory_search` | Semantic search across all memories |
| `memory_expand` | Read back folded/archived originals (paging, keyword, attachments) |
| `memory_write` | Let the agent persist a fact (20/session cap) |
| `memory_status` | System status and usage statistics |
| `memory_forget` | Run a forgetting sweep (refuses after two zero-drop runs) |
| `memory_consolidate` / `memory_maintain` / `memory_index` | Consolidate, health-check, browse |
| `memory_ingest` | Manually ingest a tool result |
| `memory_model_probe` / `memory_force_compress` / `memory_reset` | Window probe / fold now (queues to the next step when the session is idle) / reset (guarded) |

### Where the numbers come from

The headline numbers are read from the plugin's own SQLite ledger (`fold_cycle`, `compaction_saved_tokens`, `folded_ranges`, `expand_restore`, one row per event) — install it and verify with `memory_status` or by querying the store. The fidelity replay ran the same local model over 10 segments of real session content through three lanes (the fold pipeline, unchecked fallback, raw truncation) and counted missing key anchors. That replay is scored by the same model being measured (self-judging — the report header at `bench-results/9df5ae49-…/report.md` flags `judge on (self-judging bias)`), so the two percentages are a relative gap on identical content, not absolute error rates.

### Configuration

Everything lives in `cordis.yml` with a comment on every key. The common ones:

| Key | Purpose | Default |
|---|---|---|
| `compaction_governance` | **Deprecated (no-op since 0.8.6)**: the fold lane's takeover of routine compaction is unconditional, the key does nothing and there is no legacy per-lane mode to go back to | `true` (still in the shipped cordis.yml, kept for compatibility only) |
| `fold_learning` | Self-learned fold tempo (trigger timing and amplitude follow observed cycles). **Writing either `compress_trigger_ratio` or `compress_target_ratio` pins the anchor by hand and stands this learning down** | `true`, but the shipped cordis.yml writes both ratios, so on a default install it is effectively off |
| `fold_seam_floor` | Lower bound of the AI-chosen fold line: 0 = depth fully AI-decided (the line may reach the structural floor); a positive value forces a shallower line | `0` |
| `fold_seam_min_timing` | Seam gate: intent timing above which a step counts as a clean seam (both pacings yield there, so turn-end crossings are never lost) | `0.7` |
| `rag_staleness_half_life_days` | Injection staleness half-life in days: short-tier memory scores halve per half-life, mid at 2×, long never; 0 disables. Paired tightening: injection budget 2000, minScore 0.35, topK 2, one memory ≤40% of budget (longer ones clip with a memory_expand pointer), checkpoints excluded from per-turn injection | `14` |
| `summarization_timeout_ms` | Per-attempt summary deadline (ms); `0` = unlimited | auto: local 240s / cloud 90s, scaled by input, refined by learning |
| `task_state_enabled` | Per-turn task-state reminder | `true` |
| `speculative_fold` | Background precomputation of fold summaries | `true` |
| `fold_evidence_check` | Post-fold anchor audit and re-attachment | `true` |
| `fold_implicit_recall` | Semantic match against fold summaries, recall signal accumulates | `true` |
| `sleep_consolidate` | Idle-time memory consolidation | `true` |
| `degenerate_retry` | One corrective step for empty-output turns | `true` |
| `tool_archive` | Archive oversized tool results | `true` |

The full list with per-key explanations is in the comments of `cordis.yml`.

### Install

Requires Node.js ≥ 22.19.0 and DSH 0.2.x.

One command, straight from the latest release:

```sh
dsh plugin --profile <profile> add https://github.com/chocobo77/dsh-infinite-context/releases/latest/download/dsh-infinite-context.tgz
```

Or pack from source (local development):

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

**Restart DSH** after installing. Data (memories, archives, statistics) lives under the DSH data directory's `storages` folder and survives upgrades.

### Compatibility

- Folding runs through DSH's built-in `compaction-basic`; tool call/result pairing is always preserved.
- Local models (127.0.0.1 / private LAN) are detected automatically: planning against probed real windows, wider summary deadlines, concise-mode directives.
- The default embedder is built in with zero third-party dependencies; install `@huggingface/transformers` yourself for stronger semantic retrieval.
- When a local model only accepts specific reasoning levels, summary calls follow the session's current setting — the plugin never picks a level the session did not choose.
- If a gateway rejects the `thinking` body field (an Anthropic-schema gateway behind an OpenAI-compatible URL demands `thinking.budget_tokens` and answers `missing field "budget_tokens"`), later summarizations on that route request reasoning off, folds still land, and the log names the route-side fix: in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` under `id: llm-pi-ai` → `providers.<route>.models[].compat.thinkingFormat` (or `reasoningEfforts: false`), or keep the route at its off level.

### License

MIT

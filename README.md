# dsh-infinite-context

[🇨🇳 中文](#简介) | [🇬🇧 English](#introduction)

---

## 简介

一个 DeepSeek Harness (DSH) 插件，通过**多层记忆管理**让长对话拥有「无限上下文」体验：

- **渐进式压缩** — token 压力驱动，最老消息优先摘要，近期对话原样保留
- **动态压缩阈值** — 按路由模型的**真实** CTX 推导触发水位；单轮超长 think 造成的一次性增长可越过轮次间隔立即介入
- **深度思考介入** — 包装 agent 的 LLM 流：`input + output` 逼近当前模型真实窗口时注入溢出信号 → 持久压缩 → 带余量重试，**模型思考中也能被介入**
- **三层记忆金字塔** — short（近期原文）→ mid（LLM 摘要）→ long（合并摘要）
- **持久化存储** — SQLite（`node:sqlite`），重启不丢记忆
- **语义检索** — 记忆嵌入、索引，每轮注入最相关的 top-K 记忆
- **三层去重** — 精确 + 归一化模糊 + 语义余弦，防止重复入库
- **结构化记忆** — 四分类（user/feedback/project/reference）+ 索引 + 审计 + 忘得可见
- **模型上下文感知** — 自动采纳 DSH 解析的真实模型 CTX，本地小模型提前压缩
- **高价值过滤** — 只入库高价值工具结果，低价值工具自动过滤
- **手动工具** — 10 个：search / status / index / maintain / model_probe / forget / consolidate / reset / force_compress / ingest

### 核心特性

| 特性 | 说明 |
|------|------|
| 渐进式压缩 | `compress_trigger_ratio: 0.85` — 上下文 >85% 才压缩；`compress_target_ratio: 0.6` — 只摘要溢出部分 |
| 动态压缩阈值 | `compaction_dynamic_threshold: true` — 真实窗口 < 声明窗口时按真实窗口强制压缩（探测/modelWindows 驱动）；`compaction_dynamic_floor: 0.6` — 触发比例随窗口填充从 0.8 滑向 0.6（~70% 触发，预留 ~30% 给摘要 pass）；单轮激增（≥20% 窗口）越过轮次间隔；同一会话两次强制压缩间隔 ≥10s |
| 深度思考介入 | `thinking_guard_enabled: true` — 包装 `llm/stream`：`input + output` 逼近 `窗口 − (system/tools + 摘要估算 + 余量)` 动态线时注入 `CONTEXT_WINDOW_EXCEEDED` → 持久压缩 → 重试；输入单独超线则生成前先压缩；`thinking_guard_ratio: 0.9` 为触发上限 |
| 三层去重 | 精确（hasText）+ 归一化（normalizeForDedup）+ 语义（cosine ≥ 0.92） |
| 结构化记忆 | `memory_index`（MEMORY.md 索引）+ `memory_maintain`（审计）+ 忘得可见 |
| 模型 CTX 感知 | 自动读取 DSH 模型目录的 contextWindow；本地模型主动探测真实运行窗口（llama/ollama/openai，含 llama-server `meta.n_ctx`）；per-model 注册表按模型隔离 |
| 高价值过滤 | denylist 过滤 23 个低价值工具；importance 分级（short=0.3/mid=0.6/long=0.6，long 继承批次 max） |

### 架构

```
src/
├── types.ts              核心类型（无依赖）
├── embedder.ts           轻量级特征哈希嵌入器（无依赖）
├── vector-index.ts       内存向量索引（无依赖）
├── memory-store.ts       SQLite 持久化存储（无依赖）
├── token-budget.ts       CJK-aware token 估算 + 内容块计量（无依赖）
├── forgetting.ts         遗忘策略（无依赖）
├── memory-engine.ts      记忆引擎核心（无依赖）
├── model-context.ts      模型上下文跟踪器：探测时机 + per-model 注册表（无依赖）
├── model-probe.ts        主动探测：llama/ollama/openai + 本地/在线判定（无依赖）
├── compaction-policy.ts  压缩触发决策：动态比例、skip/force/delegate（无依赖）
├── summarization-target.ts 摘要目标路由（跟随会话模型，无依赖）
├── config.ts             schemastery 配置解析
├── memory-context.ts     Cordis 服务（动态 CTX 感知 + 探测接线）
├── memory-compaction.ts  压缩引擎（渐进式 + RAG + 清理 + thinking guard 接线）
├── thinking-guard.ts     深度思考介入：llm/stream 包装 + 动态触发线
├── OutputSanitizer.ts    工具结果清理
├── VectorRetriever.ts    RAG 检索/入库
├── strings.ts            共享字符串工具
├── core.ts               公共导出桶
├── index.ts              完整导出桶
└── tools.ts              10 个手动工具
tests/                    133 个单元测试
```

### 手动工具

| 工具 | 说明 |
|------|------|
| `memory_search(query?, k?)` | 语义检索持久化记忆 |
| `memory_status` | 报告分层计数、预算、嵌入器、遗忘策略、模型 CTX |
| `memory_index(limit?)` | MEMORY.md 风格结构化索引 |
| `memory_maintain` | 只读审计：重复/冲突/过时 |
| `memory_model_probe(forceProbe?, model?)` | 报告模型 CTX 来源，可强制探测 |
| `memory_forget` | 执行遗忘扫描 |
| `memory_consolidate` | 强制金字塔合并 |
| `memory_reset` | 清空所有记忆 |
| `memory_force_compress(sessionId?)` | 强制压缩指定会话 |
| `memory_ingest(text, source)` | 手动入库一条文本（自动触发见 `tools/result` 回调） |

### 配置参考

#### `memory-context` 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `storePath` | `dsh-infinite-context.db` | SQLite 路径；`:memory:` 禁用持久化 |
| `contextWindow` | `94000` | 模型上下文窗口（**回退值**；插件自动采纳 DSH 解析的真实窗口，并会以实时探测结果为上限） |
| `headroomRatio` | `0.25` | 系统/工具/输入/输出预留比例 |
| `modelWindows` | `[]` | 逐模型显式窗口表（`[{model, contextWindow}]`）——声名值缺失或虚高/虚低时的**权威真值**；探测结果仍可进一步收窄 |
| `modelProbe.enabled/kind/baseURL` | `false` | 主动探测本地服务器的**真实**上下文窗口（`llama`/`ollama`/`openai`） |
| `embedder.kind` | `lightweight` | `lightweight`（无依赖）或 `transformers` |
| `budget.short/mid/long/retrieved` | `10000/20000/5000/15000` | 分层 token 预算 |
| `forgetting.minScore` | `0.25` | 低于此分数的记忆被遗忘 |
| `forgetting.maxMemories` | `500` | 记忆总数上限 |

> **本地模型（LM Studio / llama-server / Ollama）**：`settings.yaml` 里声明的
> `contextWindow` 可能远大于服务器实际运行的上下文（例如声明 100000、实际只有 8k）。
> 开启 `modelProbe`（`kind: openai` 同时兼容 LM Studio 的 `/api/v0/models` 与
> **llama-server 的 `meta.n_ctx`**，或 `llama`/`ollama`）后，插件会在首次观测到该模型时
> 读取服务器的真实运行上下文，并取 `min(声明值, 探测值)` 作为生效窗口——压缩因此会在
> 真实上限之前触发，而不是等到溢出。插件自身的每轮 RAG 注入（`rag_token_budget`）
> 也会从压缩触发水位中预留，避免「插件自己吃掉的上下文」被漏算。远程模型（无法探测的）
> 用 `modelWindows` 直接钉住真实窗口，例如 `[{model: glm-5.3-flash, contextWindow: 1000000}]`；
> 本地模型也可用它兜底（如 llama.cpp `--ctx-size` 固定值），探测结果仍会进一步收窄。

> **逐模型窗口注册表**：同一运行时里多个会话可能路由到不同模型（1M 的远程对话 +
> 8K 的本地模型）。窗口按**模型 id** 分别记录（探测/声明/覆盖取最小值），
> 压缩预算按「当前会话路由到的模型」取值——上一个请求属于别的模型不会再污染本会话的水位。
> `memory_status` / `memory_model_probe` 会输出 `perModelWindows` 全表便于核对。

> **深度思考介入（mid-thinking guard）**：DSH 只在 API 报 `CONTEXT_WINDOW_EXCEEDED`
> 后才做"溢出→压缩→重试"。本插件把介入点提前到**生成流里**：包装 `llm/stream`
> waterfall（仅守护 agent 请求，`isAgentLoopRequest` 精确区分，插件自己的摘要调用永不误伤），
> 逐块计量 `input + output`，逼近**当前模型真实窗口**（本地探测/在线声明的动态值）时注入
> 溢出终止块 → 复用 DSH 现成的 `agent/request-error` → **持久压缩 → 带余量重试**，
> 模型"被叫停→压缩→重想"。触发线是**动态的**：
>
> ```
> 触发线 = min( 窗口 − reserve, 窗口 × thinking_guard_ratio )
> reserve = system/tools 占用 + 摘要输出估算 + 余量
> ```
>
> 因为压缩会把可压缩 surface 整段重放进摘要器，`window − reserve` 保证**触发时当前模型的
> 剩余 CTX 足够跑完本插件的压缩**；接管大项目时若 input 单独就已超线，会在**生成前**先压缩，
> 不浪费一次注定失败的生成。文件读取（tool-result 嵌套内容）已被准确计入估算（见 `token-budget.ts`）。

#### `memory-compaction` 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `compaction_dynamic_threshold` | `true` | **动态压缩阈值**：当路由模型的**真实**窗口（探测 / `modelWindows`）小于声明窗口时，按真实窗口推导阈值强制持久化历史压缩（复用 compaction-basic 的溢出式均衡压缩），不再等一个模型永远到不了的声明窗口阈值——短上下文本地模型的「续杯」能力；同一会话两次强制压缩间隔 ≥10s |
| `compaction_dynamic_floor` | `0.6` | 动态触发比例下限：窗口填充过 ~50% 后，触发比例从 `thresholdRatio`(0.8) 滑向此值（~70% 触发，预留 ~30% 给摘要 pass） |
| `thinking_guard_enabled` | `true` | **深度思考介入**：包装 agent 的 LLM 流，`input + output` 逼近当前模型真实窗口的动态线时注入 `CONTEXT_WINDOW_EXCEEDED` → 持久压缩 → 带余量重试；输入单独超线则生成前先压缩 |
| `thinking_guard_ratio` | `0.9` | 触发线**上限**（窗口占比）；实际触发通常更早：`窗口 − (system/tools + 摘要估算 + 余量)` |
| `compress_trigger_ratio` | `0.85` | 上下文 >85% 预算时才压缩 |
| `compress_target_ratio` | `0.6` | 压缩目标水位（只处理溢出部分） |
| `retainRatio` | `0.3` | **保留尾部比例**：压缩时最近 ~30% 窗口原样保留，更老的头部被摘要替换（0.4 时实测 137K→95K；0.3 可压到 ~60K，配合下方 `maxTokens` 提升保证摘要质量） |
| `maxTokens` | `10000` | **摘要输出上限**：调高到 10000 让更大的遮蔽跨度仍能生成完整、细节保留的检查点（原 8192） |
| `retain_recent_messages` | `4` | 最近 N 条消息永不压缩 |
| `rag_top_k` | `3` | 每轮注入的记忆数 |
| `rag_min_score` | `0.3` | 注入的最低相似度 |
| `rag_ingest_denylist` | 内置 21 个 | 低价值工具过滤列表 |
| `rag_ingest_importance` | `0.3` | 工具结果重要性（遗忘优先淘汰） |

### 部署

> **发布就绪说明**：npm/GitHub/tarball 安装走 `dist/` 编译产物（`prepare`/`prepack` 自动构建）。
> Node 24 不允许 node_modules 下的 `.ts` 类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），
> 因此 bundle 必须发布编译后 JS；bundle 补丁里的入口用**裸子路径说明符**
> （如 `dsh-infinite-context/memory-context`）——相对路径会按 profile 目录解析而失效。

> ⚠️ **`dsh plugin add` 的临时路径陷阱**：`dsh plugin --profile <name> add <tgz>` 会把 tarball
> 暂存到 `D:\Temp\dsh-plugin-install-<随机>\` 并在 profile 的 `package.json` 里记成
> `file:D:/Temp/...` —— **临时目录随时会被清理**，之后任何一次 profile 级 `npm install`
> 都会因解析不到该路径而失败。可靠做法：把 tarball 放到**持久化目录**（如
> `~/.dsh/packages/`），并让 profile 依赖指向它：

```sh
# 方式一：通过 --patch 临时加载（.ts 源码直载，适合本机开发）
dsh web --patch ./cordis.yml

# 方式二（推荐）：持久化 tarball 安装 —— npm pack 后把 tgz 放进 ~/.dsh/packages/，
# 并把 profile package.json 的依赖改为 file:C:/Users/<you>/.dsh/packages/<pkg>.tgz
npm pack
mkdir -p ~/.dsh/packages 2>/dev/null; cp dsh-infinite-context-0.1.0.tgz ~/.dsh/packages/

# 方式三：dsh plugin add（注意上面的临时路径陷阱；装完后建议把依赖重定向到持久化路径）

# 方式四：手动复制到 DSH plugins 目录 + 编辑 cordis.patch.yml（.ts 直载）
```

> **更新已安装插件**：`npm pack` → 覆盖 `~/.dsh/packages/` 里的 tgz → 把新 `dist/*` 与
> `bundle.patch.yml` 直接复制进
> `<profile>/node_modules/dsh-infinite-context/`（立即可用，无需 npm install）→ 重启 DSH。

**一键安装脚本**（`scripts/`，通用工具，可用于任何 DSH 插件）：

```powershell
# 交互式菜单（校验 dsh.bundle 清单 → 自动编译 → tarball 安装 →
# 自动清理 profile 补丁层同 id 旧条目 → 可选联动重启）
scripts\install-dsh-plugin.bat

# 或直接调用 PowerShell 版
scripts\install-dsh-plugin.ps1 <目录|tgz|npm:包名|github:owner/repo> -Profile <name>

# 只验证自动探测结果（node / harness / DSH_HOME / profile / 来源），不打包不安装不重启
scripts\install-dsh-plugin.ps1 -DetectOnly
```

> **自动探测与持久化**（2026-09-03）：脚本自动定位 harness 根目录——优先级为
> **运行中的 DSH 进程工作目录（PEB 读取，最权威）→ cfg 记忆值 → 常见安装位置 → 文件系统浅层检索**，
> `$DSH_HOME` 取 `$env:DSH_HOME` 或 `~/.dsh`；解析结果持久化到 `scripts/install-dsh-plugin.cfg`
> （GBK，与 bat 共用）。tarball 固定输出到 `~/.dsh/packages/`（规避 `dsh plugin add` 临时路径陷阱）；
> 安装前自动移除目标 profile 里指向临时/已失效路径的旧依赖（否则 pnpm add 直接 ENOENT 失败），
> 安装后校验依赖已指向持久化 tarball。注意：`scripts/install-dsh-plugin.ps1` 必须保存为
> **带 BOM 的 UTF-8**（powershell.exe 5.1 对无 BOM 文件按 ANSI/GBK 误读中文会解析错乱），
> `install-dsh-plugin.bat` 必须是 **GBK + CRLF**（cmd 对 LF-only 批处理解析错位）。

### 测试

```sh
# 单元测试（133 个，无 DSH 依赖）
vitest run --config vitest.config.ts

# 类型检查
tsc -p tsconfig.typecheck.json --noEmit
```

---

## Introduction

A DeepSeek Harness (DSH) plugin that gives long sessions an "infinite context"
feel via **multi-tier memory management**:

- **Progressive compression** — token-pressure driven, oldest-first summarization, recent context preserved verbatim
- **Dynamic compaction threshold** — trigger water level derived from the routed model's REAL CTX; a single oversized thinking turn bypasses the round-interval rate limit
- **Mid-thinking guard** — wraps the agent's LLM stream: when `input + output` approaches the current model's real window, injects an overflow signal → durable compaction → retry with room; **the plugin intervenes even while the model is deep-thinking**
- **Three-tier memory pyramid** — short (recent turns) → mid (LLM summaries) → long (consolidated summaries)
- **Persistent store** — SQLite (`node:sqlite`), memories survive restarts
- **Semantic retrieval** — memories embedded, indexed, and top-K spliced into context per turn
- **Three-layer dedup** — exact + normalized fuzzy + semantic cosine, prevents duplicate ingestion
- **Structured memory** — four classifications (user/feedback/project/reference) + index + audit + visible forgetting
- **Model-context awareness** — auto-adopts DSH-resolved real model CTX, small local models compress early
- **High-value filtering** — only high-value tool results ingested, low-value tools filtered
- **Manual tools** — 10: search / status / index / maintain / model_probe / forget / consolidate / reset / force_compress / ingest

### Key Features

| Feature | Description |
|---------|-------------|
| Progressive compression | `compress_trigger_ratio: 0.85` — compress only when >85% full; `compress_target_ratio: 0.6` — only summarize overflow; `retainRatio: 0.3` — newest ~30% of the window stays verbatim; `maxTokens: 10000` — summarizer output cap raised to preserve detail |
| Dynamic compaction threshold | `compaction_dynamic_threshold: true` — when the REAL window (probe / `modelWindows`) is below the declared one, force compaction at a REAL-window threshold; `compaction_dynamic_floor: 0.6` — the trigger ratio slides from 0.8 toward the floor as the window fills (~70% trigger, reserving ~30% for the summarization pass); a single-round surge (≥20% of window) bypasses the interval; forced compactions ≥10s apart |
| Mid-thinking guard | `thinking_guard_enabled: true` — wraps `llm/stream`: when `input + output` nears the dynamic line `window − (system/tools + summary estimate + margin)`, injects `CONTEXT_WINDOW_EXCEEDED` → durable compaction → retry; input already over the line is compacted BEFORE generation; `thinking_guard_ratio: 0.9` is the ceiling |
| Three-layer dedup | Exact (hasText) + normalized (normalizeForDedup) + semantic (cosine ≥ 0.92) |
| Structured memory | `memory_index` (MEMORY.md style) + `memory_maintain` (audit) + visible forgetting |
| Model CTX awareness | Auto-reads DSH model catalog contextWindow; local models are actively probed for their REAL runtime window (llama/ollama/openai incl. llama-server `meta.n_ctx`); per-model registry isolates concurrent sessions |
| High-value filtering | denylist filters 23 low-value tools; importance tiers (short=0.3/mid=0.6/long=0.6, long inherits batch max) |

### Manual Tools

| Tool | Description |
|------|-------------|
| `memory_search(query?, k?)` | Semantic search over persisted memories |
| `memory_status` | Report tier counts, budgets, embedder, forgetting policy, model CTX + per-model windows |
| `memory_index(limit?)` | MEMORY.md-style structured index |
| `memory_maintain` | Read-only audit: duplicates/conflicts/stale |
| `memory_model_probe(forceProbe?, model?)` | Report model CTX source, force probe, list per-model windows |
| `memory_forget` | Run a forgetting sweep |
| `memory_consolidate` | Force pyramid consolidation |
| `memory_reset` | Erase all memories |
| `memory_force_compress(sessionId?)` | Force compress a session |
| `memory_ingest(text, source)` | Manually ingest a text (auto-triggered via the `tools/result` callback) |

### Deployment

> **Publish-readiness note**: npm/GitHub/tarball installs consume the compiled `dist/`
> (`prepare`/`prepack` build automatically). Node 24 refuses TypeScript stripping under
> node_modules (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so bundles must ship
> compiled JS, and bundle-patch entries must use **bare subpath specifiers**
> (e.g. `dsh-infinite-context/memory-context`) — relative paths resolve against the
> profile directory and break.

```sh
# Option 1: Temporary load via --patch (direct .ts loading, for local dev)
dsh web --patch ./cordis.yml

# Option 2: Install into a profile (tarball, verified end-to-end)
npm pack && dsh plugin --profile <name> add ./dsh-infinite-context-0.1.0.tgz

# Option 3: Manual copy to DSH plugins dir + edit cordis.patch.yml (direct .ts)
```

**One-click installer** (`scripts/`, generic tool for any DSH plugin):

```powershell
# Interactive menu (validates the dsh.bundle manifest → auto-builds →
# tarball install → auto-cleans legacy same-id patch entries → optional restart)
scripts\install-dsh-plugin.bat

# Or call the PowerShell version directly
scripts\install-dsh-plugin.ps1 <dir|tgz|npm:pkg|github:owner/repo> -Profile <name>
```

### Testing

```sh
# Unit tests (133, no DSH dependency)
vitest run --config vitest.config.ts

# Type check
tsc -p tsconfig.typecheck.json --noEmit
```

---

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design.

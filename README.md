# dsh-infinite-context

[🇨🇳 中文](#简介) | [🇬🇧 English](#introduction)

---

## 简介

一个 DeepSeek Harness (DSH) 插件，通过**多层记忆管理**让长对话拥有「无限上下文」体验：

- **渐进式压缩** — token 压力驱动，最老消息优先摘要，近期对话原样保留
- **三层记忆金字塔** — short（近期原文）→ mid（LLM 摘要）→ long（合并摘要）
- **持久化存储** — SQLite（`node:sqlite`），重启不丢记忆
- **语义检索** — 记忆嵌入、索引，每轮注入最相关的 top-K 记忆
- **三层去重** — 精确 + 归一化模糊 + 语义余弦，防止重复入库
- **结构化记忆** — 四分类（user/feedback/project/reference）+ 索引 + 审计 + 忘得可见
- **模型上下文感知** — 自动采纳 DSH 解析的真实模型 CTX，本地小模型提前压缩
- **高价值过滤** — 只入库高价值工具结果，低价值工具自动过滤
- **手动工具** — search / status / index / maintain / forget / consolidate / reset / model_probe

### 核心特性

| 特性 | 说明 |
|------|------|
| 渐进式压缩 | `compress_trigger_ratio: 0.85` — 上下文 >85% 才压缩；`compress_target_ratio: 0.6` — 只摘要溢出部分 |
| 三层去重 | 精确（hasText）+ 归一化（normalizeForDedup）+ 语义（cosine ≥ 0.92） |
| 结构化记忆 | `memory_index`（MEMORY.md 索引）+ `memory_maintain`（审计）+ 忘得可见 |
| 模型 CTX 感知 | 自动读取 DSH 模型目录的 contextWindow；Ollama 可选主动探测 |
| 高价值过滤 | denylist 过滤 21 个低价值工具；importance 分级（short=0.3/mid=0.6/long=0.7） |

### 架构

```
src/
├── types.ts              核心类型（无依赖）
├── embedder.ts           轻量级特征哈希嵌入器（无依赖）
├── vector-index.ts       内存向量索引（无依赖）
├── memory-store.ts       SQLite 持久化存储（无依赖）
├── token-budget.ts       CJK-aware token 估算（无依赖）
├── forgetting.ts         遗忘策略（无依赖）
├── memory-engine.ts      记忆引擎核心（无依赖）
├── model-context.ts      模型上下文跟踪器（无依赖）
├── model-probe.ts        主动探测：llama/ollama/openai
├── config.ts             schemastery 配置解析
├── memory-context.ts     Cordis 服务（动态 CTX 感知）
├── memory-compaction.ts  压缩引擎（渐进式 + RAG + 清理）
├── OutputSanitizer.ts    工具结果清理
├── VectorRetriever.ts    RAG 检索/入库
├── strings.ts            共享字符串工具
├── core.ts               公共导出桶
├── index.ts              完整导出桶
└── tools.ts              9 个手动工具
tests/                    62 个单元测试
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

### 配置参考

#### `memory-context` 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `storePath` | `dsh-infinite-context.db` | SQLite 路径；`:memory:` 禁用持久化 |
| `contextWindow` | `94000` | 模型上下文窗口（**回退值**；插件自动采纳 DSH 解析的真实窗口） |
| `headroomRatio` | `0.25` | 系统/工具/输入/输出预留比例 |
| `modelProbe.enabled/kind/baseURL` | `false` | 可选主动探测（`llama`/`ollama`/`openai`） |
| `embedder.kind` | `lightweight` | `lightweight`（无依赖）或 `transformers` |
| `budget.short/mid/long/retrieved` | `10000/20000/5000/15000` | 分层 token 预算 |
| `forgetting.minScore` | `0.25` | 低于此分数的记忆被遗忘 |
| `forgetting.maxMemories` | `500` | 记忆总数上限 |

#### `memory-compaction` 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `compress_trigger_ratio` | `0.85` | 上下文 >85% 预算时才压缩 |
| `compress_target_ratio` | `0.6` | 压缩目标水位（只处理溢出部分） |
| `retain_recent_messages` | `4` | 最近 N 条消息永不压缩 |
| `rag_top_k` | `3` | 每轮注入的记忆数 |
| `rag_min_score` | `0.3` | 注入的最低相似度 |
| `rag_ingest_denylist` | 内置 21 个 | 低价值工具过滤列表 |
| `rag_ingest_importance` | `0.3` | 工具结果重要性（遗忘优先淘汰） |

### 部署

```sh
# 方式一：通过 --patch 临时加载
dsh web --patch ./cordis.yml

# 方式二：安装到 profile
dsh plugin --profile web add .

# 方式三：手动复制到 DSH plugins 目录 + 编辑 cordis.patch.yml
```

### 测试

```sh
# 单元测试（62 个，无 DSH 依赖）
vitest run --config vitest.config.ts

# 类型检查
tsc -p tsconfig.typecheck.json --noEmit
```

---

## Introduction

A DeepSeek Harness (DSH) plugin that gives long sessions an "infinite context"
feel via **multi-tier memory management**:

- **Progressive compression** — token-pressure driven, oldest-first summarization, recent context preserved verbatim
- **Three-tier memory pyramid** — short (recent turns) → mid (LLM summaries) → long (consolidated summaries)
- **Persistent store** — SQLite (`node:sqlite`), memories survive restarts
- **Semantic retrieval** — memories embedded, indexed, and top-K spliced into context per turn
- **Three-layer dedup** — exact + normalized fuzzy + semantic cosine, prevents duplicate ingestion
- **Structured memory** — four classifications (user/feedback/project/reference) + index + audit + visible forgetting
- **Model-context awareness** — auto-adopts DSH-resolved real model CTX, small local models compress early
- **High-value filtering** — only high-value tool results ingested, low-value tools filtered
- **Manual tools** — search / status / index / maintain / forget / consolidate / reset / model_probe

### Key Features

| Feature | Description |
|---------|-------------|
| Progressive compression | `compress_trigger_ratio: 0.85` — compress only when >85% full; `compress_target_ratio: 0.6` — only summarize overflow |
| Three-layer dedup | Exact (hasText) + normalized (normalizeForDedup) + semantic (cosine ≥ 0.92) |
| Structured memory | `memory_index` (MEMORY.md style) + `memory_maintain` (audit) + visible forgetting |
| Model CTX awareness | Auto-reads DSH model catalog contextWindow; optional active probe for Ollama |
| High-value filtering | denylist filters 21 low-value tools; importance tiers (short=0.3/mid=0.6/long=0.7) |

### Manual Tools

| Tool | Description |
|------|-------------|
| `memory_search(query?, k?)` | Semantic search over persisted memories |
| `memory_status` | Report tier counts, budgets, embedder, forgetting policy, model CTX |
| `memory_index(limit?)` | MEMORY.md-style structured index |
| `memory_maintain` | Read-only audit: duplicates/conflicts/stale |
| `memory_model_probe(forceProbe?, model?)` | Report model CTX source, force probe |
| `memory_forget` | Run a forgetting sweep |
| `memory_consolidate` | Force pyramid consolidation |
| `memory_reset` | Erase all memories |
| `memory_force_compress(sessionId?)` | Force compress a session |

### Deployment

```sh
# Option 1: Temporary load via --patch
dsh web --patch ./cordis.yml

# Option 2: Install into profile
dsh plugin --profile web add .

# Option 3: Manual copy to DSH plugins dir + edit cordis.patch.yml
```

### Testing

```sh
# Unit tests (62, no DSH dependency)
vitest run --config vitest.config.ts

# Type check
tsc -p tsconfig.typecheck.json --noEmit
```

---

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design.
See [`DSH插件开发经验.md`](DSH插件开发经验.md) for development lessons learned.
See [`REVIEW.md`](REVIEW.md) for the code review report.

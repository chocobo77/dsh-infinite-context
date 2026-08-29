# DSH插件开发经验总结

## Windows路径问题 (ERR_UNSUPPORTED_ESM_URL_SCHEME)

### 问题描述
在 Windows 上使用 `file://` URL 加载插件时出现 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 错误。

### 根本原因
Node.js 在 Windows 上对 `file://` URL 的处理与 Unix 不同，需要使用 `file:///C:/...` 三斜杠格式。

### 解决方案
- 插件路径必须使用 `file:///C:/...` 格式（三斜杠 + 盘符）
- 在 `cordis.patch.yml` 的 `name` 字段中使用此格式
- 示例：`name: file:///C:/Users/Administrator/.dsh/profiles/web/plugins/dsh-infinite-context/src/memory-context.ts`

### 关键点
- `file:///` 是跨平台标准，但在 Windows 上必须包含盘符
- 不要使用 `file://C:/...`（两斜杠），这会导致 `URL` 解析错误

### 配置文件位置
- `cordis.patch.yml`：用户级覆盖配置，位于 `~/.dsh/profiles/web/`
- `cordis.yml`：插件级示例配置，位于插件根目录

---

## 配置验证错误

### 问题描述
插件加载时出现 "unresolved keys cause config validation failure" 错误。

### 原因
DSH 使用 schemastery 验证配置。如果传入了 schema 中未定义的字段，验证会失败。

### 解决方案
- 在 `MemoryCompactionEngine` 构造函数中，先用解构提取所有插件自定义字段，再把剩余字段传给 `BasicCompactionEngine`
- 确保所有自定义字段（`rag_*`、`compress_*` 等）在解构时被移除

```ts
const { retrieval, compress_round_interval, ...basicConfig } = config
super(ctx, basicConfig as BasicCompactionConfig)
```

---

## 索引水合 Bug（已修复）

### 问题描述
重启后 `memory_search` 找不到历史记忆。

### 根本原因
`Service.init` 创建了空的 `VectorIndex`，没有从 SQLite 加载已持久化的记忆。

### 修复方案
新增 `MemoryEngine.loadFromStore()` 方法，在 `Service.init` 中调用，从 SQLite 加载所有有 embedding 的记录到内存索引。

```ts
loadFromStore(): number {
  const all = this.store.list()
  let loaded = 0
  for (const doc of all) {
    if (doc.embedding !== undefined && doc.embedding.length > 0) {
      this.index.add(doc.id, doc.embedding)
      loaded++
    }
  }
  return loaded
}
```

预期日志：`loaded=N memories from disk`

---

## 压缩触发机制

### 触发条件
在 `agent/pre-step` 钩子中，当 token 压力超过 `thresholdRatio × contextWindow` 时触发压缩。

### 关键参数
| 参数 | 作用 | 默认值 |
|------|------|--------|
| `thresholdRatio` | 触发压缩的压力阈值 | 0.8 |
| `retainRatio` | 保留近期消息的比例 | 0.4 |
| `compress_round_interval` | 轮次间隔 | 7 |
| `compress_trigger_ratio` | token 压力触发阈值 | 0.85 |
| `compress_target_ratio` | 压缩目标水位 | 0.6 |
| `retain_recent_messages` | 保留最近 N 条消息 | 4 |

### 测试技巧
- 临时降低 `thresholdRatio`（如 0.1）可在短对话中触发压缩
- 压缩后记得还原配置
- 检查日志中的 `[ContextGovernor]` 前缀

### 压缩流程
1. `agent/pre-step` 检测 token 压力
2. `compactRegion()` 分割需要压缩的区域
3. `summarize()` 调用 LLM 生成摘要
4. `storeMemory()` 将摘要存为 mid 层记忆（含 embedding）
5. `rebalance()` 执行遗忘扫描 + 金字塔合并

---

## Embedding 与检索

### LightweightEmbedder（`embedder.ts`）
- 确定性：相同输入始终产生相同向量（跨进程、跨平台）
- 实现：signed feature hashing + sublinear term weighting（`1 + log(count)`）
- CJK 支持：每个汉字作为一个独立 token
- 维度：默认 256（256–512 是合理范围）

### 检索流程（`memory-engine.ts` → `retrieve()`）
1. 查询文本 → embed → queryVector
2. `VectorIndex.search(queryVector, topK, minScore)` → cosine similarity 排序
3. 过滤 `score < minScore` 的结果
4. 从 store 获取完整文档

### 已验证的相似度（实测数据）
- 相同主题不同表述：0.25–0.35（lightweight embedder 的典型相关范围）
- 相同内容不同时间戳：~0.625（time-only diff）
- 完全无关：~0
- 完全相同：1.0

### 注意事项
- `lightweight` embedder 的语义能力有限，它主要捕捉词汇重叠
- 对于需要真正语义理解的场景，使用 `transformers` embedder
- `rag_min_score` 推荐 0.3（lightweight）或 0.5（transformers）

---

## Pyramid 合并机制

### 规则
- 当 mid 记忆数 ≥ `mergeThreshold`（默认 4）时触发合并
- 取最老的 `mergeBatch`（默认 3）条 mid 记忆
- 调用 LLM 合并为一条 long 记忆
- long 记忆数超过 `maxLong`（默认 20）时，最老的被裁剪

### 合并结果
- 合并后的 long 记忆 `kind: 'project'`
- `importance` 取合并源中的最大值
- `mergedFrom` 记录源记忆 id（可溯源）

### 实测观察
- 合并质量取决于 LLM 摘要能力
- 合并后的 long 记忆通常保留了关键决策和文件路径
- 合并是 best-effort：失败不影响遗忘和其他流程

---

## 调试步骤

1. 检查启动日志：`memoryContext ready: embedder=... budget=... loaded=N memories from disk`
2. 用 `memory_status` 查看当前状态（tier/kind 分布、embedder、budget）
3. 用 `memory_search("关键词")` 测试检索
4. 用 `memory_index` 查看结构化索引
5. 用 `memory_maintain` 审计重复/冲突/过时
6. 检查 SQLite 文件大小和记录数
7. 查看日志中的 `[ContextGovernor]` 和 `[VectorRetriever]` 前缀

---

## 常见陷阱

### 1. `retainRatio` 必须 < `thresholdRatio`
否则 schemastery 验证失败，插件无法加载。

### 2. `budget` 总和必须 ≤ `contextWindow × (1 - headroomRatio)`
否则 `TokenBudget.validate()` 抛出异常。

### 3. 嵌入器选择影响检索质量
`lightweight` 适合词汇匹配，`transformers` 适合语义理解。混合使用会导致索引不一致。

### 4. SQLite WAL 模式
`PRAGMA journal_mode = WAL` 提供并发读写能力，但 WAL 文件需要定期 checkpoint。

### 5. 工具结果自动入库
`tools/result` 回调会自动清理并入库高价值工具结果。低价值工具（`memory_*`、`todo_*` 等）被 denylist 过滤。

---

## 已验证的端到端流程（2025-08-26）

完整流程已验证：
1. ✅ 插件加载（`memoryContext ready` 日志）
2. ✅ 压缩触发（token 压力超过阈值）
3. ✅ LLM 摘要生成
4. ✅ 摘要存为 mid 记忆（含 embedding）
5. ✅ 遗忘扫描（drop 低价值记忆）
6. ✅ 金字塔合并（mid → long）
7. ✅ RAG 检索注入（top-K 记忆注入上下文）
8. ✅ 跨重启持久化（SQLite + loadFromStore）

---

## RAG 最小相似度阈值（rag_min_score）

### 实测数据
- `lightweight` embedder：相关查询得分 0.25–0.35，无关查询 <0.1
- `transformers` embedder：相关查询得分 0.5–0.8，无关查询 <0.3

### 结论
- `lightweight` 推荐 `rag_min_score: 0.3`
- `transformers` 推荐 `rag_min_score: 0.5`
- 过低会注入噪音，过高会丢失相关记忆

### 注意
- 相同内容不同时间戳的得分 ~0.625（lightweight），可能被误判为"相关"
- 归一化去重（`hasTextNormalized`）可以弥补这个缺陷

---

## 工具名冲突问题

### 问题描述
如果插件注册的工具名与 DSH 内置工具名冲突，会导致工具注册失败。

### 根本原因
DSH 的工具注册表不允许同名工具。

### 解决方案
- 使用 `memory_` 前缀（如 `memory_search`、`memory_status`）
- 避免与 DSH 内置工具（`web_search`、`code_exec` 等）重名

---

## OutputSanitizer 边界 case（已验证修复）

### 问题描述
`sanitizeToolResult` 对某些工具结果格式处理不当。

### 根本原因
- `web_search` 结果可能是 `results`、`items` 或 `hits` 字段
- `code_exec` 结果可能是 `error` 或 `stderr` 字段

### 解决方案
- `sanitizeWebSearch`：尝试 `results ?? items ?? hits`
- `sanitizeCodeExec`：尝试 `error ?? stderr`
- 所有操作都是非 mutating 的（返回新对象）

---

## 压缩质量问题（HistoryCompressor）

### 问题描述
早期版本的压缩会丢失关键细节（代码片段、文件路径、决策原因）。

### 根本原因
摘要 prompt 过于简单，没有要求保留具体细节。

### 修复方案
- 使用结构化提取 prompt（`extractBatch`）：明确要求保留代码、路径、决策、工具结果
- 长对话分批处理（20 条/批，5 条重叠）+ 合并 pass（`mergeBatches`）
- 保留原始语言（不翻译）
- 输出预算控制（~30% 压缩率）

### 关键代码变更
- `extractBatch()`：结构化提取，保留所有实质性信息
- `mergeBatches()`：合并多批摘要，去重保全
- `summarizationTargetTokens()`：动态计算输出预算

---

## memory_force_compress 工具注册与调用（已修复）

### 问题描述
`memory_force_compress` 工具注册后调用失败。

### 根本原因
- 工具需要访问 `HistoryCompressor` 实例，但它是 `MemoryCompactionEngine` 的私有成员
- `MemoryContext` 服务没有对 `compactionEngine` 的反向引用

### 解决方案（已部署）
1. `MemoryContext` 增加 `compactionEngine` 背包字段（public）
2. `MemoryCompactionEngine` 构造函数末尾注册反向引用：
   ```ts
   ctx.memoryContext.compactionEngine = { compressor: this.compressor }
   ```
3. `memory_force_compress` 工具通过 `ctx.memoryContext.compactionEngine.compressor` 访问

### Session API 注意事项
- `session.deriveMessages()` 返回冻结的消息数组（不可变）
- `SessionId(args.sessionId)` 需要从 `@deepseek-ai/dsh-session` 导入
- `ctx.sessions.get(SessionId)` 获取 session 对象

---

## 去重入库 + 高价值工具过滤（2026-08-26 已验证）

### 背景
早期版本全量入库所有工具结果，导致记忆库膨胀（重启后 10 分钟 17 条低价值记忆）。

### 三层去重（`VectorRetriever.ingest`）
1. **精确去重**：`hasText(full)` — 完全相同的文本
2. **归一化去重**：`hasTextNormalized(full)` — 小写 + 空白折叠 + 数字掩码
3. **语义去重**：`retrieve(chunk, 1, dedupeMinScore)` — 余弦相似度 ≥ 0.92

### 关键经验：语义去重阈值对 lightweight embedder 无效
- 相同内容不同时间戳的余弦相似度 ~0.625（lightweight），远低于 0.92
- 解决：用归一化去重（`normalizeForDedup`）替代语义去重处理时间戳差异
- `normalizeForDedup`：`toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()`

### 归一化实现（`memory-store.ts`）
```ts
export function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}
```

### 高价值工具过滤
- `rag_ingest_denylist`：默认 21 个低价值工具（`memory_*`、`todo_*`、`ask_user_question` 等）
- `rag_ingest_allowlist`：可选白名单，优先级高于 denylist
- `rag_ingest_importance`：工具结果的重要性（默认 0.3），遗忘策略优先淘汰

### 验证结果（重启后实测）
- ✅ 精确去重：两次相同固定输出命令 → DB 仅 1 条
- ✅ 归一化去重：两条仅时间戳不同的命令 → DB 仅 1 条
- ✅ denylist：重启后 0 条 todo/memory_* 记忆
- ✅ importance：重启后新记忆全部 0.3（工具结果档）

### 配置项
| 参数 | 默认值 | 作用 |
|------|--------|------|
| `rag_dedupe_exact` | `true` | 精确 + 归一化去重 |
| `rag_dedupe_min_score` | `0.92` | 语义去重阈值（0 禁用） |
| `rag_ingest_denylist` | 21 个工具 | 低价值工具过滤 |
| `rag_ingest_allowlist` | 空 | 白名单（优先于 denylist） |
| `rag_ingest_importance` | `0.3` | 工具结果重要性 |

---

## 参数权重分析与优化（2026-08-26）

### 重大发现 1：budget 分层是死配置
- `budget.fits()` / `truncateToBudget()` 从未被调用
- 真正生效的是 `rag_token_budget`(3000) 与 `thresholdRatio`(0.8)
- 结论：budget 是「预留上限」语义，由 `rag_*` 实际控制

### 重大发现 2：遗忘策略失效（importance 全默认 0.5）
- 所有记忆 importance=0.5 → score = 0.3 + 0.4×recency ≥ 0.3 > minScore(0.15)
- 只靠 maxMemories=500 硬上限，遗忘策略形同虚设

### 修复：importance 分级 + minScore 校准
| 层 | importance | 说明 |
|----|-----------|------|
| short（工具结果） | 0.3 | 最先被遗忘 |
| mid（压缩摘要） | 0.6 | 中等保留 |
| long（金字塔合并） | 0.7 | 长期保留 |

- `minScore` 从 0.15 调整为 0.25
- short 约 90 天可遗忘，mid/long 长期保留

---

## 延迟压缩 + 渐进式上下文治理（2026-08-26）

### 目标
避免过早压缩（保留更多原文），同时确保长对话不会超出上下文窗口。

### 原实现的问题
- 每 N 轮固定压缩一次，不管上下文是否真的满了
- 全量压缩（所有旧消息一次性摘要），丢失近期上下文连贯性

### 优化方案：token 压力驱动的渐进式压缩
1. **延迟触发**：轮次间隔到了但上下文还很空 → 不压缩
2. **渐进式**：只摘要最老的溢出部分，近期消息原样保留
3. **保留近期**：`retain_recent_messages`（默认 4）条消息永远不压缩

### 关键参数
| 参数 | 值 | 作用 |
|------|-----|------|
| `compress_trigger_ratio` | 0.85 | 上下文 >85% 预算时才压缩 |
| `compress_target_ratio` | 0.6 | 压缩到 60% 预算（只处理溢出部分） |
| `retain_recent_messages` | 4 | 最近 4 条消息永远保留 |

### 实测效果（模拟验证）
- 首轮不压缩（上下文远低于 85%）
- 长对话中，只压缩最老的溢出消息
- 近期对话保持完整连贯

### 配套改动
- `fallbackTruncate`：最后手段，按优先级丢弃（RAG → 摘要 → 最老消息）
- 估算器使用 CJK-aware `estimateTokens`（每个汉字 ~1 token）
- `headroomRatio` 动态化（通过 `memoryContext.contextWindow`）

---

## 结构化记忆：分类 + 索引 + 维护（2026-08-27）

### 背景
受「结构化记忆工作流」（AutoMemory 模式）启发：记忆不能只靠隐式向量检索，要**可定位、可分类、可维护**，且**忘得可见**（区分「没记录」vs「不存在」）。核心四分类：`user`（用户偏好）/ `feedback`（纠错经验）/ `project`（阶段结论与决策）/ `reference`（资料、命令、路径）。

### 改动
1. **分类 `kind`**：`MemoryDoc.kind` + SQLite `kind` 列 + **旧库自动迁移**（`PRAGMA table_info` 检测缺列 → `ALTER TABLE ADD COLUMN`）
   - 工具结果入库 → `reference`
   - 压缩摘要（mid）→ `project`
   - 金字塔合并（long）→ `project`
2. **结构化索引 `generateIndex()`**（MEMORY.md 模式）：按 kind 分组、每条记忆一行（≤80 字符），模型先看索引知道「记忆库有什么」，需要时再 `memory_search` 拉详情
3. **维护审计 `maintain()`**：按 kind 内两两比对，识别
   - 重复（相似度 ≥ 0.95，反复记录的决定）
   - 候选冲突（0.85–0.95，相似但结论不同）
   - 过时（importance < 0.4 且 > 30 天）
   - 相似度用**归一化词重叠**（复用 `normalizeForDedup`），无需 embedding
4. **忘得可见**：`memory_search` 无结果时明确「库里没记录 ≠ 从未出现」

### 新工具
| 工具 | 作用 |
|------|------|
| `memory_index` | 查看结构化记忆索引（MEMORY.md 风格） |
| `memory_maintain` | 只读审计：重复/冲突/过时报告 |

### 验证
- 类型检查 0 错误、44 单测通过（新增 kind 分类、索引生成、维护审计、旧库迁移 4 类测试）
- 旧库迁移在真实 DB 上验证：插件重启后自动加 `kind` 列，存量数据 kind 为 null（unclassified）

**教训**：记忆系统应同时具备「语义检索」（召回）+「显式索引」（定位）+「分类」（组织）+「维护」（去重/冲突/过期）+「忘得可见」（诚实暴露信息缺口），缺一不可。

---

## 读取模型真实上下文窗口（CTX-tracked compression，2026-08-28）

### 背景
本地模型（Ollama/llama-server）CTX 小，硬编码 `contextWindow: 94000` 会让 DSH 在模型实际上限处被截断（上下文到达上限）。需求：**按模型真实 CTX 控制压缩**。

### 关键发现：DSH 已解析好每个模型的 CTX，插件零网络可读
- DSH 的 LLM 层（`llm-pi-ai`）在每次请求时从**内置模型目录**（线上大模型自带 contextWindow）或 **OpenAI 兼容 `/models` 发现的 `context_length`/`context_window`**（本地网关）解析出 `contextWindow`，随请求写入 session 的 `request/context` 事件。
- 插件在 `agent/pre-step` 钩子拿到实时 `payload.agent.session`，调用 **`session.requestContext()`** 即可读到 `{ provider, model, contextWindow }`。
- **所以「读取加载模型的 CTX」是原生支持的**：本地（catalog 或 /models 发现）和线上（内置 catalog）都覆盖；只有 Ollama 这种 listing 不带 context_length 的，才需要插件主动探测兜底。

### 实现要点
1. **动态覆盖**：`contextWindow` getter 改为 `adopted ?? 配置回退`，压缩触发/截断预算自动跟随真实窗口 → 8K 本地模型提前压缩，131K 本地模型不提前压缩。
2. **纯逻辑抽离**：状态机放 `ModelContextTracker`（无 cordis 依赖），Cordis 服务只驱动异步探测 → 单测不依赖 DSH。
3. **主动探测兜底**（可选配置 `modelProbe`，默认 off）：
   - llama-server → `GET /props` 的 `default_generation_settings.n_ctx`
   - Ollama → `POST /api/show` 的 `model_info['llama.context_length']`
   - OpenAI 兼容 → `GET /models` 的 `context_length`/`context_window`/`max_model_len`
   - 5s 超时 + 失败返回 undefined，**绝不阻塞请求路径**（fire-and-forget，每模型只探测一次）
4. **工具暴露**：`memory_status` 显示 adopted CTX 及来源；`memory_model_probe` 可强制探测。

### 时序陷阱（重要）
`agent/pre-step` 在 `request/context` **append 之前**触发，所以**首个 step 的 `session.requestContext()` 是 undefined**（回退配置），从第 2 步起才能读到上次请求的窗口。模型 CTX 稳定，用上一次的值完全安全；新会话首个 step 也不会触发压缩，无实际影响。

### 又一个 exactOptionalPropertyTypes 坑
TS 严格模式下**不能显式传 `provider: undefined`**（报 TS2379）。要么条件展开 `...(x === undefined ? {} : { x })`，要么让字段非可选。本项目 tsconfig 开了 `exactOptionalPropertyTypes`，凡是「可选字段 + 可能 undefined 的实参」都要条件展开。

### 验证
- 62 单测通过（新增 model-probe 9 例：llama/ollama/openai 各读取字段 + 非 2xx/网络失败/禁用返回 undefined；ModelContextTracker 9 例）
- tsc 0 错误，19 文件部署 hash 一致

**教训**：DSH 已经解析过的东西（模型 CTX）不要自己再造轮子去猜或硬编码——先找 DSH 的运行时状态（session 事件、catalog）拿现成值；只有拿不到时才用配置回退或主动探测。

---

## 自动清理与元操作污染

### 问题
DSH 的工具结果自动入库机制会把插件自身的维护操作（如 SQL 清理命令的输出）也入库，造成「元操作污染」。

### 解决方案
- `rag_ingest_denylist` 已包含所有 `memory_*` 工具
- 对于 pwsh 等通用工具的输出，污染是轻微的（只入库一次）
- 未来可通过更精细的 source 过滤进一步优化

---

## 配置与部署最佳实践

### 配置优先级
1. `cordis.patch.yml`（用户覆盖，最高优先级）
2. `cordis.yml`（插件默认配置）
3. 代码中的 `DEFAULT_*` 常量

### 部署流程
1. 复制 `src/` 到 `~/.dsh/profiles/web/plugins/dsh-infinite-context/src/`
2. 更新 `cordis.patch.yml` 中的 `name` 路径（`file:///` 格式）
3. 重启 DSH
4. 检查启动日志确认加载成功

### 重要提醒
- `compaction-basic` 必须在 `cordis.patch.yml` 中禁用（`disabled: true`），否则与本插件的 `MemoryCompactionEngine` 冲突
- `rag_ingest_denylist` 必须包含所有 `memory_*` 工具，否则工具输出会自我污染记忆库

---

*最后更新：2026-08-28（模型上下文感知：CTX-tracked compression）*

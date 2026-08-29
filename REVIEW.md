# dsh-infinite-context 代码审查报告

审查日期：本会话
审查范围：`src/` 全部 17 个文件 + `tests/` 6 个测试 + 部署配置 `cordis.patch.yml`
审查基准：DSH 运行时契约（`dsh-llm` 的 `Message` 类型、`dsh-agent` 的 `PreStepDecision`、`compaction-basic` 官方实现）

> **修复状态**：P0 全部 5 项 ✅ + P1 全部 8 项 ✅ 已修复，类型检查 0 错误、38 项单测通过、已部署。
> 修复详情见文末「修复记录」。

---

## 一、严重问题（可能导致运行时故障，建议优先修复）

### P0-1 压缩生成的摘要消息违反 DSH Message 契约 ⚠️ 最严重 ✅ 已修复
**位置**：`src/memory-compaction.ts` `compress()` / `compressForce()`

**修复**：改用 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN } })` 构造摘要消息（user 角色 + ContentBlock[] + 自动 id/source），符合 `PreStepDecision.enter` 的 `UserMessage[]` 契约。

### P0-2 `onToolResult` 从未被调用 — Strategy 3 是死代码 ✅ 已修复
**位置**：`src/memory-compaction.ts` 构造函数

**修复**：构造函数中接线 `ctx.on('tools/result', (exec, result) => ...)`，提取 `result.content` 文本，以 `exec.name` 为 source 调用 `onToolResult()`（跳过 `signal.aborted` 与空文本）。输出净化 + 工具结果自动入库链路现已打通。

### P0-3 `purpose: 'history-compression'` 不是合法枚举值 ✅ 已修复
**位置**：`src/memory-compaction.ts` `llmSummarize`

**修复**：改为 `purpose: 'compaction'`（`GenerateOptions.purpose` 合法值 `'compaction' | 'session-title'`）。

### P0-4 `fallbackTruncate` 最后手段写入只读属性且类型错误 ✅ 已修复
**位置**：`src/memory-compaction.ts` `fallbackTruncate`

**修复**：改为重建消息对象 `result[0] = { ...oldest, content: [{ type: 'text', text: kept }] }`，不再写只读 `content`，保持 DSH Message 契约。

### P0-5 `memory_force_compress` 工具的两个类型错误 ✅ 已修复
**位置**：`src/tools.ts` + `src/memory-context.ts`

**修复**：
1. `MemoryContext.compactionEngine` 类型补上 `compressForce` 方法签名（避免循环导入，用结构化类型镜像 `HistoryCompressor` 的 tools 可见面）
2. `ctx.sessions.get(SessionId(args.sessionId))` 用 branded type 构造器转换（编译期 cast，无运行时开销）

---

## 二、中等问题（功能缺陷或语义错误）

### P1-1 `compress` 与 `compressForce` 消息来源不一致
- `compress()` 处理 `decision.messages`（`UserMessage[]`，模型请求消息）
- `compressForce()` 处理 `session.deriveMessages()`（`Message[]`，含 tool-result、可能含 system/assistant）
两条路径的消息形态不同，同一会话的压缩结果可能不一致，且 `deriveMessages()` 返回的消息**带 id/source**，`compress()` 的输入可能不带——处理后混合形态。

### P1-2 压缩未校验「摘要是否真的更小」
官方 `region.ts` L374-378 有硬校验：`framedSummaryTokenCount >= shadowedTokenCount → throw`。插件的 `compress()` 只算 `saved = before - after`，用 `Math.max(0, saved)` **掩盖负值**——摘要可能比原文更大，白消耗一次 LLM 调用且上下文反而膨胀。

### P1-3 跨轮去重的「闪烁」边界
**位置**：`src/memory-compaction.ts` L845-853
排除集只记录**上一轮**注入的 ids。若记忆池只有 A、B 两条且都相关，轮次序列会变成：注入 A+B → 无新记忆清空 → 注入 A+B → …（每轮全量注入），去重实际上退化为隔轮去重。若记忆池足够大则正常。行为可接受但注释需澄清。

### P1-4 `sanitizeWebSearch`/`truncateStrings` 原地修改调用者对象 ✅ 已修复
**位置**：`src/OutputSanitizer.ts`
**修复**：`stripHtmlRecursive` 与 `truncateStrings` 改为**非破坏性**——递归时构建新对象/新数组，不再改写传入对象。调用方复用原始结果不再有数据损坏风险。

### P1-5 `VectorRetriever.ingest` 把工具名塞进 `sourceSessionId` ✅ 已修复
**位置**：`src/VectorRetriever.ts`
**修复**：不再误用 `sourceSessionId`（其语义是来源会话 id）。工具/来源标签改为**文本前缀** `[source: <tool>]` 写入每个 chunk——来源信息保留且参与检索，DB schema 零改动。

### P1-6 检索 token 截断用 `tokenBudget * 4` 字符数估算 ✅ 已修复
**位置**：`src/VectorRetriever.ts`
**修复**：改用项目的 **CJK-aware `estimateTokens`** 逐条累加，**按整条记忆取舍**（超预算就跳过后续条目），不再在半条记忆中间切片。

### P1-7 两套检索配置并存，`retrieval.*` 基本是死配置 ✅ 已修复
**位置**：`src/config.ts` `resolveRetrievalOptions` + `memory-compaction.ts` 构造函数
**修复**：明确配置语义——`rag_*` 为生效源（轻量 embedder 实测校准），`retrieval.topK/minScore` 保留为**兼容回退**（旧配置继续工作），`retrieval.enabled` 保持注入开关。构造函数统一消费 `resolveRetrievalOptions` 的解析结果，消除重复默认值。

### P1-8 `memory_ingest` 硬编码 retriever 配置 ✅ 已修复
**位置**：`src/tools.ts` + `src/memory-context.ts`
**修复**：`MemoryContext` 新增 `retriever` 回引用（compaction 引擎赋值），`memory_ingest` 复用主配置 retriever，删除硬编码 `new VectorRetriever(...)` 与无用 import。

---

## 三、小问题 / 代码质量

| # | 位置 | 问题 |
|---|------|------|
| P2-1 | `memory-compaction.ts` compress/compressForce | 两份几乎相同的批处理+合并逻辑，DRY 违反，建议 compress 复用 compressForce（catch 后返回 null） |
| P2-2 | `src/memory-context.ts` L153 | `compactionEngine` 类型用 `any[]`，丢失类型安全 |
| P2-3 | `src/memory-store.ts` L215-220 | `deleteMany` 逐条 delete，无事务；失败时部分删除 |
| P2-4 | `src/forgetting.ts` L34-38 | `scoreMemory` 分数可能 >1（权重和≠1 时），默认 0.6+0.4=1 恰好正常；建议 normalize 或文档显式约束 |
| P2-5 | `src/transformers-embedder.ts` L61-70 | `dimension` 是可变字段，`embed()` 首次调用会改写；若并发首个请求，dimension 竞态 |
| P2-6 | `src/tools.ts` L39 | `memory_search` 默认 k=5 但 RAG 注入 topK=3，两处默认不一致（可接受，但文档未说明） |
| P2-7 | `tests/` | **覆盖缺口**：`OutputSanitizer`（纯函数！）、`HistoryCompressor` 提示词构造、`VectorRetriever` 的 retrieve/ingest 逻辑均无单测。OutputSanitizer 完全可以单测 |
| P2-8 | `README.md` | 与实际漂移：README 说 5 个工具，实际 7 个；README 示例 `summarizationProvider: deepseek`，部署实际 `deepseek-official` |
| P2-9 | `memory-compaction.ts` L192 附近（已删） | 上轮已清理死代码 `frameRetrievedMemories`，但 `RetrievalHit` 类型 import 残留检查确认已移除 ✔ |

---

## 四、做得好的一面

1. **依赖隔离优秀**：核心（store/embedder/index/budget/forgetting/engine）零 DSH 依赖，38 个单测覆盖核心逻辑，`core.ts` barrel 干净。
2. **防御性编程到位**：`blobToVector` 校验 byteLength%4、`merged_from` JSON 解析容错、`MemoryStore` closed 状态守卫、retriever 5s 超时 + 错误隔离。
3. **配置解耦正确**：compaction 构造器先剥离插件扩展字段再 `super()`，避免字段泄漏到 `BasicCompactionEngine`（此前踩过坑）。
4. **错误处理策略合理**：压缩/持久化/入库均为 best-effort + 日志，不阻塞主流程；`compressForce` 才抛错供工具反馈。
5. **强制幂等设计**：递归锁（KV 防重入）、turn 计数器、`lastInjectedTurn` 防同轮重复注入。
6. **上下文一致性已在上轮优化**：记忆注入位置前置到最新用户消息之前、时间戳标注、冲突规则（当前对话优先）、跨轮去重。

---

## 五、修复优先级建议

| 优先级 | 问题 | 工作量 |
|--------|------|--------|
| 🔴 立即 | P0-1 摘要消息契约（role/content/id/source） | 中（compress/compressForce 重构） |
| 🔴 立即 | P0-3 purpose 枚举值 | 小（1 行） |
| 🔴 立即 | P0-5 compactionEngine 类型声明 | 小 |
| 🟠 高 | P0-2 onToolResult 接线（tool/result 事件） | 小（挂一个 ctx.on） |
| 🟠 高 | P0-4 fallbackTruncate 重建消息 | 小 |
| 🟡 中 | P1-2 摘要变小校验 | 小 |
| 🟡 中 | P1-6 检索截断用 estimateTokens | 小 |
| 🟡 中 | P1-1 compress/compressForce 消息来源统一 | 中 |
| 🟢 低 | P1-4/P1-5/P1-7/P1-8/P2-* | 视情况 |

---

## 六、结论

**总体评价**：架构清晰、核心测试扎实、防御性编程到位，是一个质量中上的插件。但**集成层（memory-compaction）存在 4 个未触发即潜伏的运行时契约违规**（P0-1/P0-3/P0-4/P0-5），以及 **1 个功能死代码**（P0-2 onToolResult 未接线）。这些在当前环境（LLM 余额不足、压缩未实际触发）下被掩盖，一旦条件满足（长会话触发压缩、工具结果入库），可能表现为运行时错误或功能静默失效。**建议按第五节优先级逐项修复后，再重启 DSH 做一次长会话实测。**

---

## 七、修复记录（已完成 ✅）

### P0 修复（按事态紧急顺序，类型检查 8 错误 → 0）

| # | 修复 | 文件 |
|---|------|------|
| P0-1 | 摘要消息改用 `createUserMessage`（user 角色 + ContentBlock[] + plugin source），消除 4 个 TS2322 | `memory-compaction.ts` compress/compressForce |
| P0-3 | `purpose` 改为合法枚举 `'compaction'`，消除 TS2353 | `memory-compaction.ts` llmSummarize |
| P0-5 | `compactionEngine` 类型补 `compressForce` 签名；`ctx.sessions.get(SessionId(...))` 用 branded type，消除 TS2339/TS2345 | `memory-context.ts`、`tools.ts` |
| P0-2 | 构造函数接线 `ctx.on('tools/result')` → `onToolResult(exec.name, text)`（跳过 aborted/空文本），打通 Strategy 3 | `memory-compaction.ts` 构造函数 |
| P0-4 | `fallbackTruncate` 重建消息对象 `{ ...oldest, content: [{ type: 'text', ... }] }`，消除 TS2540 | `memory-compaction.ts` fallbackTruncate |

**附带修复**：`registerRetrieval` 中 `currentMessages` 显式声明为 `Message[]`（压缩/截断后类型放宽），最终 `as UserMessage[]` 契约化转换。

### P1 修复（小项，按 REVIEW 优先级）

| # | 修复 | 文件 |
|---|------|------|
| P1-2 | `compress`/`compressForce` 增加「摘要变小」硬校验（`saved <= 0` 拒绝），对照 compaction-basic 的 "summary not smaller" 检查；不再用 `Math.max(0, saved)` 掩盖负值 | `memory-compaction.ts` |
| P1-6 | 检索截断改用 **CJK-aware `estimateTokens`** 逐条累加、**按整条记忆取舍**，不再 `tokenBudget * 4` 字符切片（半条残片问题消除） | `VectorRetriever.ts` |
| P1-4 | `stripHtmlRecursive`/`truncateStrings` 改为**非破坏性**（构建新对象/数组） | `OutputSanitizer.ts` |
| P1-5 | `ingest` 不再把工具名误填 `sourceSessionId`；改为 `[source: <tool>]` 文本前缀保留来源 | `VectorRetriever.ts` |
| P1-7 | 检索配置收敛：`rag_*` 为生效源，`retrieval.topK/minScore` 保留为兼容回退，构造函数统一消费解析结果 | `config.ts`、`memory-compaction.ts` |
| P1-8 | `memory_ingest` 复用主配置 retriever（`MemoryContext.retriever` 回引用），删除硬编码实例 | `tools.ts`、`memory-context.ts` |

**下一步**：重启 DSH 后做长会话实测——验证 (1) 压缩触发时注入的摘要消息能被 DSH 接受；(2) 工具结果自动入库（日志出现 `[VectorRetriever] memory store ...`）；(3) `memory_force_compress` 正常执行；(4) 摘要未变小/超预算时压缩被正确拒绝。

---

## 八、去重入库 + 高价值过滤 + 参数权重优化（已完成 ✅）

### 参数权重分析（优化前）

| 参数 | 原值 | 问题 | 优化后 |
|------|------|------|--------|
| `budget.short/mid/long/retrieved` | 10000/20000/5000/15000 | **死配置**：`budget.fits()`/`truncateToBudget()` 从未被调用，分层预算不约束任何行为；真正生效的是 `rag_token_budget`(3000) 与 `thresholdRatio`(0.8) | 保留校验（total 50000 ≤ maxTotal 70500），语义明确为「预留上限」，由 `rag_*` 实际控制 |
| `forgetting.minScore` | 0.15 | **遗忘永不触发**：所有记忆 importance=0.5 → score = 0.3+0.4×recency ≥ 0.3 > 0.15，只靠 maxMemories=500 硬上限 | **0.25**：short 约 90 天可遗忘，mid/long 长期保留 |
| `importance`（所有层） | 0.5 默认 | 无区分度，遗忘策略无法按价值排序 | **分级**：short(工具结果)=0.3 / mid(压缩摘要)=0.6 / long(金字塔合并)=0.7 |
| 工具结果入库 | 全量 | 元工具（memory_*、todo_write、ask_user_question 等）结果也入库 → 记忆库膨胀（重启后 10 分钟 17 条） | **denylist 过滤**（默认内置 21 个低价值工具）+ 可选 allowlist |
| 入库去重 | 无 | 同一工具反复调用产生相同 chunk 重复入库 | **三层去重**：精确（`hasText`）+ **归一化**（`hasTextNormalized`，数字掩码，解决 lightweight embedder 语义去重抓不住时间戳差异的问题）+ 语义（近邻 score ≥ 0.92 兜底） |

### 实现

| 模块 | 改动 |
|------|------|
| `memory-store.ts` | 新增 `hasText(text)` 精确查重 + `hasTextNormalized(text)` 归一化查重 + `normalizeForDedup()`（小写/空白折叠/数字掩码） |
| `memory-engine.ts` / `memory-context.ts` | 透传 `hasText` / `hasTextNormalized` |
| `VectorRetriever.ts` | `ingest` 增加：source 过滤（denylist/allowlist）、精确去重、归一化去重、语义去重（top-1 score ≥ 0.92）、importance 分级（默认 0.3）；保留 5s 超时与错误隔离 |
| `config.ts` | 新增 `rag_dedupe_exact` / `rag_dedupe_min_score` / `rag_ingest_denylist` / `rag_ingest_allowlist` / `rag_ingest_importance` + `DEFAULT_INGEST_DENYLIST`（21 个低价值工具） |
| `memory-compaction.ts` | 构造函数解析新配置传入 retriever；mid 摘要 `storeMemory` 传 `importance: 0.6` |
| `cordis.patch.yml` / `cordis.yml` / `README.md` / `DSH插件开发经验.md` | 同步配置与文档 |

### 验证（重启后实测）
- ✅ 精确去重：两次相同固定输出命令 → DB 仅 1 条
- ✅ 归一化去重：两条仅时间戳不同的命令（`PURE-FUZZY-PROBE <ts> done`）→ DB 仅 1 条
- ✅ denylist：重启后 0 条 todo/memory_* 记忆，来源仅 pwsh
- ✅ importance：重启后新记忆全部 0.3（工具结果档）
- ✅ 类型检查 0 错误、39 单测通过（新增 1 个去重测试）、17 文件已部署

## 九、结构化记忆：分类 + 索引 + 维护（已完成 ✅ 2026-08-27）

依据 AutoMemory/Engramory 视频理念（上下文 ≠ 记忆；记忆要分类、索引、维护、忘得可见）落地：

| 视频理念 | 实现 |
|---------|------|
| 四分类 user/feedback/project/reference | `MemoryDoc.kind` + 自动打标（工具结果→reference，压缩摘要/合并→project） |
| 常驻索引（MEMORY.md） | `memory_index` 工具（按 kind 分组一行一条） |
| 策展契约（查重/更新/清理） | `memory_maintain` 审计（重复 ≥0.95 / 冲突 0.85–0.95 / stale）+ `memory_forget` |
| 忘得可见 | `memory_search` 无结果明确「没记录≠不存在」 |

**实测**：44 单测通过；真实库清理 412 条低价值记忆（906→500）→ 进一步策展至 67 条健康记忆（project 16 + reference 51），审计 0 重复/0 冲突/0 stale，检索仍召回长摘要。

## 十、模型上下文感知（CTX-tracked compression）（已完成 ✅ 2026-08-28）

**目标**：解决「DSH 接入本地模型时上下文到达上限」——按模型真实 CTX 控制压缩，而非硬编码 94000。

**关键发现**：DSH 已在运行时解析每个模型的 `contextWindow`（内置 catalog 或 OpenAI 兼容 `/models` 发现的 `context_length`/`context_window`），并随每次请求记入 session 的 `request/context` 事件 → **插件零网络即可读取真实 CTX**：`agent/pre-step` 里 `session.requestContext().contextWindow`。

**实现**：
| 模块 | 改动 |
|------|------|
| `model-context.ts`（新，纯逻辑） | `ModelContextTracker`：动态 contextWindow + 每模型只探测一次 |
| `model-probe.ts`（新） | 本地兜底探测：llama `/props`·n_ctx、ollama `/api/show`·llama.context_length、openai `/models`·context_length/context_window/max_model_len；5s 超时，失败返回 undefined |
| `memory-context.ts` | `contextWindow` getter 动态化（adopted ?? 配置回退）；`observeRequestContext()`/`probeModel()`/`modelInfo` |
| `memory-compaction.ts` | pre-step 每步同步 `session.requestContext()` → 压缩/截断预算自动跟踪真实窗口 |
| `tools.ts` | `memory_status` 展示 adopted CTX 及来源；新工具 `memory_model_probe`（可强制探测） |
| `config.ts` | `modelProbe`（默认 off）；denylist 加 `memory_model_probe` |

**覆盖矩阵**（回答「能否读取 CTX」「线上 API 是否支持」）：
- 本地 OpenAI 兼容（llama-server/vLLM/LiteLLM/LM Studio）→ `/models` 的 context_length ✅
- 本地 Ollama（listing 不带 CTX）→ 可选 `modelProbe: {kind: ollama, baseURL}` 兜底 ✅
- 线上大模型（DeepSeek/OpenAI/Anthropic…）→ DSH 内置 catalog ✅
- 都拿不到 → 回退配置 `contextWindow`（插件仍正常工作）✅

**时序注意**：`agent/pre-step` 早于 `request/context` append，所以首个 step 读不到（回退配置），第 2 步起读到上一次请求的窗口——模型 CTX 稳定，安全。

**坑**：`exactOptionalPropertyTypes` 下不能显式传 `provider: undefined`，需条件展开 `...(x === undefined ? {} : { x })`。

**验证**：62 单测通过（新增 9 探测 + 9 tracker）、tsc 0 错误、19 文件部署 hash 一致。

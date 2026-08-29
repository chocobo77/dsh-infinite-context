# dsh-infinite-context 目标合规评审报告

> 评审日期：2026-08-29 · 评审基准：README / ARCHITECTURE 声明的 12 项设计目标
> 评审方式：两个独立子代理逐行审查（A：压缩/去重/金字塔/遗忘/持久化；B：CTX感知/检索/工具/配置）+ 交叉核对 DSH 与 vendored cordis 源码 + 主会话抽查复核
> 运行时验证：vitest 8 文件 **62/62 全绿**；`tsc -p tsconfig.typecheck.json`（strict + exactOptionalPropertyTypes）**退出码 0**

---

## 一、总体结论

**无 P1 级缺陷；12 项目标全部达标。**

| 目标 | 结论 | 目标 | 结论 |
|------|------|------|------|
| G1 无限上下文 | ✅ 带备注 | G7 结构化记忆 | ✅ 带备注 |
| G2 渐进式压缩 | ✅ 满分 | G8 模型CTX感知 | ✅ 满分 |
| G3 三层金字塔 | ✅ 带备注 | G9 高价值过滤 | ✅ 带备注 |
| G4 持久化 | ✅ 带备注 | G10 手动工具 | ✅ 带备注 |
| G5 语义检索 | ✅ 带备注 | G11 纯核心可测试 | ✅ 满分（实跑验证） |
| G6 三层去重 | ✅ 带备注 | G12 遗忘 | ✅ 满分 |

核心数学逐行核实无误：触发交错（无死区、无双重压缩）、目标水位切分（无 off-by-one）、遗忘公式、金字塔合并顺序、BLOB Float32 往返、kind 迁移幂等、重启水合。

### 关键数学验证：双阈值交错（评审前最大疑虑，已解决）

| 机制 | 基数 | 触发线 | 来源 |
|------|------|--------|------|
| HistoryCompressor（渐进） | `window×(1−headroom)`=70500 | 70500×0.85=**59925** | memory-compaction.ts:261-265, 338-346 |
| compaction-basic（兜底） | 整窗 94000 | 94000×0.8=**75200** | dsh-compaction-basic src/config.ts:144 |

59925 < 75200 → 渐进压缩先行动，「0.8<p<0.85 死区」不存在；≥75200 由 basic 每步兜底。basic 压缩后 token≈37600 < 59925 → 同轮不会二次压缩。钩子顺序已核实（basic 在 super() 构造器注册，外层 waterfall）。

---

## 二、P2 发现（8 项，均已给出修复方案）

### P2-1 SQLite 句柄未接入生命周期 ⚠️ Top 风险
`Service.init` 建库（memory-context.ts:72-100），但全 src 无任何清理路径调 `MemoryStore.close()`（close 存在于 memory-store.ts:289-293）。热重载/反复启停泄漏 db+WAL 文件锁，**Windows 下直接阻碍插件目录更新**。

**修复（已核实正确写法）**：本 cordis 版本 `Service` 类**没有** `disconnect` 符号（vendor/cordis/lib/types/service.d.ts:12-25 仅有 init/check/config/invoke/extend/tracker/resolveConfig）——在 `[Service.init]` 创建 store 后注册：
```ts
this.ctx.effect(() => () => this.store?.close(), 'close memory store')
```
（`ctx.effect` 执行体返回 disposer，UNLOADING 阶段自动运行，fiber.d.ts:157；与官方文档最佳实践一致。）

### P2-2 压力计量双轨制：启发式忽略图片/非文本块
`estimateMessageTokens`（memory-compaction.ts:532-540）只计 role+text，图片块按 0 token；fallbackTruncate 估算同源（:722-726）。图像重载会话中渐进压缩系统性偏晚，硬保障实际落在 compaction-basic + overflow 恢复。
**修复**：image 块加固定成本（~1500 tok）或改用 `ctx.tokenMeter`。

### P2-3 压缩器摘要不落库 + 第二丢弃顺位
`compress()` 产物（`[Compressed history —`，:385-448）无 `storeMemory` 调用（对比 basic 路径 :912-916 会存 mid）；fallbackTruncate Phase 2（:742-748）超预算时整条丢弃 → 该时段唯一压缩记录可能永久丢失。
**修复**：compress() 成功后同步 `storeMemory(text, 'mid')`，或把压缩摘要移到丢弃优先级末位。

### P2-4 `retrieval.enabled` 连带关闭两个无关功能
memory-compaction.ts:890 `if (this.retrieval.enabled) this.registerRetrieval(ctx)`，而 **压缩钩子**（:997）和 **CTX 采纳/探测**（:981-988）都注册在其内部。用户关 RAG → 静默失去 Strategy 1 压缩 + 模型窗口自适应。
**修复**：三者为独立关注点，解耦注册。

### P2-5 入库后台工作无界
消毒只截每个字符串字段 2000 字符（OutputSanitizer.ts:77），多字段大 JSON → 无上限 chunk（VectorRetriever.ts:67-83）；5 秒 `Promise.race`（:122-162）只弃权不中止，embed/写库后台继续耗资源，且之后的异常被静默吞掉。
**修复**：单条工具结果总字符上限 + 超时后中止循环 + 内层自带 catch 记日志。

### P2-6 消毒作用域与文档声明不符
文件头声称 sanitize 发生在 "before they enter the context window"（OutputSanitizer.ts:2、memory-compaction.ts:14），实际 tools/result 是事后事件，**无法改写进入当轮上下文的原始结果**（:879-888），消毒只保护向量记忆副本。按字面依赖会误判 token 安全边界。
**修复**：改措辞为 "before entering vector memory"。

### P2-7 `rag_dedupe_exact` 连带关闭模糊层
VectorRetriever.ts:138 `if (dedupeExact && hasTextNormalized(...))`——设 false 会同时关掉精确+模糊两层，与「三层独立」叙事（README.md:15,26）不符。
**修复**：模糊层独立开关或恒开。

### P2-8 rebalance 裸 catch 完全静默
memory-engine.ts:292-293 `catch { pyramid = null }` 无任何日志；摘要器持续失败（如未配 provider）时对用户完全不可见。
**修复**：catch 内加 `ctx.logger.warn`。

---

## 三、P3 发现（按主题分组）

**配置/文档漂移**
- README.md:29/144 宣称 long importance=0.7，实际 long 继承批次 `max(importance)`=0.6（memory-engine.ts:249,255；mid 写死 0.6 于 memory-compaction.ts:914）
- 工具数量口径：实际 10 个（含 memory_ingest），README 写 9，cordis.yml:89-90 注释停留在 5
- rag_min_score 代码兜底 0.2（config.ts:358）与 VectorRetriever.ts:26 注释 "default 0.3" 不一致，实际 0.3 依赖 yml
- maxLong 修剪为硬删除（memory-engine.ts:276-280），types.ts:109 "folded away" 措辞误导
- trigger/target 无交叉校验（config.ts:294-295）；遗忘权重无 sum≤1 校验（config.ts:145-147）

**健壮性**
- 探测 5 秒超时不覆盖响应体：fetch 响应头到达即 clearTimeout（model-probe.ts:53-60），body 读取无界
- 探测失败永久标记该模型（model-context.ts:82-83），瞬时故障无会话内恢复
- consolidate 的 insert+delete 非事务（memory-engine.ts:260-265），中途崩溃留重复（非丢失）；建议 BEGIN/COMMIT
- fallbackTruncate 最后手段截断后可能仍超预算静默返回（:756-770），建议 warn
- 裁剪计量微漂移：beforeTokens 含 role 开销（:535），cut 累加只算正文（:370），每条少 1-2 tok，自纠正
- turn 计数器进程内重置（:224-227），重启后最多延迟 7 轮恢复压缩（已文档化）

**覆盖空白**
- 无 HistoryCompressor 单测（:359-377 切分数学值得表驱动测试）；工具层无单测
- `user`/`feedback` 两类记忆无自动产生者（只有 reference/project）
- mid/long 的 `storeMemory` 不做三层去重（memory-engine.ts:151-168），仅 RAG 路径覆盖
- 审计相似度用词面 Jaccard（:53-63）非 embedding，语义近重复可能漏报
- 语义去重查询用裸 chunk（VectorRetriever.ts:144）而库存文本带 `[source:…]` 前缀（:117），前缀稀释 lightweight 余弦

**死代码/可观测性**
- `MemoryContext.updateModelContext`（memory-context.ts:129-136）全仓库无调用方
- `oldMessages.length === 0` 为不可达分支（memory-compaction.ts:378-383）
- 遗忘结果只报数量不渲染文本（tools.ts:145 vs memory_maintain 有 oneLine 渲染）
- 结构性事实：importance ≥ 0.42 的记忆分数永不低于 0.25 → mid/long 实际只受 cap 约束（符合设计，建议写进文档）

---

## 四、合规亮点（评审确认的设计优点）

- 无幽灵向量：所有删除路径（forget/consolidate/trim/reset）成对 `store.delete + index.remove`
- LLM 失败无数据丢失：金字塔摘要在任何变更之前调用，失败时 mids 原样保留自动重试
- 检索失败不破坏本轮：整钩子 try/catch（memory-compaction.ts:1056-1061）
- denylist 在入库前生效（VectorRetriever.ts:113-116 首个守卫）；allowlist 优先
- memory_reset 强制 confirm；probe fire-and-forget 无未处理拒绝；catalog 给窗口即零网络
- strip-only 语法零违规（无参数属性/enum/namespace/import=）；exactOptionalPropertyTypes 条件展开写法贯穿全库
- 事件监听不泄漏（cordis 事件服务随 fiber 自动 dispose）

## 五、NOT VERIFIED（超出静态+单测范围）

1. DSH 对 `PreStepDecision.enter` 消息的持久化语义（决定 P2-3 的严重度上限）
2. 工具层 cordis 包装的运行时行为、真实 DSH 进程内装载/热重载表现
3. transformers-embedder 的真实模型推理路径

---

## English Summary

**Verdict: no P1 defects; all 12 preset goals met** (G2/G8/G11/G12 fully pass; the rest pass with notes). Core math verified line-by-line: dual-trigger interplay has no dead zone (progressive 59925 < basic 75200, different bases), target-watermark split has no off-by-one, forgetting formula/pyramid merge/BLOB round-trip/kind migration/restart hydration all correct. Runtime-verified: 62/62 tests green, tsc 0 errors.

**8 P2 findings** (all with fixes): (1) SQLite handle never closed — register `ctx.effect(() => () => this.store?.close())` in `[Service.init]` (this cordis has NO `Service.disconnect` symbol); (2) heuristic token metering ignores image blocks; (3) compressor summaries not persisted to memory + second discard priority; (4) `retrieval.enabled` silently disables compression AND context adoption; (5) unbounded ingest work after race timeout; (6) sanitize scope contradicts its doc header; (7) `rag_dedupe_exact` couples exact+fuzzy dedup layers; (8) rebalance bare silent catch.

P3s: doc/config drift (long importance 0.7 vs 0.6; tool count 9 vs 10; min_score default mismatch), robustness gaps (probe body timeout, non-transactional consolidate, silent fallback truncate), coverage blanks (no HistoryCompressor/tool tests, no auto-producer for user/feedback kinds), dead code (`updateModelContext`), observability (forgetting reports counts only).

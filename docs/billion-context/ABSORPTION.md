# billion-context 吸纳对照表（Absorption Map）

> 本表是 [`UPSTREAM.md`](UPSTREAM.md) 的姊妹篇：UPSTREAM 记录「上游是谁、如何紧随」，本表记录「上游有什么、我们对应什么、哪些不采纳、为什么」。
> 每次刷新快照后，先更新本表，再决定是否落地实现。

**状态口径**：

| 标记 | 含义 |
| --- | --- |
| ✅ 已吸纳 | 本插件已有等价能力（引擎层实现，非代理） |
| 🟡 部分 | 有能力但口径/覆盖面不同，差异在「取舍」列写明 |
| ⛔ 未吸纳 | 有意不做，理由在「取舍」列 |
| 🚫 结构性不适用 | 该能力依赖代理/网络层，本插件架构下无对应物 |

---

## 1. 上下文管理工具（upstream 的四个注入工具）

上游在对话里注入 4 个工具（`PLUGIN.md` manifest `toolNames`），模型自主调用；本插件不注入同名工具，改用自有的 `memory_*` 工具面（DSH 工具注册，语义等价）。

| 上游工具 | 语义 | 本插件对应 | 状态 | 取舍 |
| --- | --- | --- | --- | --- |
| `compress` | 把一段消息范围折叠成详细摘要 | `MemoryCompactionEngine.compress()`（自动，最旧优先、渐进折叠）+ `memory_force_compress`（手动，整段历史） | ✅ | 范围选择交给引擎（progressive oldest-first + 目标水位），而非模型指定 range。模型手动兜底用 `memory_force_compress`。 |
| `decompress` | 需要精确细节时恢复某个已压缩范围 | `folded_ranges` 表 + `memory_expand ref=fl_…`（本轮新增） | ✅ | 上游把折叠范围原地还原进历史；本插件把原文存进 store，模型按 ref 取回（等价且更安全：不动 surface、不破坏前缀缓存）。 |
| `search_context` | 在压缩摘要与可见消息中关键词检索 | `memory_search`（语义检索各级摘要）+ `memory_expand`（`tr_`/`fl_` 关键词扫描） | 🟡 | 上游把「可见消息」也纳入关键词扫描；本插件的可见消息本来就在上下文里（无需检索），检索面覆盖已折叠内容。 |
| `acp_status` | 上下文用量概览 + 哪些区间仍可压缩 | `memory_status`（层数/预算/遗忘策略/模型窗口 + usage ledger + foldedRanges 统计） | ✅ | 「仍可压缩区间」以 token 压力（trigger/target water level）表达，不列出具体 range。 |
| `absorb`（条件注入） | 即时压缩超大 tool result | `tool_absorb`（digest stub + 记忆摄取） | ✅ | 上游是 kernel API；本插件是工具结果拦截 + 摘要摘要。 |
| `acp_cache` | 缓存报告（GRAND LEDGER / FOLD ECONOMICS / LINE ITEMS / MODEL SWITCHES） | `memory_status.usage`（totals + cacheHitRate + 按 provider/model 分桶） | 🟡 | 无 per-fold economics、无 web UI 折线图；MODEL SWITCHES 以「per-model 分桶 + cacheHitRate 对比」等价呈现。 |
| `acp_summary` / `acp_summary_*` | 摘要读回引用 | 压缩摘要本身即 `mid` 记忆，可被 `memory_search` 召回 | 🟡 | 不单独提供 ref 读回；摘要就是记忆。 |
| `acp_rule`（条件注入） | 规则工具 | 无 | ⛔ | 低价值；规则面由 DSH 系统提示与本插件指令承担。 |

## 2. 压缩机制（acp-kernel 增量分层压缩）

| 上游能力 | 本插件对应 | 状态 | 取舍 |
| --- | --- | --- | --- |
| 增量压缩（小范围折叠，摘要保持在历史里直到恢复） | `compress()` 渐进折叠（只折最旧的、到目标水位即停） | ✅ | 同口径。 |
| 可逆（`decompress`） | `folded_ranges` + `memory_expand ref=fl_…` | ✅ | 本轮新增。 |
| 前缀缓存友好 | 只改写每会话屏障（`lastPassSeq`）之后的新增节点；完整重写仅在压缩时 | ✅ | 比上游更严：上游重写请求体不涉及宿主缓存语义。 |
| 分层（`compress.tiers`） | 记忆金字塔 short/mid/long + 合并阈值 | ✅ | 不同实现：上游是折叠分层，本插件是记忆分级。 |
| 保留近期（`preserveRecentMessages/Tokens`） | `retain_recent_messages: 4` + `retainTokens` | ✅ | 同口径。 |
| 保护工具（`protectedTools` 等） | `rag_ingest_denylist`（memory_*/todo_*/meta 工具不摄取） | 🟡 | 上游保护的是「不被折叠」；本插件保护的是「不被摄取为记忆」。折叠侧由 `retain_recent_messages` 兜底。 |
| 思维保护（`reasoningGuard`） | `thinking_guard_enabled`（mid-thinking 守卫） | ✅ | 同口径。 |
| 紧急阈值（`emergencyThresholdPercent` / `maxContextLimit`） | `compaction_dynamic_threshold` + `compaction_dynamic_floor` + `maxOverflowRetries` | ✅ | 动态阈值按模型窗口/本地探测调整。 |
| 优雅增长提醒（`compress.nudgeGrowthTokens`，~50K 步长） | `compress_nudge`：增长 EMA 预测下一请求将过线则提前压缩 | 🟡 | 上游是固定步长提示（让模型自己决定何时压）；本插件是阈值锚定的预测触发（自动压早一步）。两者互补：本插件默认路径是自动。 |
| 预检硬底线（#470，输入超窗口兜底） | `maxOverflowRetries` + 溢出重试 | ✅ | 同口径。 |
| 失败冷却 | `COMPRESS_FAILURE_COOLDOWN = 3` 轮 | ✅ | 同口径。 |
| 压缩后摘要不可用则拒收（「摘要更小」检查） | `saved <= 0` 拒收 + 冷却 | ✅ | 同口径。 |

## 3. CCR（tool result 压缩）与吸收

| 上游能力 | 本插件对应 | 状态 | 取舍 |
| --- | --- | --- | --- |
| `compress.ccr`：tool result 存档 + ref | `tool_archive`：`tr_` ref + head/tail stub | ✅ | 同口径。 |
| `compress.absorb`：即时吸收超大 tool result | `tool_absorb`：signal-line digest 作为 stub + 摄取为记忆 | ✅ | 同口径（本轮 ② 已实现）。 |
| `BILI_CCR_RETRIEVAL_TTL_MS`：CCR 检索 TTL | 无（存档不参与检索，仅 ref 读回） | ⛔ | 本插件的检索面是记忆金字塔，不是 CCR 存档。 |
| 历史图片剥离（`stripImages`） | 无 | ⛔ | 本插件不处理图片块（DSH 文本为主）。 |

## 4. 会话身份与继承

| 上游能力 | 本插件对应 | 状态 | 取舍 |
| --- | --- | --- | --- |
| 会话 id 识别（header/body/prompt_cache_key，`src/session-id.ts`） | DSH `Session` 对象（`session.id`、`exec.agent.session.id`） | 🚫 | 进程内插件直接拿到会话对象，无需协议识别。 |
| 匿名前缀亲和（`src/prefix-affinity.ts`，#309/#1262） | 无 | 🚫 | 代理层补救无会话 id 客户端的问题，DSH 恒有会话 id。 |
| 派生子会话继承父会话压缩上下文（#1333/#1362，depth 8） | 全局 SQLite store：任何会话可检索任何记忆 | 🟡 | 口径更强（全局 vs 谱系链）；代价是无隔离。可按 `source_session_id` 过滤（store 支持）。 |
| 粘性路由（只转发客户端提供的 id） | 无 | 🚫 | 无上游转发。 |
| 未识别端点透明转发（#1290） | 无 | 🚫 | 无代理。 |

## 5. 缓存与用量报告

| 上游能力 | 本插件对应 | 状态 | 取舍 |
| --- | --- | --- | --- |
| 每请求缓存命中率日志（`[acp-usage]`） | `usage_events`（llm_requests/input/output/cacheRead/cacheWrite） | ✅ | 同口径。 |
| 缓存健康判定（95-97% 基线） | `cacheHitRate = cacheRead/(input+cacheRead+cacheWrite)` | 🟡 | 无健康阈值判定，只报事实。 |
| MODEL SWITCHES（#1535，切换模型重计费） | `usage.models` 分桶（provider/model 归因，本轮新增） | ✅ | 以「per-model 分桶 + 命中率对比」呈现，不单列事件。 |
| FOLD ECONOMICS（每次折叠的净节省） | `compaction_saved_tokens`（按次累加） | 🟡 | 不按折叠分组。 |
| web UI 折线图 / `/acp-cache` | `memory_status`（JSON，工具输出） | 🟡 | 无 web UI；DSH 工具面已覆盖。 |

## 6. 配置键对照

| 上游键（CONFIGURATION.md） | 本插件键 | 状态 |
| --- | --- | --- |
| `compress.tiers` | 记忆金字塔 `pyramid.*` + `budget.*` | ✅ |
| `compress.nudgeGrowthTokens` | `compress_nudge`（EMA，非固定步长） | 🟡 |
| `compress.preserveRecentMessages/Tokens` | `retain_recent_messages` / `retainTokens` | ✅ |
| `compress.minCompressRangeChars/Range` | `tool_absorb_min_chars` / `tool_archive_threshold_chars` | 🟡 |
| `compress.protectedTools` 等 | `rag_ingest_denylist` | 🟡 |
| `compress.absorb` | `tool_absorb*` | ✅ |
| `compress.ccr` | `tool_archive*` | ✅ |
| `compress.search` | `memory_search` + `memory_expand` | 🟡 |
| `compress.reasoningGuard` | `thinking_guard_enabled` | ✅ |
| `compress.modelContextLimit/maxContextLimit/emergencyThresholdPercent` | `contextWindow` / `modelWindows` / `compaction_dynamic_*` | ✅ |
| `compress.prompts/promptPack` | `summarizationProvider/Model`（prompt 不可配） | ⛔ |
| `compress.imageCompression/stripImages/imageBilling` | 无 | ⛔ |
| `compress.outputSteering` | 无 | ⛔ |
| `compress.rules` | 无（DSH 系统提示承担） | ⛔ |
| `injectTool` / `injectNudge` | `compress_nudge`（nudge 注入由引擎层触发） | 🟡 |
| `debug` / `logFile` | DSH 日志（`ctx.logger`） | 🚫 |
| `port` / `host` / `proxy` / `compat` / `passthrough` / `imageBilling` | 无 | 🚫 |
| `autoUpdate` / `advisoryCheck` / `autoRestartOnUpdate` | 无（npm 部署） | 🚫 |
| `BILI_SESSION_GC*` | `usage_retention_days` / `tool_archive_retention_days` / `fold_range_retention_days` + forgetting | 🟡 |
| `BILI_ENCRYPTION_KEY` / `BILI_PERSIST_ZSTD` | 无（DSH storage-sqlite） | 🚫 |
| `BILLION_CONTEXT_NATIVE`（共存标记） | 无（bili-native 已禁用） | 🚫 |

## 7. 冲突评估与取舍（bili 与本插件共存）

### 7.1 实测证据（2026-09-29）

- profile `package.json` 的 `dsh.profile.bundles` 同时列 `dsh-infinite-context` 与 `billion-context`（两者都被装）。
- profile `cordis.patch.yml`：`- id: bili-native` → `disabled: true`（**bili 的 DSH 原生插件当前禁用**）。
- 进程检查：无 bili proxy 进程在运行（`BILLION_CONTEXT_PROXY` 未生效）。
- 本插件 `bundle.patch.yml`：`- id: compaction-basic` → `disabled: true`，改用 `memory-compaction`（id 不同）。
- bili 的 `dsh.bundle.patch.yml`：`- id: compaction-basic` → `config: { auto: false }`。

### 7.2 冲突判定

| 冲突点 | 判定 | 依据 |
| --- | --- | --- |
| `compaction-basic auto: false` 会不会关掉我们的自动压缩？ | **不会** | 我们的 `bundle.patch.yml` 已把 `compaction-basic` 整体 `disabled: true`，压缩引擎是独立 id `memory-compaction`（`auto: true`）。bili 的补丁改的是一个已被禁用的插件。 |
| 启用 `bili-native` 会怎样？ | **双重压缩** | bili 代理折叠请求历史 + 我们 `memory-compaction` 自动折叠，两者独立触发，会重复摘要、丢失细节。bili 自己 README 也警告 OpenCode 需要 `compaction.auto: false` 避免同样问题。 |
| 会话状态存储冲突？ | **无** | bili 用 `~/.local/share/billion-context/`（会话文件），我们用 SQLite 单文件，互不读写。 |
| 端口/代理冲突？ | **无** | 本插件无网络层；bili 的 proxy 仅在启用时启动。 |
| 工具名冲突？ | **无** | bili 注入 `compress`/`decompress`/`search_context`/`acp_status`；我们注册 `memory_*`，无重名。 |

### 7.3 决策

1. **保持 `bili-native: disabled`**。本插件已引擎层吸纳其全部核心能力；启用只会带来双重压缩。
2. **保留 `billion-context` 依赖不删**：作为功能参照与升级通道（上游仍在快速迭代，0.1.153 → 0.1.169），便于随时对比。
3. **`compaction-basic` 的禁用不动**：这是我们自己的压缩后端契约，不随上游补丁变化。
4. **若将来要启用 bili-native**：必须先关掉 `memory-compaction` 的 `auto: true`（或整插件），并重新评估会话状态归属。

## 8. 版本对照记录

| 日期 | 上游版本 | 快照 README sha | 本轮新增吸纳 |
| --- | --- | --- | --- |
| 2026-09-29 | npm 0.1.169（本机装 0.1.153），HEAD `846548b` | `c113a5725521274e` / `d9cf2e5d5eb44f44` | `decompress`（folded_ranges + memory_expand）、per-model usage 分桶（MODEL SWITCHES）、memory_search 关键词扫 folded、acp_status foldedRanges |

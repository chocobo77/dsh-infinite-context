# dsh-infinite-context

DeepSeek Harness 的上下文智能压缩插件。它把长会话的请求规模控制在模型窗口内，同时保留被移除内容的可检索副本。

## 中文

### 做什么

- 分层记忆：对话摘要、工具结果和运行中记录的要点分开存放，按相关度注入。
- 可逆压缩：折叠前把原消息写入 `folded_ranges`，摘要保留 `fl_` 引用，`memory_expand ref=...` 可以取回原文。
- 按阶段压缩：触发水位看当前处于回合开始、回合结束还是工具循环，也看会话成熟度。工具循环中推迟，回合边界可以提前；水位限制在预算的 0.65–0.92。
- 单一水位：durable 与 fold 两条路径共用一套触发曲线和目标带，不会在同一水位重复压缩。
- 预算保护：按路由模型的实际窗口和输出预留计算预算；预留过大时保留至少 50% 的提示空间，不让折叠退化成 1 token。
- 工具结果归档：压缩前把超长结果替换成可检索的桩，全文留在归档里。
- 计量：逐请求记录注入、压缩节省、缓存读写和归档字符数。

### 安装

需要 Node.js >= 22.19.0 和 DSH 0.2.x。

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

也可以把 `bundle.patch.yml` 和 `cordis.yml` 合并进目标 profile。

### 配置

配置项在 `cordis.yml`。`compaction_governance` 默认开启；`compress_dynamic_levels` 只为兼容保留，不再生效。

### 兼容性

- 压缩通过 `compaction-basic` 的 `compactRegion` 重写会话表面。
- 本地模型只支持特定推理档位时，压缩调用沿用会话当前的 `reasoningEffort`。
- `maxTokens` 接近窗口时，预算会保留至少 50% 的提示空间。

### 许可

MIT

## English

A context governance plugin for DeepSeek Harness. It keeps long sessions within the model window and keeps a retrievable copy of what was removed.

### What it does

- Layered memory: summaries, tool results and notes recorded during a run are stored separately and injected by relevance.
- Reversible compaction: before folding, the original messages are written to `folded_ranges`; the summary keeps an `fl_` reference and `memory_expand ref=...` returns the original text.
- Phase-aware compaction: the trigger depends on whether the session is at a turn start, a turn end or inside a tool loop, and on how mature the session is. Tool loops defer, turn boundaries can advance; the level stays within 0.65–0.92 of the budget.
- Single water level: the durable and fold paths share one trigger curve and target band, so they do not compact twice at the same level.
- Budget guard: the budget uses the routed model's window and completion reserve; when the reserve is too large, at least 50% of the window is kept for the prompt instead of collapsing to one token.
- Tool-result archive: oversized results are replaced by retrievable stubs before compaction; the full text stays in the archive.
- Measurement: per-request records for injection, compaction savings, cache reads/writes and archived characters.

### Install

Requires Node.js >= 22.19.0 and DSH 0.2.x.

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-infinite-context-<version>.tgz
```

Alternatively, merge `bundle.patch.yml` and `cordis.yml` into the target profile.

### Configuration

Settings live in `cordis.yml`. `compaction_governance` is on by default; `compress_dynamic_levels` is kept for compatibility and no longer has an effect.

### Compatibility

- Compaction rewrites the session surface through `compaction-basic`'s `compactRegion`.
- When a local model only accepts specific reasoning levels, compaction calls use the session's current `reasoningEffort`.
- When `maxTokens` is close to the window, the budget keeps at least 50% of the window for the prompt.

### License

MIT

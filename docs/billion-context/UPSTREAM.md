# billion-context 上游追踪（长期目标）

> EN one-liner: this directory pins the upstream `ranxianglei/billion-context` README and records how we keep following it. The plugin re-implements its context-management behaviour at DSH's **engine layer** (no HTTP proxy).

上游仓库：<https://github.com/ranxianglei/billion-context#readme>

---

## 1. 上游是谁

| 项 | 值 |
| --- | --- |
| 仓库 | `ranxianglei/billion-context`（默认分支 `master`） |
| 定位 | 面向长寿编程 Agent 的上下文管理器：模型驱动增量分层压缩（ACP, Agentic Context Protocol） |
| 形态 | 反向代理（把客户端 base URL 指过来）+ 客户端原生插件（pi / omp / opencode / dsh / kimi / hermes / zcode） |
| 语言 / 依赖 | TypeScript，运行时依赖仅 `zod` |
| 许可 | MIT **外加一条附加条款**（终端用户可见产品须署名，见 §6） |
| 本机已安装副本 | `<DSH_HOME>\profiles\<profile>\node_modules\billion-context`，版本 `0.1.153` |
| 已发布产物结构 | 自包含 bundle（`dist/index.js`、`dist/agent/opencode-native.js`、`dist/agent/dsh-native.js`），**不暴露可复用的模块 API** |
| 论文 | “Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents”（仓库 `paper/`） |

## 2. 我们为什么追踪它

本插件（`dsh-infinite-context`）与 billion-context 解决同一个问题：**单次会话远长于模型上下文窗口时，如何让 Agent 不失忆、又不爆窗口**。两者路线不同：

- billion-context：**进程外代理**，改写请求/响应流，向对话注入 `compress` / `decompress` / `search_context` / `acp_status` 四个工具，由模型自主压。
- 本插件：**进程内 DSH 插件**，在 `agent/pre-step`、`tools/result`、压缩引擎回调等引擎接缝上工作，靠多级记忆金字塔 + 检索注入 + 压缩后端。

因此我们把上游当作**设计与功能的参照系**：

1. 上游新增的、对“长寿会话”确有价值的能力，评估后在本插件内以引擎层方式实现等价物（见 `ABSORPTION.md`）。
2. 上游修复的缺陷、调整的阈值/启发式，作为我们参数与策略的外部证据。
3. 上游的协议级/代理级特性（URL 改写、出站代理、自更新、会话 id 识别）在本插件架构下无对应物，明确记为「结构性不适用」，不做无用仿制。

## 3. 快照清单与校验（pinned）

本目录下的两份 README 是上游 `master` 的**逐字节快照**，用于离线比对与追溯。

| 文件 | 上游路径 | 字符数 | sha256_16 |
| --- | --- | --- | --- |
| `README.md` | `README.md` | 39,647 | `c113a5725521274e` |
| `README.zh-CN.md` | `README.zh-CN.md` | 25,446 | `d9cf2e5d5eb44f44` |

快照时的上游状态：

- 抓取时刻 `master` HEAD：`846548bee8e9fc004b204c9e17af48dfab403a6c`（2026-09-29T00:10:54Z，`Merge pull request #1625 … abort-rewind-cache-seam`）
- 上述两份 README 的最后一次内容变更提交：`54e8ade6667aabc1d0f4f6422a9b83ac4bdb81ff`（2026-09-28T11:40:59Z）
- 抓取时刻 `master` 与快照**逐字节一致**（sha256 已复核），因此本快照即当时的 README 全文。

## 4. 刷新流程（每次迭代开始前 / 上游发版后）

1. 取上游 HEAD 与时间：

   ```
   https://api.github.com/repos/ranxianglei/billion-context/commits?per_page=1
   ```

2. 拉取两份 README 原文：

   ```
   https://raw.githubusercontent.com/ranxianglei/billion-context/master/README.md
   https://raw.githubusercontent.com/ranxianglei/billion-context/master/README.zh-CN.md
   ```

3. 与 §3 的 sha256_16 比对：

   - **一致** → 本轮无需更新快照，直接进入功能对照（§5 的边界不变）。
   - **不一致** → 覆盖本目录快照，更新 §3 表的字符数与 sha256_16、HEAD 与日期，然后**逐节 diff 旧快照**，把新增/变更的能力补进 `ABSORPTION.md`，再决定是否落地实现。

4. 快照刷新时同时看一眼上游 `CHANGELOG.md` 与 `docs/`（上游把不少细节放在 `CONFIGURATION*.md`、`SESSION-IDENTITY.md`、`MESSAGE-IDENTITY*.md` 等文件里，README 只给入口）。

5. **每次刷新都在 §7 记一行**（日期 / HEAD / README 是否变化 / 结论），使“长期紧随”可审计。

建议节奏：每个开发轮次开始时跑一次第 1–3 步；上游 README 有变、或本机 `billion-context` 版本号上升时，必须重跑功能对照。

## 5. 追踪范围与边界

**吸收方式**：引擎层等价实现。不引入代理、不改写客户端 base URL、不监听端口、不注入上游那四个工具名（本插件用自己的 `memory_*` 工具面，见 `ABSORPTION.md`）。

已确定的取舍原则：

1. 上游靠代理才能拿到的信息（原始 HTTP 请求体、客户端声明的会话 id、响应流），在进程内插件里由 DSH 运行时直接提供，**用宿主能力替换，不复制代理逻辑**。
2. 上游会**改写历史消息**以腾出窗口；本插件改写时严格保护 provider 前缀缓存（只动每会话屏障之后的新增节点），这是与上游不同的硬约束（详见 `ARCHITECTURE.md` §12）。
3. 上游工具面是“模型自主压”；本插件以“自动压 + 模型手动兜底”组合。两者都要，但手动工具只作为逃生门，默认路径是自动。

## 6. 署名与许可

上游许可是 **MIT + 一条附加条款**，附加条款原文（中文版）：

> 本项目采用 MIT 许可**外加一条附加条款**：任何终端用户可见或可交互、且使用了本软件的产品或服务（无论商业或开源），须在其首页、文档或“关于/致谢”页面中注明该产品使用了 billion-context，并附指向本仓库的链接；纯服务端/内嵌用途随附文档声明即可。

本插件**未复制上游代码**（上游产物是自包含 bundle，无可复用模块接口），所有能力为独立实现；但对齐的概念、工具语义与文档结构来自上游，因此按更严格的口径处理：

- 在本仓库根 `README.md` 的致谢/参考一节署名并链接上游仓库；
- 在 `ARCHITECTURE.md` 与 `ABSORPTION.md` 中标注每个能力的上游出处；
- 不搬运上游文案（避免不一致的承诺），仅引用工具名、配置键等标识符以作对照。

## 7. 追踪日志

| 日期 | 上游 HEAD | README 变化 | 结论 |
| --- | --- | --- | --- |
| 2026-09-29 | `846548b` | 无（与快照逐字节一致） | 建立快照与追踪机制；写出首版功能对照表 `ABSORPTION.md` |


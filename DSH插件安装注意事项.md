# DSH 插件安装注意事项

> 适用范围：`deepseek-harness`（DSH）自装插件，特别是 `dsh-infinite-context`。
> 关联文档：`DSH启动失败排查记录.md`（tsx 启动问题的历史排查）。

## 1. 插件是怎么被加载的

- DSH 的 web profile 根配置是 `C:\Users\Administrator\.dsh\profiles\web\cordis.yml`（内容只有 `[]`），实际树由补丁 `cordis.patch.yml` 组装。
- 插件的三个入口在 `cordis.patch.yml` 里以 **`file:///` 绝对路径**直接引用 `.ts` 源文件：
  - `plugins/dsh-infinite-context/src/memory-context.ts`（memory-context）
  - `plugins/dsh-infinite-context/src/memory-compaction.ts`（memory-compaction）
  - `plugins/dsh-infinite-context/src/tools.ts`（memory-tools）
- DSH 启动时，由 **Node.js v24.19.0** 直接执行这些 `.ts` 源文件，走的是 Node 原生 **TypeScript 类型剥离（strip-only）**，**不做完整编译、不经 tsx**。
- 插件依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm` 等）从 harness 的 `D:\Program files\deepseek-harness\vendor` 解析，不在 `profiles/web/node_modules` 里。

## 2. 本次修复的 Bug（2026-08-29）

### 现象
```
Error: dsh: plugin tree failed to load: ... failed to import loader entry memory-context
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
    at ... model-context.ts:39
      constructor(
        private readonly fallbackWindow: number,
        ...
DSH failed
```

### 根因
Node 24 的 strip-only 类型剥离**不支持 TypeScript 参数属性**（在构造函数参数上直接写 `private` / `public` / `protected` / `readonly` 来声明字段的语法）。
`dsh-infinite-context/src/model-context.ts` 的 `ModelContextTracker` 构造函数用了这种写法，导致该文件解析即失败，整个插件树加载失败，DSH 启动即崩。

### 修复内容
1. `plugins/dsh-infinite-context/src/model-context.ts`
   - 把 `constructor(private readonly fallbackWindow: number, private readonly probeEnabled: boolean)` 改成**显式类字段声明 + 构造体内赋值**（行为完全等价，已验证）。
   - 这是全插件唯一一处参数属性；已全量扫描其余文件，无 `enum` / `namespace` / `import =` 等其它 strip-only 不支持的语法。
2. 新增 `plugins/dsh-infinite-context/package.json`
   - 内容仅 `{ "name": "dsh-infinite-context", "private": true, "type": "module" }`。
   - 消除 `MODULE_TYPELESS_PACKAGE_JSON` 警告（ESM 重解析的性能开销）。
   - **注意**：不要把这行 `"type": "module"` 加进 `profiles/web/package.json`——该目录下有大量 node_modules CJS 包，全局改会大面积破坏依赖解析。

### 验证结果
- 用 `C:\Program Files\nodejs\node.exe`（v24.19.0）单独加载 `model-context.ts`：通过，行为测试全绿（fallback、adopt、probe-once、参数校验）。
- 在 web profile 目录下 import 三个入口模块：全部加载成功，无 TS 语法错误、无类型警告。
- 实际启动 `node apps/cli/lib/bin.js web`：正常输出 `dsh web: http://127.0.0.1:3080`，无 plugin tree 报错。

## 3. 编写 / 修改插件时的硬性约束

| 项目 | 要求 |
|---|---|
| Node 版本 | 必须用 v24.19.0（`C:\Program Files\nodejs\node.exe`）。PATH 里可能另有 v20，启动验证时注意别用错。 |
| 模块格式 | `.ts` 一律按 ESM 写；相对导入**必须带 `.ts` 扩展名**（如 `import ... from './types.ts'`）。 |
| 禁止语法（strip-only 不支持） | ① 参数属性：`constructor(private readonly x: T)` → 改用类字段 + 赋值；② `enum`；③ 带运行时代码的 `namespace`；④ `import x = require(...)`、`export =`。 |
| 类型导入 | `import type` 是安全的（会被剥离）。 |
| 消除 ESM 警告 | 在**插件自己的目录**建 `package.json` 声明 `"type": "module"`；不要动 `profiles/web/package.json`。 |
| 插件注册 | 改 `cordis.patch.yml`，用 `file:///C:/Users/Administrator/.dsh/profiles/web/plugins/<插件>/src/<入口>.ts` 的绝对路径。 |
| 持久化 | 该插件数据在 `C:/Users/Administrator/.dsh/storages/dsh-infinite-context.db`（SQLite），删库即清空记忆。 |

## 4. 验证 / 重启 DSH

- 在 `D:\Program files\deepseek-harness` 目录执行（优先用编译产物，绕过 tsx）：
  ```
  node apps/cli/lib/bin.js web
  ```
  看到 `dsh web: http://127.0.0.1:3080` 即成功。
- 已有自动重启脚本：`D:\code\DSH\restart-dsh-plugins.ps1`（按 3080 端口所有者杀进程树后重启，并轮询端口自检）。

## 5. 常见启动失败对照

| 报错关键词 | 含义 | 处理 |
|---|---|---|
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` / `parameter property is not supported` | 插件 `.ts` 用了 strip-only 不支持的语法 | 按第 3 节改造对应文件 |
| `ERR_MODULE_NOT_FOUND ... 'tsx'` | tsx 符号链接在子进程解析失败（历史问题） | 改用编译产物 `node apps/cli/lib/bin.js web` |
| `MODULE_TYPELESS_PACKAGE_JSON` | 找不到 ESM 类型声明，触发重解析 | 插件目录内加 `"type": "module"` 的 package.json |
| `EADDRINUSE` | 3080 端口已被旧进程占用 | 按端口杀进程树后重启（见 `restart-dsh-plugins.ps1`） |

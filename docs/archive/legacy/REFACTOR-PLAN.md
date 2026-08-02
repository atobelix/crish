# Crish 重构计划

> 本文档为系统性技术债清理与产品架构收敛计划。所有改造遵循"单一真相源"原则，不保留过渡兼容代码。
> 创建日期：2026-07-16

> **【顶部加注 · 2026-07-16 修订】**
>
> 1. **P0「整目录删除 `apps/agent-workbench/src/shared`」范围已作废。** CLI（`src/cli`）仍依赖 `shared` 中的 workbench-contract、task-controller、workbench-config、runtime-bridge 等模块；删除必须以 CLI 依赖图为准，**禁止**无差别清空 `shared`。
> 2. **Preact UI 删除**（`components` / `core` / `styles` 等）以仓库**当前代码**为准：进行中或已完成均以 tree 实况判断，不以本文历史勾选为真相。
> 3. 产品 UI / 架构请以根目录 `README.md` 与 `ARCHITECTURE.md` 为准。

---

## 一、决策依据与事实证据

### 1.1 双 UI 路径并存的现状

项目当前同时存在两套互斥的前端实现：

| 维度 | apps/crish-desktop | apps/agent-workbench/src/{components,core,styles} |
|---|---|---|
| 框架 | React 19 + zustand + immer | Preact + 自写观察者模式 (appState) |
| Tauri 是否加载 | 是（[tauri.conf.json](apps/agent-workbench/src-tauri/tauri.conf.json) `frontendDist: "../../crish-desktop/dist"`） | 否（仅 `dev:legacy-ui` 走 vite 单独跑） |
| 样式系统 | [index.css](apps/crish-desktop/src/index.css) 单文件 neutral grays | [styles/tokens.css](apps/agent-workbench/src/styles/tokens.css) 三层 Token 体系（Primitive/Semantic/Component） |
| 状态层 | [layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts) zustand | [app-state.ts](apps/agent-workbench/src/core/app-state.ts) 自写观察者 |

### 1.2 活跃编辑判定（基于 git 历史）

| 路径 | 最近一次提交 | 提交频率 |
|---|---|---|
| `apps/crish-desktop/src` | `2dfd901b` 2026-07-16（今日） | 近 20 个 commit 全为 UI/产品改造，7 月日均多次提交 |
| `apps/agent-workbench/src/{components,core,styles}` | `1cb8130f` 2026-07-15 | 7 月以来仅 4 个文件被动过（ChatPanel/GlobalSearch/SettingsTab/sidebar.css） |

**关键反证**：commit `1cb8130f` 的 message 写"右侧专业文件管理器：预览/编辑/评论"，看似改 agent-workbench，但 `git show --stat` 显示实际 diff 全在 `apps/crish-desktop/*`，agent-workbench 仅改了 Rust 一侧（fs_commands.rs / main.rs / tauri-command-registry.ts）。说明 commit message 把目录写错了，真实工作量全在 crish-desktop。

### 1.3 最终决策

| 决策项 | 选择 | 依据 |
|---|---|---|
| 产品 UI 真相源 | **apps/crish-desktop**（React 19） | git 历史证实为活跃维护方；Tauri 实际加载方 |
| Rust 壳层 | **保留 apps/agent-workbench/src-tauri** | 仍是 Tauri 入口，不可删除 |
| CLI 入口 | **保留 apps/agent-workbench/src/cli** | 仍提供开发诊断路径 |
| 待删除代码 | **apps/agent-workbench/src/{components,core,shared,styles,main.tsx,styles.css}** | 死代码，Tauri 不加载 |
| 样式设计语言 | **crish-desktop/src/index.css 的 neutral grays** | 用户明确指定；与"克制、去色、去品牌喧开"的产品调性一致 |

---

## 二、改造阶段总览

按严格依赖关系组织，**前一阶段未完成不进入下一阶段**。

```
P0 路径收敛（死代码清除）
   │
   ├─→ P1 样式真相源统一
   │       │
   │       └─→ P2 数据/错误/命令收敛
   │               │
   │               └─→ P3 文档同步与测试基建
```

| 阶段 | 目标 | 优先级 | 风险 |
|---|---|---|---|
| P0 | 物理删除死代码，依赖收敛 | 高 | 低（删除不被加载的代码） |
| P1 | 样式单一真相源，消除组件级 `!important` 覆盖 | 高 | 中（涉及视觉回归） |
| P2 | Store 数据真相源、错误处理、Tauri 命令收敛 | 高 | 中（涉及运行时行为） |
| P3 | 文档同步、补测试、CI 校验 | 中 | 低 |

---

## 三、P0：双 UI 路径收敛

### P0.1 删除 agent-workbench 的 Preact UI 死代码

**目标**：物理移除 Tauri 不加载的整套 Preact 实现，消除"两套 UI"的认知噪音。

**待删除文件/目录**：
```
apps/agent-workbench/src/
├── components/           ← 全部删除（App.tsx / ChatPanel.tsx / Sidebar.tsx / RightSidebar.tsx / CommandPalette.tsx 等 ~30 个文件）
├── core/                 ← 部分删除
│   ├── app-state.ts          ← 删除（zustand 替代）
│   ├── app-state-cursor.test.ts ← 删除
│   ├── bridge-utils.ts       ← 删除
│   ├── core-event-json-adapter.ts ← 删除
│   ├── daemon-direct-bridge.ts ← 删除
│   ├── daemon-websocket-client.ts ← 删除
│   ├── event-bus.ts          ← 删除
│   ├── message-pipeline.ts   ← 删除
│   ├── message-pipeline.test.ts ← 删除
│   ├── runtime-event-projector.ts ← 删除
│   ├── runtime-event-projector.test.ts ← 删除
│   ├── storage.ts            ← 删除
│   ├── tauri-bridge.ts       ← 保留（CLI 仍在用）
│   ├── tauri-command-registry.ts ← 保留（CLI 仍在用）
│   └── tauri-command-registry.test.ts ← 保留
├── shared/               ← 部分删除
│   ├── background-command-bridge.ts ← 删除
│   ├── background-tasks.ts    ← 删除
│   ├── chinese-text-regression.test.ts ← 保留（中文编码守卫）
│   ├── disclosure-diagnostics.ts ← 删除
│   ├── disclosure-diagnostics.test.ts ← 删除
│   ├── output-references.ts   ← 删除
│   ├── output-references.test.ts ← 删除
│   ├── progress-inference.ts  ← 删除
│   ├── runtime-bridge.ts      ← 删除
│   ├── task-controller.ts     ← 删除
│   ├── task-controller.test.ts ← 删除
│   ├── workbench-config.ts    ← 删除
│   ├── workbench-contract.ts  ← 删除
│   └── workbench-contract.test.ts ← 删除
├── styles/               ← 全部删除（base.css / chat.css / light-theme.css / markdown.css / overlay.css / panels.css / right-sidebar.css / settings.css / shell.css / sidebar.css / subagents.css / tokens.css / tree.css）
├── main.tsx              ← 删除
└── styles.css            ← 删除
```

**保留**：
- `apps/agent-workbench/src/cli/`（CLI 仍提供开发诊断）
- `apps/agent-workbench/src/core/tauri-bridge.ts` + `tauri-command-registry.ts` + `tauri-command-registry.test.ts`（CLI 依赖）
- `apps/agent-workbench/src/shared/chinese-text-regression.test.ts`（中文编码守卫，跨模块共用）
- `apps/agent-workbench/src-tauri/`（Rust 壳层）
- `apps/agent-workbench/index.html`、`vite.config.ts`、`tsconfig.json`（CLI 构建需要）

**验证**：
- `npm run check:core` 全绿
- `npm run dev:workbench` 正常启动（即 Tauri 起来后加载 crish-desktop/dist）
- `npm run cli` 仍可运行

### P0.2 清理 agent-workbench/package.json 依赖

**目标**：移除 Preact 相关依赖，避免 monorepo 依赖污染。

**待删除 dependencies**：
- `preact`
- `preact-iso`
- `highlight.js`（仅 Preact 渲染器用）
- `markdown-it`（仅 Preact 渲染器用）

**待删除 devDependencies**：
- `@preact/preset-vite`
- `@types/markdown-it`

**保留**：
- `react` / `react-dom`（CLI 类型推断可能依赖）
- `@crish/agent-runtime` / `@crish/shared-types`（CLI 直接依赖）
- `@crish/crish-desktop`（workbench 依赖 desktop 的 build 产物）
- `@tauri-apps/api` / `@tauri-apps/cli`
- `@vitejs/plugin-react` / `vite` / `typescript` / `@types/*`

**验证**：`npm install` 无 warning，`npm run cli:check` 通过。

### P0.3 删除 crish-desktop 的脚手架死代码

**目标**：清理 Vite `npm create vite` 残留模板。

**待删除**：
- [apps/crish-desktop/src/App.css](apps/crish-desktop/src/App.css) 整个文件（从 `.counter` 到 `.ticks` 全是默认模板，App.tsx 未引用任何类）
- [apps/crish-desktop/src/assets/react.svg](apps/crish-desktop/src/assets/react.svg)（未引用）
- [apps/crish-desktop/src/assets/vite.svg](apps/crish-desktop/src/assets/vite.svg)（未引用）
- [apps/crish-desktop/src/assets/hero.png](apps/crish-desktop/src/assets/hero.png)（未引用）
- [apps/crish-desktop/public/icons.svg](apps/crish-desktop/public/icons.svg)（确认未被 index.html 引用后删除）

**验证**：`npm run build` 产物体积下降，`npm run dev` 无 404 警告。

### P0.4 统一 package.json scripts

**目标**：消除 monorepo script 层的"legacy"概念。

**改动**：
- 删除 [apps/agent-workbench/package.json](apps/agent-workbench/package.json) 中的 `dev:legacy-ui`、`build:legacy-ui`
- 删除 [package.json](package.json) 根级的 `dev:workbench:legacy-ui`
- 把 `dev:workbench` 改为直接调 Tauri，去掉中间层

**验证**：`npm run` 列表清爽，无 legacy 字样。

---

## 四、P1：样式真相源统一

> 设计语言：**crish-desktop/src/index.css 的 neutral grays**。
> 设计原则：去色、去品牌喧开、克制、以背景色微差替代实体线（参见 [0613-0553.md](0613-0553.md) 第二层"去线化"思想，但**不引入** tokens.css 的多色板）。

### P1.1 建立 crish-desktop/src/styles/ 目录结构

**目标**：把单文件 [index.css](apps/crish-desktop/src/index.css)（当前 ~500+ 行）按职责拆分，但**保持 neutral grays 色板不变**。

**新结构**：
```
apps/crish-desktop/src/styles/
├── tokens.css        ← 仅 :root 与 [data-theme] 的 CSS 变量定义（neutral grays）
├── base.css          ← reset、滚动条、全局排版
├── shell.css         ← app-container / app-header / main-layout
├── sidebar.css       ← Sidebar 组件
├── workspace.css     ← Workspace / Column / CardGroup / Card
├── chat.css          ← ChatCard / 消息流 / 输入框
├── panels.css        ← FilesCard / PreviewCard / DiffCard / TasksCard / TerminalCard
├── settings.css      ← SettingsPanel
├── overlays.css      ← Toast / Dropdown / Cheatsheet / RuntimeFloatPanel / FirstRunWizard
└── index.css         ← 仅做 @import 聚合，零自身规则
```

**迁移规则**：
- 变量定义全部进入 `tokens.css`，组件 CSS 严禁定义新变量
- 组件 CSS 严禁出现 `!important`
- 组件 CSS 严禁出现硬编码色值（`#xxx` / `rgb()` / `rgba()`），必须走 `var(--xxx)`
- `0` / `1px` 边框、`transparent` 不算硬编码

### P1.2 消除组件级 `!important` 主题覆盖

**目标**：删除 [index.css](apps/crish-desktop/src/index.css) 第 144-200 行那十几处 `html[data-theme="dark"] .xxx { background-color: var(--bg-primary) !important; }`。

**根因**：当年为快速切深色主题而加的强制覆盖，违反"主题切换只改 Token 值"原则。

**改造方法**：
1. 把每个被 `!important` 覆盖的组件类（如 `.app-header`、`.workspace-card`、`.sidebar`、`.card-header` 等）的原始规则改为引用 Semantic Token：`background-color: var(--bg-primary);`（已经是）
2. 在组件 CSS 中**删除所有 `html[data-theme="dark"] .xxx { ... !important }` 块**
3. 因为这些组件本来就引用了 `var(--bg-primary)`，而 `--bg-primary` 在 `html[data-theme="dark"]` 块里已经改成深色值，所以删除 `!important` 覆盖后视觉效果**应当不变**
4. 若有视觉差异，说明该组件用了硬编码白底（如 `#fff`），需修复为 `var(--bg-primary)`

**验证**：深色/浅色主题切换后视觉无回归；`grep '!important' apps/crish-desktop/src/styles/` 返回空。

### P1.3 ModelPicker.css 收敛

**目标**：消除单组件独立样式文件的反模式。

**改动**：
- 把 [apps/crish-desktop/src/components/ModelPicker.css](apps/crish-desktop/src/components/ModelPicker.css) 内容并入 `styles/overlays.css` 或 `styles/settings.css`（取决于 ModelPicker 用在哪）
- 删除 ModelPicker.css 文件
- 检查 [apps/crish-desktop/src/components/](apps/crish-desktop/src/components/) 下是否还有其他 .css 文件，一并收敛

**验证**：`glob apps/crish-desktop/src/**/*.css` 仅返回 `src/styles/*.css` 与 `src/index.css`（聚合文件）。

### P1.4 删除 ModelPicker 单文件 import

**改动**：检查 [ModelPicker.tsx](apps/crish-desktop/src/components/ModelPicker.tsx) 中 `import './ModelPicker.css'`，改为依赖全局 styles。

### P1.5 引入 Stylelint 校验

**目标**：防止后续风格漂移。

**改动**：
- 在 `apps/crish-desktop/` 安装 `stylelint` + `stylelint-config-standard`
- 配置 `stylelint.config.js`：
  - 禁止硬编码色值（`color-hex-length`、`color-no-hex` 自定义规则）
  - 禁止 `!important`（`declaration-no-important`）
  - 禁止硬编码 z-index（自定义规则，允许 0/1/auto）
- 在 [package.json](apps/crish-desktop/package.json) 增加 `lint:css` script
- 在根 [package.json](package.json) `check:core` 中加入 `lint:css`

**验证**：`npm run lint:css` 全绿。

---

## 五、P2：数据真相源 / 错误处理 / Tauri 命令收敛

### P2.1 layoutStore DEFAULT_SESSIONS 移到 demoSeed

**目标**：消除生产 Store 里残留的 mock 数据。

**根因**：[layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts) 第 258-414 行硬编码了 5 条假会话，含一段内部开发路径 `C:\Software\codex_chatHistory\apps\browser-extension\dist`（私人路径泄露到生产代码）。

**改造步骤**：
1. 新建 `apps/crish-desktop/src/api/demoSeed.ts`，把 `DEFAULT_SESSIONS` 整段挪进去
2. 在 [layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts) 初始 state 中改为：
   ```ts
   sessions: isDemoMode() ? DEFAULT_SESSIONS : [],
   ```
3. 生产模式下若 `sessions.length === 0`，由 [App.tsx](apps/crish-desktop/src/App.tsx) 的 effect 创建一条欢迎会话（参考 agent-workbench 的 `maybeCreateDefaultSession` 模式）
4. 删除 `DEFAULT_SESSIONS` 里所有 `C:\Software\codex_chatHistory\...` 私人路径

**验证**：
- 生产模式启动后 sessions 列表为空或仅一条欢迎会话
- Demo 模式（`isDemoMode()` 为真）启动后展示 5 条种子会话
- 全文搜索 `codex_chatHistory` 无结果

### P2.2 移除 App.tsx 中的 window 全局变量反模式

**目标**：消除 `(window as any).AUTO_FOLD_DELAY` 等全局变量。

**改动**：
- 把 [App.tsx](apps/crish-desktop/src/App.tsx) 第 81-94 行的 `autoFoldDelay` + `(window as any).AUTO_FOLD_DELAY` 改为 zustand store 字段
- 在 [layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts) 增加 `autoFoldDelay: number` + `setAutoFoldDelay`
- 删除 `(window as any).useLayoutStore = useLayoutStore`（第 15-16 行调试代码）

**验证**：`grep '(window as any)' apps/crish-desktop/src/` 仅在确实需要桥接的地方出现。

### P2.3 修正动态 import 写法

**目标**：消除 `Function('return import("@tauri-apps/plugin-dialog")')()` 反模式。

**根因**：[App.tsx](apps/crish-desktop/src/App.tsx) 第 55-57 行用 `Function` 字符串构造动态 import 是为了规避 bundler 静态分析，但语义不对，且会被 CSP `unsafe-eval` 拦截（虽然当前 CSP 没禁但属于隐患）。

**改造方法**：
```ts
// 改为标准静态 import + 运行时判断
let dialogMod: typeof import('@tauri-apps/plugin-dialog') | null = null;
try {
  dialogMod = await import('@tauri-apps/plugin-dialog');
} catch { dialogMod = null; }
if (dialogMod?.open) { ... }
```

**验证**：`grep "Function('return import" apps/crish-desktop/src/` 返回空。

### P2.4 统一错误处理（useToast + logInternalError）

**目标**：消除 `console.error` 静默，所有用户可见错误经 Toast 反馈。

**根因**：[App.tsx](apps/crish-desktop/src/App.tsx) 第 119 行、[fontStore.ts](apps/crish-desktop/src/api/fontStore.ts)、[daemonClient.ts](apps/crish-desktop/src/api/daemonClient.ts) 等共 9 处 `console.error/warn` 全部静默。0613-0553.md 第四层要求落地未完成。[userFacingErrors.ts](apps/crish-desktop/src/api/userFacingErrors.ts) 已有 `logInternalError()` 抽象但未被调用。

**改造步骤**：
1. 在 `apps/crish-desktop/src/store/` 新建 `toastStore.ts`，基于 zustand 实现 `pushToast(message, type, onUndo?)` + 自动消失
2. 在 [App.tsx](apps/crish-desktop/src/App.tsx) 顶层渲染 `<ToastContainer />`（替换现有的本地 `toast` state）
3. 把 9 处 `console.error` 按错误分类处理：
   - **用户可操作错误**（如设置加载失败、文件夹选择失败）→ `pushToast(message, 'error')` + `logInternalError(err)`
   - **引擎内部错误**（如 daemon 连接失败但产品已 gate）→ 仅 `logInternalError(err)`，不打扰用户
   - **开发调试错误** → 保留 `console.error`，但用 ESLint `no-console` 在生产 build 中剥离
4. 引入 ESLint 规则：`no-console: ['error', { allow: ['warn', 'debug'] }]`，生产代码禁止 `console.error`

**验证**：
- 故意触发设置加载失败 → 用户看到 Toast
- `grep 'console.error' apps/crish-desktop/src/` 返回空或仅 `logInternalError` 内部

### P2.5 Tauri 命令收敛到 daemon_call

**目标**：把 [main.rs](apps/agent-workbench/src-tauri/src/main.rs) 的 70+ 个 `workbench_*` 命令收敛到 5 个核心命令。

**根因**：当前注册了 70+ 个 Tauri 命令（release/debug 双份维护），违反 README "daemon 是 single source of truth" 原则。Tauri 应是 thin shim。

**目标命令集**（5 个）：
| 命令 | 职责 |
|---|---|
| `daemon_call(method: String, params: Value) -> Result<Value, String>` | JSON-RPC 转发到 daemon |
| `daemon_subscribe(event: String) -> ...` | 订阅 daemon 事件流 |
| `fs_select_folder() -> Result<Option<String>, String>` | 原生文件夹选择器 |
| `config_get(key: String) -> Result<Value, String>` | 本地配置读取 |
| `config_set(key: String, value: Value) -> Result<(), String>` | 本地配置写入 |

**改造步骤**：
1. 在 daemon 侧（[packages/agent-daemon](packages/agent-daemon)）确认 JSON-RPC handler 已经覆盖所有 `workbench_*` 的能力（应该已覆盖，因为 daemon 才是真相源）
2. 在 Rust 侧实现 `daemon_call` 透传：调用 `sidecar::send_request(method, params)`
3. 在 crish-desktop 侧把所有 `invoke('workbench_xxx')` 改为 `invoke('daemon_call', { method: 'xxx', params })`
4. 删除 `workbench_*` 命令注册
5. 删除 `common_commands!` macro，debug/release 共用一份 `invoke_handler!`

**验证**：
- 全部功能正常工作（会话/审批/工具/MCP/plan/checkpoint 等）
- [main.rs](apps/agent-workbench/src-tauri/src/main.rs) 的 `invoke_handler!` 列表 ≤ 10 项
- `grep 'workbench_' apps/crish-desktop/src/` 仅剩 `tauri-command-registry.ts` 中的 CLI 桥接（如果保留 CLI）

### P2.6 CSP 收紧

**目标**：移除 [tauri.conf.json](apps/agent-workbench/src-tauri/tauri.conf.json) 中的 `unsafe-inline` 与外部 CDN。

**改动**：
```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: asset: http://asset.localhost; connect-src 'self' ipc: http://ipc.localhost http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'"
}
```

变更点：
- 移除 `https://unpkg.com`（若有第三方库走 unpkg，本地 bundle）
- 移除 script 的 `'unsafe-inline'`（React 19 不需要内联 script）
- 保留 style 的 `'unsafe-inline'`（CSS-in-JS 与内联 style 暂时需要，后续可改 nonce）
- 移除 `https://fonts.googleapis.com`（字体应本地 bundle，[crish-desktop](apps/crish-desktop) 已用 `@fontsource/*`）

**验证**：
- 控制台无 CSP 违规警告
- 字体正常加载
- 所有功能无回归

---

## 六、P3：文档同步与测试基建

### P3.1 重写 README.md

**目标**：消除 [README.md](README.md) 中关于"agent-workbench 是 supported desktop Workbench"的错误描述。

**改动**：
- "Current Product Path" 段重写为：
  - `apps/crish-desktop`：React 19 桌面 UI（Tauri 加载方）
  - `apps/agent-workbench/src-tauri`：Rust 壳层 + Tauri 命令
  - `apps/agent-workbench/src/cli`：开发诊断 CLI
  - `packages/agent-daemon`：daemon 后端
  - `packages/agent-orchestrator`：编排层
  - `packages/agent-runtime`：运行时核心
- "Legacy Surfaces" 段删除 web-ui（目录已不存在）
- "Architecture Principles" 段保留

### P3.2 重写 ARCHITECTURE.md

**目标**：删除 [ARCHITECTURE.md](ARCHITECTURE.md) 中关于 web-ui 的整段（第 204-239 行），重写为当前架构。

**改动**：
- 删除第 204-239 行"Web UI"段
- 删除第 439 行"已知限制 1. UI 未连接到 Runtime"（已过时）
- 重写"架构分层"图：UI Layer 改为 crish-desktop（React 19）
- 更新技术栈表：前端框架 React 19（不是 Preact）

### P3.3 重写 ROADMAP.md

**目标**：修正 [ROADMAP.md](ROADMAP.md) L6"前端框架 Preact"为 React 19。

**改动**：
- L6 Frontend 层状态保持"完成"，但技术改为 React 19
- "近期规划"段加入本计划的 P0-P3 任务引用

### P3.4 归档 0613-0553.md

**目标**：根目录不应散落日期编号的设计方案。

**改动**：
- 创建 `docs/design-history/` 目录
- 把 [0613-0553.md](0613-0553.md) 移到 `docs/design-history/2026-06-13-ui-system-plan.md`
- 在文件顶部加注："本方案部分已落地于 crish-desktop，部分被 REFACTOR-PLAN.md 取代。保留作为设计决策历史。"

### P3.5 crish-desktop 补关键单测

**目标**：当前 `glob apps/crish-desktop/src/**/*.test.{ts,tsx}` 返回空，零测试覆盖。

**优先补测**：
| 模块 | 测试文件 | 测试内容 |
|---|---|---|
| [layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts) | `store/layoutStore.test.ts` | sessions 增删/分支/归档、column/group/card 结构变更、draggedTab/dropPreview 状态机 |
| [daemonChatBridge.ts](apps/crish-desktop/src/api/daemonChatBridge.ts) | `api/daemonChatBridge.test.ts` | 事件流映射、approval 抽取、错误分类 |
| [toolFeedback.ts](apps/crish-desktop/src/api/toolFeedback.ts) | `api/toolFeedback.test.ts` | unified diff 解析、diffFiles 累积 |
| [sessionPersistence.ts](apps/crish-desktop/src/api/sessionPersistence.ts) | `api/sessionPersistence.test.ts` | hydrate/persist 往返 |
| [userFacingErrors.ts](apps/crish-desktop/src/api/userFacingErrors.ts) | `api/userFacingErrors.test.ts` | 错误分类、用户消息生成 |

**改动**：
- 在 [apps/crish-desktop/package.json](apps/crish-desktop/package.json) 增加 `test` script：`vitest run`
- 在根 [package.json](package.json) `test:core` 中加入 crish-desktop
- 在 [package.json](package.json) `check:core` 中确认已包含 `check:desktop`

### P3.6 main.tsx 副作用归位

**目标**：[main.tsx](apps/crish-desktop/src/main.tsx) 顶层执行的 `bootstrapTheme()` / `bootstrapFonts()` 应放入 React effect 或 main 函数。

**改动**：
```ts
// 改为
import { bootstrapTheme } from './api/themeStore'
import { bootstrapFonts } from './api/fontStore'

async function main() {
  bootstrapTheme();
  bootstrapFonts();
  await import('./index.css');
  const { createRoot } = await import('react-dom/client');
  const App = (await import('./App.tsx')).default;
  createRoot(document.getElementById('root')!).render(
    <StrictMode><App /></StrictMode>
  );
}
void main();
```

**理由**：模块顶层副作用在 SSR/测试环境会出错，且无法被 tree-shake。

---

## 七、执行顺序与里程碑

| 里程碑 | 包含任务 | 验收标准 |
|---|---|---|
| **M0：死代码清除** | P0.1 + P0.2 + P0.3 + P0.4 | `npm run check:core` 全绿；`npm run dev:workbench` 启动正常；`npm run cli` 可用 |
| **M1：样式归一** | P1.1 + P1.2 + P1.3 + P1.4 + P1.5 | 无 `!important`；无硬编码色值；`lint:css` 通过；深浅主题切换无视觉回归 |
| **M2：数据与错误收敛** | P2.1 + P2.2 + P2.3 + P2.4 | 生产模式无 mock 数据；无 `console.error` 静默；错误经 Toast 反馈 |
| **M3：命令与安全收敛** | P2.5 + P2.6 | Tauri 命令 ≤ 10 项；CSP 无 `unsafe-inline`（script）；无 unpkg |
| **M4：文档与测试** | P3.1-P3.6 | README/ARCHITECTURE/ROADMAP 与代码一致；crish-desktop 关键模块有单测 |

---

## 八、风险与回滚

### 8.1 风险点

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| P0.1 误删 CLI 依赖的 core/shared 文件 | 中 | CLI 无法启动 | 删除前 `grep -r 'from.*core/tauri-bridge' apps/agent-workbench/src/cli/` 确认依赖图 |
| P1.2 删除 `!important` 后深色主题视觉回归 | 中 | 部分组件白底未跟随主题 | 删除前先 `grep '#fff\|#ffffff' apps/crish-desktop/src/` 排查硬编码白底 |
| P2.5 daemon JSON-RPC 未覆盖某 Tauri 命令 | 中 | 功能缺失 | 改造前先做映射表：列全部 70+ `workbench_*` 命令，逐一标注 daemon 侧对应 method |
| P2.6 CSP 收紧后字体加载失败 | 低 | 字体回退到系统 | 字体已用 `@fontsource/*` 本地 bundle，应无影响 |

### 8.2 回滚策略

- 每个里程碑（M0-M4）独立 commit，便于 `git revert`
- P0.1 删除前先打 tag `pre-refactor-p0`
- P2.5 改造期间保留旧 `workbench_*` 命令注册，仅新增 `daemon_call`，验证通过后再删除旧命令（双窗口期一个里程碑）

---

## 九、不做什么（明确排除）

为避免范围蔓延，本计划**不**包含以下内容：

1. **不重写样式设计语言**：用户已确认遵循 [crish-desktop/index.css](apps/crish-desktop/src/index.css) 的 neutral grays，不引入 [tokens.css](apps/agent-workbench/src/styles/tokens.css) 的多色板
2. **不引入新框架**：不替换 React 19 / zustand / immer
3. **不重做组件库**：现有组件保持，仅做样式归一与错误处理收敛
4. **不实现 0613-0553.md 的品牌化层**（第六层）：动态 SVG、欢迎页、品牌辅色等暂不做
5. **不做响应式断点系统**（0613-0553.md 第七层）：当前为桌面端单尺寸产品
6. **不新增功能**：本计划纯技术债清理

---

## 十、附录：关键文件索引

### 待删除文件清单（P0.1）
- [apps/agent-workbench/src/main.tsx](apps/agent-workbench/src/main.tsx)
- [apps/agent-workbench/src/styles.css](apps/agent-workbench/src/styles.css)
- [apps/agent-workbench/src/components/](apps/agent-workbench/src/components/)（整个目录）
- [apps/agent-workbench/src/styles/](apps/agent-workbench/src/styles/)（整个目录）
- [apps/agent-workbench/src/core/app-state.ts](apps/agent-workbench/src/core/app-state.ts)
- [apps/agent-workbench/src/core/event-bus.ts](apps/agent-workbench/src/core/event-bus.ts)
- [apps/agent-workbench/src/core/message-pipeline.ts](apps/agent-workbench/src/core/message-pipeline.ts)
- [apps/agent-workbench/src/core/runtime-event-projector.ts](apps/agent-workbench/src/core/runtime-event-projector.ts)
- [apps/agent-workbench/src/shared/task-controller.ts](apps/agent-workbench/src/shared/task-controller.ts)
- [apps/agent-workbench/src/shared/runtime-bridge.ts](apps/agent-workbench/src/shared/runtime-bridge.ts)
- （完整列表见 P0.1）

### 待修改文件清单（P1-P3）
- [apps/crish-desktop/src/index.css](apps/crish-desktop/src/index.css)（拆分到 styles/）
- [apps/crish-desktop/src/App.css](apps/crish-desktop/src/App.css)（删除）
- [apps/crish-desktop/src/components/ModelPicker.css](apps/crish-desktop/src/components/ModelPicker.css)（并入全局）
- [apps/crish-desktop/src/store/layoutStore.ts](apps/crish-desktop/src/store/layoutStore.ts)（移除 mock + 加 autoFoldDelay）
- [apps/crish-desktop/src/App.tsx](apps/crish-desktop/src/App.tsx)（移除 window 全局 + 改动态 import + 接 Toast）
- [apps/crish-desktop/src/main.tsx](apps/crish-desktop/src/main.tsx)（副作用归位）
- [apps/agent-workbench/src-tauri/src/main.rs](apps/agent-workbench/src-tauri/src/main.rs)（命令收敛）
- [apps/agent-workbench/src-tauri/tauri.conf.json](apps/agent-workbench/src-tauri/tauri.conf.json)（CSP 收紧）
- [README.md](README.md) / [ARCHITECTURE.md](ARCHITECTURE.md) / [ROADMAP.md](ROADMAP.md)（文档同步）

---

## 十一、验收总清单

完成全部 P0-P3 后，以下条件必须全部满足：

- [ ] `npm run check:core` 全绿
- [ ] `npm run test:core` 全绿（含新增 crish-desktop 测试）
- [ ] `npm run lint:css` 全绿
- [ ] `npm run dev:workbench` 启动后功能无回归
- [ ] `npm run cli` 可正常运行
- [ ] `grep -r 'workbench_' apps/crish-desktop/src/` 仅在 CLI 桥接中出现
- [ ] `grep '!important' apps/crish-desktop/src/styles/` 返回空
- [ ] `grep 'console.error' apps/crish-desktop/src/` 返回空或仅 logInternalError 内部
- [ ] `grep 'codex_chatHistory' .` 返回空
- [ ] `grep '(window as any)' apps/crish-desktop/src/` 仅在必要桥接处
- [ ] 深色/浅色主题切换无视觉回归
- [ ] README/ARCHITECTURE/ROADMAP 与代码现状一致

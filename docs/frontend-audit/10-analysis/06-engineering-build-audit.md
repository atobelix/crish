# 前端工程化与构建体系审计报告（06）

- 审计对象：`apps/crish-desktop`（vite 7 + TS 5.9 + React 19）+ `packages/shared-types` + 仓库级工程化（turbo/npm workspaces/CI 三层）
- 审计方式：只读实读证据（配置文件全文 + lockfile 解析 + dist 产物实测 + 依赖体积实测 + npm outdated + 代码门控点）
- 审计日期：2026-08-09（dist 产物构建时间 2026-08-09 02:35）
- 结论速览：**工程化基础设施完整、门禁密度高（depcruise 微观规则 / knip / 生成绑定漂移 / coverage 阈值均已接线），但存在两个结构性缺口：①前端生产构建（vite build）完全不在 CI 三层内，产物从未被机器验证；②dev/prod 共用一份含 `unsafe-eval` 的宽 CSP。** 详见 §7 清单。

---

## 1. 构建配置

### 1.1 vite.config.ts 全字段（apps/crish-desktop/vite.config.ts，共 247 行）

| 字段 | 值 | 位置 | 评述 |
|---|---|---|---|
| `define` | `'process.env': {}`、`process.platform` 字面量 | :192-195 | 浏览器端屏蔽 node 全局；平台名编译期注入 |
| `plugins` | react + crishHttpProxyPlugin + nodeBuiltinStubPlugin | :196 | 两个自研插件，见下 |
| `resolve.alias` | `@` → `src` | :198-201 | 仅此一个 alias |
| `optimizeDeps.exclude` | `@modelcontextprotocol/sdk` | :204 | 防止 dev prebundle 把 Node-only stdio transport 打进浏览器 |
| `optimizeDeps.include` | react/react-dom/radix-popover/tauri-window/dompurify/lucide/zustand/immer/highlight.js | :205 | 与 exclude 配套的显式预打包清单 |
| `server` | port 5174, strictPort | :207-210 | 与 tauri devUrl 对齐 |
| `build.target` | es2022 | :212 | 保守目标 |
| `build.chunkSizeWarningLimit` | 1100 | :216 | **已被实际产物超过**（App chunk 1137KB，见 §4.1），每次 build 报警告 |
| `build.commonjsOptions` | transformMixedEsModules | :217 | |
| `rollupOptions.output.manualChunks` | 函数式（Windows-safe `\\`→`/` 归一） | :218-243 | vendor-react / vendor-zustand / vendor-lucide / vendor-highlight / vendor-fonts / chat-bridge / chat-stream-core / vendor-workers |
| `clearScreen` | false | :245 | |
| `envPrefix` | `VITE_`, `TAURI_` | :246 | |

**自研插件一：crishHttpProxyPlugin**（:13-117）：dev 期 `POST /__crish_http_proxy` 代发供应商 API（GET/POST/HEAD，http(s) 校验），解决浏览器 CORS。仅 `configureServer`，不进生产 bundle——安全面可控，但入口无鉴权（本地 dev server，可接受）。

**自研插件二：nodeBuiltinStubPlugin**（:125-189）：`enforce:'pre'`，仅当 importer 来自 `@modelcontextprotocol` / cross-spawn / which / isexe 等 Node-only 链路时把 bare builtin（stream/fs/child_process/util/…16 个）解析为 `\0stub:` 空实现。**刻意不全量 stub**（注释 :123：避免覆盖 npm 浏览器 polyfill）。这是生产构建能跑通的关键，但意味着"MCP SDK 在桌面浏览器形态下编译期被阉割"——运行时行为依赖 mcpClient 在非桌面环境拒绝（:122 注释），属于脆弱的"编译期假设+运行时守卫"组合，需保持两者同步。

### 1.2 tsconfig 结构

- `tsconfig.json`（solution 文件）：files 空 + references → `tsconfig.app.json` + `tsconfig.node.json`（:3-5）
- `tsconfig.app.json`：target es2023 / module esnext / bundler 模式 / jsx react-jsx / noEmit / `types: ["vite/client","node"]`（:8）。**两处对 base 的刻意放宽**：`noUnusedLocals: false`、`exactOptionalPropertyTypes: false`（:18-19，注释"Relax non-fatal lint strictness"）——`exactOptionalPropertyTypes` 放宽会弱化 base 的严格性，属架构取舍而非疏忽（base 里是 `true`，tsconfig.base.json:19-20）
- `tsconfig.node.json`：仅 `vite.config.ts`，严格项全开（noUnusedLocals/Parameters、noFallthroughCasesInSwitch，:18-21）
- `tsconfig.base.json`（仓库级）：strict + `customConditions: ["development"]`（:6）——这是 shared-types `exports.development` 条件（packages/shared-types/package.json:11-15）在 tsc 面生效的关键

### 1.3 生产构建产物策略

- 入口：`index.html` → `/src/main.tsx`（index.html:202），首屏渲染骨架屏由 index.html 内联 CSS+SVG（:17-177），React 就绪后替换
- `main.tsx` 多阶段启动：动态 import bootstrap-orchestrator（:15）→ bootstrap-core（:19）→ React/App（:45-52，`import('./App')` 拆分 app chunk）→ AppErrorBoundary 动态加载（:73）→ requestIdleCallback 加载 bootstrap-full（:92-101）
- 懒加载：30+ 处 `React.lazy`（§4.2）
- 产物实测：72 个 js chunk，`modulepreload` 只预载 3 个关键 vendor（dist/index.html:179-181）；无 compression 插件、无 sourcemap 配置（build.sourcemap 默认关闭）

### 1.4 关键设计决策评述

- **Windows 路径安全**：manualChunks 函数式 + 反斜杠归一（:221-222），避免字符串匹配在 win32 上失效——加分项
- **dual-mode shared-types 消费**：dev 走 `exports.development` → src/（vite resolve.conditions 默认含 development），build 走 `dist/index.js`；turbo.json:5-7 `build.dependsOn: ["^build"]` 保证先构建依赖包。但 **CI 不跑 turbo build**（见 §3.4），shared-types 的 dist 在 CI 环境从未被构建验证——typecheck 走 development 条件（tsconfig customConditions）掩盖了 dist 缺失
- **process 全局兜底**：define + stub 双保险，`process.platform` 编译期注入 'win32'（:194）

---

## 2. 依赖健康

### 2.1 依赖清单与体积贡献

`apps/crish-desktop/package.json` dependencies 共 31 项（:19-51）。node_modules 实测体积（含传递依赖）：

| 依赖族 | 安装体积 | 产物贡献 | 备注 |
|---|---|---|---|
| lucide-react | 32.4 MB | vendor-lucide 540 KB | 全量图标包安装，tree-shaking 生效 |
| @tauri-apps/* + tauri-plugin-mcp | 15.6 MB | 少量 | api/plugin-dialog 等 |
| @fontsource ×4 | 9.6 MB | 字体子集 woff/woff2 ~46KB/款 | 安装全量，dist 只带 latin 子集，正常 |
| @xterm ×3 | 7.9 MB | 进入 App chunk | xterm + fit + webgl 全数打包进主 chunk |
| react-dom | 7.0 MB | vendor-react 504 KB | |
| @tiptap ×8 + @tiptap/pm | 5.4 MB | 进入 App chunk | prosemirror 另 2.8 MB（@tiptap/pm 传递） |
| highlight.js | 5.2 MB | vendor-highlight 106 KB | |
| zod | 3.4 MB | 进入 chat-bridge/App | 与 shared-types 共享 |
| dompurify / immer / zustand / @radix-ui / react | <3 MB | 分散 | zustand+immer 已独立 split |

**结构性观察**：所有"重"依赖（tiptap ~8.2MB、xterm 7.9MB、dompurify、highlight）都落入主业务 chunk `App-*.js`（实测 contains 命中），manualChunks 只拆了 react/lucide/highlight/fonts/zustand 五族（vite.config.ts:224-230），未给 tiptap/xterm 独立 vendor 拆分（§7 P2-4）。

### 2.2 重复依赖（同库多版本）

- 根 package-lock.json（642 个 packages）：**重复安装包数 = 0**，无同库多版本（脚本遍历 lockfile 全部 node_modules 路径按包名分组统计）
- 无 npm ls invalid/extraneous（仅 UNMET OPTIONAL 平台二进制，属正常：@tauri-apps/cli-*、rollup-*、fsevents 等）

### 2.3 未使用依赖

- knip 已接线为 ci-mid 门禁（ci-mid.yml:140-150，error 级 rules：files/dependencies/devDependencies/unresolved；knip.config.ts:72-82）
- db6880ef 提交已清理 51+2 个 eslint 错误（死代码/未用 import）与 11 个 audit 漏洞，当前无未使用依赖告警
- 反向发现：**check-tsc-threshold.mjs / check-coverage-threshold.mjs 两个"门禁脚本"从未进任何 CI 工作流**（全仓库 grep 仅 docs/analysis 提及），属于死脚本或"以为在跑"的假门禁（§7 P2-7）

### 2.4 依赖过时（npm outdated 实测）

**major 落后清单**：vite 7.3.5→8.2.1、vitest 3.2.7→4.1.10、@vitejs/plugin-react 5.2.0→6.0.5、lucide-react 0.525.0→**1.30.0**（0.x→1.x 大版本跨代）、eslint 9.39.5→10.8.1、eslint-plugin-react-hooks 5.2.0→7.1.1、dependency-cruiser 16.10.4→18.1.1、fast-check 3.23.2→4.9.0、globals 15.15.0→17.9.0、typescript 5.9.3→7.0.2、@types/node 25.9.2→26.2.0、@eslint/js 9→10。

minor/patch 正常跟进的：react 19.2.7→19.2.8、immer 11.1.11→11.1.16、turbo、tsx、prettier、@tauri-apps/api、@playwright/test 等。

注意：zod 锁在 ^3.25.76（crish-desktop + shared-types 双处），zod 3 已停更（4.x 为 current）；lucide 0.525→1.30 属于跨 major 的 API 重命名风险（图标导出名变化），需独立迁移窗口。共享 types 与前端同一 zod 3 版本，无版本分裂。

---

## 3. CI / 门禁覆盖

### 3.1 快层（ci.yml，提交/PR）

| Job | 内容 | 前端覆盖 | 位置 |
|---|---|---|---|
| typecheck | `npm run typecheck`（7 段 tsc 直跑） | ✅ | :34-46 |
| lint | `npx eslint .` + depcruise | ✅（口径差异见 3.4） | :48-62 |
| vitest-fast | `npm run test:coverage -- --project=unit`（**强制 coverage 门禁 45/70/65/45**） | ✅ | :64-81 |
| audit | `npm audit --audit-level=moderate` | ✅ | :83-93 |
| engine-bindings-drift | 重跑 `scripts/generate-engine-bindings.mjs` + `git diff --exit-code` | ✅ 生成绑定漂移已进 CI | :99-110 |
| cargo-deny / secret-scan / rust-check / rust-unit-fast | Rust 面 | — | :112-145 |

### 3.2 中层（ci-mid.yml，PR + main）

test（vitest 全量 unit+integration+native-smoke，:66-85）、test:integration（F3 四目录，:87-99）、e2e 冒烟子集（5 个 Playwright spec，:122-133）、knip（:140-150）、machete、clippy、governance-baselines。

### 3.3 慢层（ci-slow.yml，nightly/发布）

stress-ts（:40-51）、e2e 全量（Playwright，:53-66）、rust-stress、bench。

### 3.4 缺口（门禁盲区）

1. **生产构建零覆盖**：三层 CI **没有任何 `vite build` / `npm run build`**（grep 全 workflow：仅 perf-test.yml:25 构建 packages 库）。tauri.conf.json:10 `beforeBuildCommand: "npm run build"` 只在本地打包/发布时执行。后果：manualChunks 回归、chunk 超限、shared-types dist 缺档、stub 插件与 define 替换的正确性，全部只在开发者本机验证。
2. **e2e 跑的是 dev server**：playwright.config.ts:57 `command: npm run dev` + url 5174——生产形态（minify、define 替换、懒加载 chunk 真实路径、nodeBuiltinStub 产物）从未被任何自动化执行过。
3. **lint 口径不一致**：ci.yml:58 为 `npx eslint .`（无 `--max-warnings 0`），本地 `lint:all`（package.json:54）带 `--max-warnings 0`——warning 在 CI 不红但本地红，门禁漂移。
4. **stylelint / prettier 未进 CI**：lint:all 含 stylelint（package.json:54）且 eslint.config 无 CSS 面，CSS 无任何 lint 门禁；`format`（prettier --check）也不在 CI。

---

## 4. 性能构建面

### 4.1 bundle 实测（dist/，2026-08-09 构建）

| 产物 | 大小 | 说明 |
|---|---|---|
| App-B3OflnMh.js | **1137.5 KB** | 主业务 chunk：tiptap+prosemirror+xterm+dompurify+highlight（实测包含） |
| vendor-lucide | 540.1 KB | |
| vendor-react | 504.2 KB | react+react-dom |
| chat-bridge | 429.5 KB | 含 zod |
| vendor-highlight | 106.5 KB | |
| index/App CSS | 319.6 + 164.4 KB | |
| dist/assets 总计 | **4.33 MB**（72 个 js） | 未 gzip 统计 |

**App chunk 已超过 `chunkSizeWarningLimit: 1100`**（vite.config.ts:216），注释自述"为已知大头降噪"——当前每次 build 都会触发体积警告，阈值已失去意义（应同步拆分或校准）。

### 4.2 懒加载（React.lazy 使用处，30+ 处）

App.tsx:37/:65（DevHealthOverlayLazy、BinaryTreeWorkspace）、AppGlobalDialogs.tsx:11-24（ToastStack/CheatsheetModal/FirstRunWizard/SettingsPanel）、CardPanelLayout.tsx:21-36（Preview/Overview/Files/Diff/Runtime/Agent 六卡）、TreeLeafPanel.tsx:34-58（9 处）、SettingsPanel.tsx:27-39（tab 级）、AppTopBar/MessageToolCallsSection/MessageActions/InlineAgentPanel 等。settings-tab 全部懒加载（21.4-41.4KB 独立 chunk，实测 SkillsSettingsTab 41.4KB）。懒加载面健康。

### 4.3 优化配置

- manualChunks 函数式拆分（vite.config.ts:218-243）+ modulepreload 3 关键 vendor（dist/index.html:179-181）
- 无 gzip/brotli 压缩插件——桌面 tauri:// 本地协议加载，收益低，**非问题**（若未来 web 预览需补）
- 无预渲染/SSR（桌面 SPA 合理）
- 骨架屏内联零请求（index.html:17-177）

### 4.4 开发构建体验

- `dev: "vite --force"`（package.json:9）：每次 dev 强制重新 optimizeDeps——配合 exclude MCP SDK（vite.config.ts:204），冷启动必 re-opt，代价可接受但可改为仅在依赖变更时失效
- 无 HMR 专项配置；eslint react-refresh 规则启用（eslint.config.js:156-160）并有 15 个文件级豁免（:171-193）
- clearScreen: false（:245）

---

## 5. 环境面

### 5.1 env 变量清单（全仓库无 .env 文件提交；.gitignore:22-24 有忽略规则；envPrefix = VITE_/TAURI_，vite.config.ts:246）

| 变量 | 用途 | 位置 |
|---|---|---|
| VITE_ALLOW_DEMO=1 | 允许 demo 模式（dev/QA 专用） | appMode.ts:23 |
| VITE_FORCE_NORMAL=1 | 强制 normal 模式 | appMode.ts:22 |
| VITE_USER_VIEW_DEBUG=1 | 用户视角投影调试开关 | messageUserProjection.ts:666-667 |
| TAURI_*（TAURI_DEBUG 等） | Tauri 构建/环境 | vite envPrefix 声明面 |
| `import.meta.env.DEV/PROD` | 内置，dev/prod 行为分岔主开关 | 多处 |

### 5.2 dev/prod 行为差异点

- **MCP 门控**：`import.meta.env.DEV` 才加载 tauri-plugin-mcp guest + registerCrishMcpBridge（main.tsx:111-123）；dev/mcpBridge.ts 注释明示 DEV-only
- **store 暴露**：`__CRISH_STORE__` 等 window 挂载不 gate（main.tsx:26-35，注释称"只提供与 UI 同等的 API 入口"）——prod 同样暴露，属有意为之（调试/自动化），风险登记
- **DevHealthOverlay**：`import.meta.env.DEV` 条件懒加载（App.tsx:36）
- **错误上报门控**：AppErrorBoundary DEV 下 console.error、非 DEV 走静默/降级（AppErrorBoundary.tsx:91/:151）
- **appMode 生产锁定**：isProductionBuild → 无 demo（appMode.ts:38）
- **CSP**：**dev/prod 共用同一 index.html 的 CSP**（index.html:13）：`script-src 'self' 'unsafe-inline' 'unsafe-eval'` + `connect-src 'self' ipc: http: https: ws: wss:`。Tauri 官方基线要求生产移除 unsafe-eval；connect-src 放行任意 http(s)/ws 使远程注入面敞开（§7 P1-2）

---

## 6. 工作区集成

- **依赖方式**：`@crish/shared-types` 以 `file:../../packages/shared-types` 挂载（crish-desktop/package.json:20、agent-workbench/package.json:16）——npm workspaces 下等价于 workspace 链接，npm ls 正常提升解析；非 `workspace:` 协议，但 npm 环境下行为一致
- **tauri 衔接**：apps/agent-workbench/src-tauri/tauri.conf.json:7-10 —— frontendDist 指向 `../../crish-desktop/dist`、devUrl 5174、beforeDevCommand `npm run dev`、beforeBuildCommand `npm run build`（经 agent-workbench 的 npm --prefix 转发，agent-workbench/package.json:10）
- **turbo 与 npm workspaces 双轨**：root `build` 走 turbo（package.json:18，turbo.json tasks build dependsOn ^build）；CI 全部走根脚本直跑（G7 口径，ci.yml:44-46 注释明示"与 npx turbo run typecheck 覆盖等价"）。两轨并存但口径已对齐，CI 侧不依赖 turbo 是刻意的
- **脚本一致性**：root scripts 与 workspace scripts 双份存在（dev:desktop / build:desktop / check:desktop 等转发脚本，package.json:21-24），语义对齐
- **遗留问题**：`apps/crish-desktop/` 目录内有三份过期锁文件（package-lock.json 99KB / pnpm-lock.yaml 42KB / pnpm-workspace.yaml，均 2026-08-01）：app 级 lock 内 lucide-react 声明为 `^1.20.0`（与当前 `^0.525.0` 不符）、pnpm-workspace.yaml 只有一行占位注释 `allowBuilds: esbuild: set this to true or false`——是 8-01 的一次 pnpm 实验残留。在 app 目录执行 npm install/pnpm 会命中过期解析（§7 P2-3）

---

## 7. 问题清单（P0–P3）

### P0（阻断级）
**无。** 未发现直接破坏构建/发布的故障（dist 可正常构建，2026-08-09 产物存在）。

### P1（高：结构缺口/安全面）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P1-1 | **前端生产构建完全不在 CI**：三层 workflow 均无 vite build；产物正确性（manualChunks/define/stub/shared-types dist）只在开发者本机验证；e2e 全部跑 dev server | ci.yml/ci-mid.yml/ci-slow.yml 无 build；playwright.config.ts:57 用 `npm run dev`；tauri.conf.json:10 | 快层或中层加 `npm run build:desktop` job；e2e 增补 production preview 模式（`vite preview` + 5174/4173）至少做冒烟 |
| P1-2 | **CSP 过宽且 dev/prod 共享**：`script-src 'unsafe-inline' 'unsafe-eval'` + `connect-src http: https: ws: wss:` 在 Tauri 生产包内生效 | index.html:13（dist/index.html 同源复制） | 构建期按 mode 注入 CSP（vite plugin transformIndexHtml），生产移除 unsafe-eval、connect-src 收敛到 ipc:/自域名 |

### P2（中：工程健康/一致性）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-3 | app 目录三份过期锁文件与根 workspace 冲突（lucide ^1.20.0 陈旧声明、pnpm-workspace.yaml 占位残留），目录内安装会命中文档外的依赖图 | apps/crish-desktop/{package-lock.json,pnpm-lock.yaml,pnpm-workspace.yaml} 2026-08-01 | 删除三文件，根锁为唯一真源 |
| P2-4 | App chunk 1137KB 超限且承载 tiptap(5.4MB)+prosemirror(2.8MB)+xterm(7.9MB) 全部大依赖；chunkSizeWarningLimit 1100 已失效 | dist 实测；vite.config.ts:216；manualChunks:218-243 缺 tiptap/xterm 拆分 | manualChunks 增 vendor-tiptap / vendor-xterm；或按启动路径再拆 chat/composer 业务 chunk |
| P2-5 | lint 口径漂移：CI `npx eslint .` 无 `--max-warnings 0`；stylelint、prettier --check 均不在 CI | ci.yml:58；package.json:54（lint:all）、:59-60（format） | CI lint 对齐 lint:all；stylelint/format 纳入快层 |
| P2-6 | 12 项 major 落后（vite 7→8、vitest 3→4、lucide 0.525→1.30、eslint 9→10、TS 5.9→7.0.2 等）；zod 3 停更未迁移 | npm outdated 实测 | 建迁移窗口单；lucide 1.x 与 zod 4 单独评估（图标导出名/API 变化） |
| P2-7 | check-tsc-threshold.mjs / check-coverage-threshold.mjs 未接线任何 CI，属死脚本/假门禁 | scripts/ 存在；全仓 grep 仅 docs/analysis 引用 | 删除或接入某层；二者语义已被 tsc 直跑与 vitest coverage 阈值覆盖 |
| P2-8 | tsconfig.app.json 放宽 base 严格项（noUnusedLocals、exactOptionalPropertyTypes=false）且 types 含 node | tsconfig.app.json:8/:18-19 vs tsconfig.base.json:19-21 | exactOptionalPropertyTypes 争取回收；types 拆出 node 仅限 config/工具链文件 |

### P3（低：记录/优化）

| # | 问题 | 证据 |
|---|---|---|
| P3-9 | `dev: "vite --force"` 每次冷启动强制 re-opt（配合 optimizeDeps.exclude MCP SDK） | package.json:9；vite.config.ts:204 |
| P3-10 | 无 gzip 插件/无 sourcemap——桌面协议下合理，记录非问题；若未来 web 预览需补 | vite.config.ts build 段 |
| P3-11 | lucide 安装 32.4MB / fontsource 9.6MB 全量在 node_modules（产物已 tree-shake/子集化，仅记录） | node_modules 实测 |
| P3-12 | `__CRISH_STORE__` 等 store 挂载未按 DEV 门控（prod 亦暴露） | main.tsx:26-35 |

---

## 8. 结论

工程化基座扎实：依赖树无重复版本、knip 死代码门禁、depcruise 三层+微观规则、coverage 阈值真实生效、生成绑定漂移有 CI 兜底、懒加载面广、Windows 路径安全处理到位。**最高优先级动作是 P1-1（生产构建进 CI）与 P1-2（CSP 按 mode 收紧）**；随后清理 P2-3 过期锁文件与 P2-4 的 App chunk 拆分，即可把"构建体系可信度"提升到与测试门禁同一水位。

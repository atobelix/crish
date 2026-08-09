# T-G 工程化轨道 · 详细执行计划（07-engineering-detail）

> 产出：详细计划子 Agent（只读 + 本文档）。输入：`40-final-plan/00-master-plan.md`（批次 7：7.1 build+chunk、7.2 CSP）+ `20-proposals/06-engineering-build-proposal.md`（步骤 0~7）+ `30-reviews/01~03`（N1/N2 修正、06-评审：manualChunks 行号 :221 起、prettier format 独立排期、C16 stylelint 规则升级归属、C21 基线路径定夺）+ `10-analysis/06-engineering-build-audit.md`（chunk 实测 1137.5KB、三锁文件、lint 漂移）。
> 全部文件清单与行号基于 2026-08-09 工作区**实读确认**（含 dist 产物实测、git ls-files 跟踪面、npm registry 版本查询）；仓库仍在演进，执行时「语义定位优先」，漂移处已标注。
> 日期：2026-08-09。性质：可派发执行的详细计划，无代码改动。

---

## 0. 轨道定位与边界

| 承接（本轨道任务） | 不承接（声明归属） |
|---|---|
| 06-步骤 0~7 全部（基线、build 进 CI、chunk 拆分、CSP 分层、锁文件、lint 口径、preview 冒烟、收尾清理） | 批次 7.3 的 05 吞错 AST 门禁 + 行数门禁接线（归 05 轨道，master plan 批次 7 已列，另行派单） |
| 懒加载点清单移交物（T2-4，静态拆分与 07 正交的边界声明） | tiptap/xterm **运行时** React.lazy 落地（归 07 性能轨道；06 先行静态拆分，互不阻塞） |
| CSP 切换点登记（T3-5） | stylelint `declaration-no-important` 升级 error 级（C16 裁决：归 01-S7 的 !important ratchet ≤100 后追加，本轨道只做版本锁定与入口统一） |
| tsconfig 严格项回收（P2-8）与 12 项依赖 major 迁移（P2-6）**仅登记不实施**（T7-4） | — |

**任务数：26 项文件级任务**（① 3 + ② 4 + ③ 5 + ④ 2 + ⑤ 4 + ⑥ 3 + ⑦ 5）。执行 Agent 建议 2~3 名：T1/T2 链一人、T3 一人（依赖 T1 的 check-dist 登记→强制切换）、T4/T5/T7 独立可并行；T6 依赖 T2/T3 产物。

**执行顺序**（依赖链，同 06 方案）：步骤 0 基线 → T4/T5-4（独立，**建议最先做**，03-review 批 14 建议）→ T1（build 进 CI）→ T2（chunk）→ T3（CSP）→ T6（preview 冒烟，依赖 T1+T2+T3 产物）→ T5-1~T5-3、T7 收尾。

---

## ① CI build job 设计（06-步骤 1，P1-1 前半）

### 1.1 现状（实读确认）

- 快层 `.github/workflows/ci.yml` 共 9 个 job（typecheck/lint/vitest-fast/audit/engine-bindings-drift/cargo-deny/secret-scan/rust-check/rust-unit-fast，:34-145），**无任何 vite build**；
- 根 `package.json` 已有转发脚本：`build:shared-types`（:25）、`build:desktop`（:23，= `npm --workspace @crish/crish-desktop run build` = `tsc -b && vite build`）——G7 口径，job 直接走根脚本，不引入第二构建路径；
- **N2 关键前置（02-review 复核成立）**：`packages/shared-types/package.json:9-19` 的 `exports` 中 `development` 条件指向 `./src/index.ts`、默认条件指向 `./dist/index.js`；vite build（production）解析默认条件 → **CI 无 dist 缓存，必须先构建 shared-types**，否则 build 失败或静默解析错误。本地一直能 build 是因为 dist 曾在本机存在（审计 §1.4）。

### 1.2 任务清单

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T1-1 | 快层 ci.yml 新增 `frontend-build` job（位置：`vitest-fast` 与 `audit` 之间，:81/:83；与现有 job 并行） | `.github/workflows/ci.yml` | P1-1 | ✓ |
| T1-2 | 新增 `scripts/check-dist.mjs`（最小版：CSP 登记 + chunk 清单输出；步骤 2/3 增补断言） | `scripts/check-dist.mjs`（新增） | P1-1 | ✓ |
| T1-3 | 根 `package.json` 挂 `check:dist` 转发脚本（G7 口径，job 与本地同命令） | `package.json`（scripts 段） | P1-1 | ✓ |

### 1.3 job 设计（T1-1 草案）

```yaml
  # 生产构建门禁（06-步骤1）：产物从未被机器验证 → 首次在 CI 中构建并断言。
  # N2 前置：shared-types dist 无缓存，必须先构建（exports.default → dist/index.js）。
  # 门禁承载：scripts/check-dist.mjs 单一断言脚本（CSP 登记/强制 + chunk 清单/阈值）。
  frontend-build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build:shared-types   # N2：exports.default → dist/index.js
      - run: npm run build:desktop        # = tsc -b && vite build，与本地同口径
      - run: npm run check:dist           # 断言（步骤1：登记；步骤2/3：强制）
```

要点：
- **命令链顺序固定**：shared-types → build:desktop → check:dist；顺序颠倒即 CI 失败（N2）。
- `build:desktop` 含 `tsc -b`，与 typecheck job（7 段 tsc 直跑）职责有重叠——口径统一优先（06 风险 R6 缓解：独立 job 并行 + npm ci 缓存，增量成本 ≈ 2-3min，快层 ≤15min 预算内）。
- CI（ubuntu）注入 `process.platform='linux'` vs 发布（win32）——N3 已知平台分支差异，本步不处理（T7-4 登记）。

### 1.4 check-dist.mjs 最小版（T1-2 草案）

- 解析 `apps/crish-desktop/dist/`（路径相对仓库根解析）：
  - `dist/index.html`：
    - **登记模式**（步骤 1~2 期间）：统计 CSP meta 数量并输出其 content，`unsafe-eval` 出现时仅打日志不失败（`--csp-enforce` 开关切强制，步骤 3 开启）；
    - 输出所有 `<script>`（含内联，实读 dist 有 1 个内联 theme script）与 modulepreload 清单；
  - `dist/assets/*.js`：输出 `{ name, bytes }` 清单（供步骤 2 调阈值）；
  - 退出码：登记模式下仅输出 + exit 0；断言项全部过才 exit 0，否则 exit 1。
- 入参：`--csp-enforce`（步骤 3 后 CI 固定加）、`--max-app-kb`（步骤 2 后传入 500）。
- 不依赖任何 npm 依赖（node:fs 原生），可在任意 job 直接 `node` 跑。

### 1.5 验证（步骤 1）

- 本地：`npm run build:shared-types; if ($?) { npm run build:desktop }` → `npm run check:dist`（输出 chunk 清单）；
- PR 提交后观察快层新 job 绿 + check-dist 输出留档。

---

## ② chunk 拆分方案（06-步骤 2，P2-4）

### 2.1 现状（实读确认）

- App chunk 实测 `App-*.js` = **1137.5KB**（审计 §4.1，dist 实测存在）；
- `vite.config.ts:216` `chunkSizeWarningLimit: 1100` 为降噪开关（注释自认），每次 build 超限只告警不失败；
- manualChunks（:221-241 函数式，Windows-safe `\\`→`/` 归一）只拆了 vendor-react/zustand/lucide/highlight/fonts + 业务 chat-bridge/chat-stream-core/vendor-workers——**无 tiptap/xterm 族**；
- tiptap 唯一消费入口：`src/components/chat-composer/TiptapEditorField.tsx:15-28`（@tiptap/react/core/starter-kit/extension-link/placeholder/task-list/task-item/suggestion；@tiptap/pm 为其传递依赖，2.8MB）；当前加载链全部静态：ChatComposer.tsx:21 → TiptapComposerField.tsx:17 → TiptapEditorField；
- xterm 唯一消费入口：`src/components/workspace/TerminalCard.xterm.tsx:18-21`（@xterm/xterm + addon-fit + addon-webgl + `@xterm/xterm/css/xterm.css`）；两个消费端：`TreeLeafPanel.tsx:37-38` **已 React.lazy**、`CardPanelLayout.tsx:5` **静态 import**（缺口）。

### 2.2 任务清单

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T2-1 | manualChunks 增补 `vendor-tiptap` / `vendor-xterm` 两族 | `apps/crish-desktop/vite.config.ts:221-241`（node_modules 分支内追加两行，语义定位） | P2-4 | ✓ |
| T2-2 | chunk size 警告升级为构建失败门禁：删 `chunkSizeWarningLimit: 1100`（:216），`rollupOptions.onwarn` 捕获 `CHUNK_SIZE_WARN` 抛错；阈值**先拆分后校准**（步骤 1 清单 + 本步实测） | 同上（build 段） | P2-4、N4 | ✓ |
| T2-3 | `scripts/check-dist.mjs` 增补强制断言：vendor-tiptap/vendor-xterm 存在、App chunk < 500KB（`--max-app-kb 500`） | `scripts/check-dist.mjs` | P2-4 | ✓ |
| T2-4 | 懒加载点移交清单（07 轨道输入物，写注释/移交记录，见 §2.4） | 移交记录（附于本文档 §2.4 + 07 派单时引用） | 07 依赖锚点 | ✓ |

### 2.3 manualChunks 配置草案（T2-1）

```ts
manualChunks(id) {
  const n = id.replace(/\\/g, '/');
  if (n.includes('node_modules')) {
    if (n.includes('react-dom') || n.includes('/react/')) return 'vendor-react';
    if (n.includes('zustand') || n.includes('immer')) return 'vendor-zustand';
    if (n.includes('lucide-react')) return 'vendor-lucide';
    if (n.includes('highlight.js')) return 'vendor-highlight';
    if (n.includes('@fontsource')) return 'vendor-fonts';
    if (n.includes('@tiptap')) return 'vendor-tiptap';   // 新增（@tiptap/pm 亦命中）
    if (n.includes('@xterm')) return 'vendor-xterm';     // 新增
  }
  // business-stable splits 保持不动（:233-241）
}
```

- `n.includes('@tiptap')` 同时命中 `@tiptap/*` 全部子包与 `@tiptap/pm`（prosemirror）——无需单独列 prosemirror；
- `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl` 三包全部命中（:18-21 实读）；xterm css（`@xterm/xterm/css/xterm.css`）随 chunk 打包，正常；
- 保持函数式 + 反斜杠归一（Windows-safe 既有模式，不引入字符串匹配新形态）。

### 2.4 onwarn 门禁草案（T2-2）

```ts
rollupOptions: {
  onwarn(warning, warn) {
    if (warning.code === 'CHUNK_SIZE_WARN') {
      throw new Error(
        `chunk size 超限门禁：${warning.message} —— 拆分或校准阈值后放行`
      );
    }
    warn(warning);
  },
}
```

- **阈值校准流程（重要，先拆分后定阈值）**：T2-1 落地 → 本地 build 实测各 chunk 大小 → 按「App chunk < 500KB 目标 + vendor-tiptap 实测值 +20% 余量」设定 `chunkSizeWarningLimit`（估算：tiptap 5.4MB + prosemirror 2.8MB 源 → minify 后 raw 约 400~600KB；xterm 7.9MB 源 → 约 250~400KB——**估算基于审计 §2.1，以实测为准**）；
- 若 vendor-tiptap 实测 raw > 500KB，**不得**为它单开 500 上限豁免 App 断言——`check-dist.mjs` 的 App 专属断言（T2-3，按文件名 `App-*.js` 匹配）与全局 chunkSizeWarningLimit 双轨：全局阈值管所有 chunk 不超限、App 专属 500KB 管主业务 chunk 目标（06 风险 R3 缓解：阈值参数化，校准以步骤 1 清单为据）。

### 2.5 体积目标

| chunk | 现状（审计 §4.1 实测） | 目标 |
|---|---|---|
| App-*.js | 1137.5 KB | **< 500 KB**（拆分后预计 300~450KB，实测校准） |
| vendor-tiptap | —（并入 App） | 存在即可（raw 估算 400~600KB，实测校准阈值） |
| vendor-xterm | —（并入 App） | 存在即可（raw 估算 250~400KB） |
| chunk 总数 | 72 js | ≤ 现状 + 2（拆分不引入碎片化；rollup 可能合并更少） |

### 2.6 懒加载点清单（T2-4 移交物，实读）

> 06 只做**静态 chunk 边界**；以下为 07 运行时懒加载的候选点清单（正交可叠加，06 先行不阻塞；07 落地时若 vendor-tiptap lazy 化，首开会话有短暂 chunk 拉取，需 Suspense fallback = 既有 ComposerField/加载态，**标注：避免闪烁见 §8 R1**）。

| 族 | 唯一入口 | 当前加载方式 | 懒加载候选点 |
|---|---|---|---|
| tiptap | `TiptapEditorField.tsx:15-28`（全图 8 包 + pm） | 静态：ChatComposer.tsx:21 → TiptapComposerField.tsx:17 → TiptapEditorField（eager 链） | `ChatComposer.tsx:21`（React.lazy(TiptapComposerField)，textarea 降级分支可作 fallback） |
| xterm | `TerminalCard.xterm.tsx:18-21`（3 包 + css） | 双入口：TreeLeafPanel.tsx:37 **已 lazy**；CardPanelLayout.tsx:5 **eager** | `CardPanelLayout.tsx:5` 改 React.lazy（与 TreeLeafPanel 既有模式一致） |

### 2.7 验证（步骤 2）

- `npm run build:desktop` → 无 CHUNK_SIZE_WARN 抛错、dist 出现 vendor-tiptap/vendor-xterm、App chunk < 500KB；
- `npm run check:dist -- --max-app-kb 500` 全过；
- `npm run test:coverage -- --project=unit` 回归（拆分不改加载逻辑，纯结构变化；若有 import 图变化走 depcruise 门禁）。

---

## ③ CSP 分层实现（06-步骤 3，P1-2）

### 3.1 现状事实与**方案修正**（实读确认）

| # | 事实 | 证据 | 对本计划的影响 |
|---|---|---|---|
| 1 | index.html:13 静态宽 CSP meta（dev/prod 共享，构建后原样进 dist，已实测 dist/index.html 同一串） | 实读 + dist 实测 | 删除该 meta，唯一真源移交插件 |
| 2 | tauri.conf.json:29 严格 security.csp（无 unsafe-eval，connect-src 收敛 8765 清单，含 `http://ipc.localhost`、asset: 面） | 实读 | 移除该字段（保留 assetProtocol :25-28） |
| 3 | N1（02-review 源码级证实）：Tauri 注入是**追加**第二个 CSP meta 而非替换 → CSP3 交集语义，当前生产包实际执行严格面 | tauri-utils-2.9.3/src/html2.rs:84-90 append_child | 单 policy 化后语义显式化；交集下被禁的两面（内联 script、blob worker）在单 policy 下行为变化，见下 |
| 4 | **修正 06 方案 §4.3 设计点 1 的事实错误**：方案称"index.html 无内联 script，已实证"——**不成立**。index.html:143-177 存在内联主题/字体预载 script（theme/font pre-loader），vite 构建后**原样保留**（已实测 dist/index.html 有 1 个内联 script） | 实读 index.html:143-177 + dist 实测 | 严格串必须为内联 script 提供放行手段（§3.3），否则 prod 主题预载静默失效 + violation 噪音 |
| 5 | 交集语义下（script-src 交集 = 'self'）：该内联 script **在现状生产包已被静默拦截**——主题预载 prod 不生效（由运行时 themeStore 兜底）+ 控制台 violation 噪音 | N1 推论 | 本步借机修复：hash 放行后内联 script 在 prod 真实生效（行为**改善**，非回归） |
| 6 | worker-src 交集 = 'self'：blob worker 现状被禁（现 worker 全静态 URL，worker-pool.ts:404 `new URL(..., import.meta.url)`，无影响）；单 policy 保留 `blob:` 后为**放宽**（恢复与 dev 一致） | 实读 | 冒烟验证无回归 |
| 7 | connect-src 收敛破坏面核查：前端直连面 = previewCardLib.ts:15 `http://127.0.0.1:8765`（预览浏览器 daemon）+ tauri IPC；供应商 API 全走 dev 代理（crishHttpProxyPlugin 仅 configureServer，不进 prod）——**无其它远程直连** | 实读 | 收敛清单安全 |
| 8 | frame-src 核查：PreviewCard 内嵌远程 http/https iframe（previewBrowserStore.ts:340 isEmbeddablePreviewUrl 允许 http/https/about:blank）——**现状交集下已被 default-src 'self' 禁止**（meta 无 frame-src 时回落 default-src），本步**不引入新破坏** | 实读 + CSP3 语义 | 登记为已知限制（§8 R2），不扩 frame-src |
| 9 | dev 面：dev 由 vite dev server 直接服务（tauri devUrl=5174），无 tauri HTML 处理（注入面在打包期）——dev 现状 = 仅宽 meta 生效 | tauri.conf.json:8 + 机制推断（不确定处，见 3.6） | dev 串与现状字面等价即可，无论 Tauri 是否在 dev 注入，行为不变 |

### 3.2 任务清单

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T3-1 | vite.config.ts 新增 `cspPlugin()`：transformIndexHtml 按 mode 注入（dev 宽松 / prod 严格），prod 串含内联 script 的 sha256 hash（自动计算） | `apps/crish-desktop/vite.config.ts`（新增函数 + plugins 数组 :196 追加） | P1-2、N1 | ✓ |
| T3-2 | index.html 删除静态 CSP meta（:13）——CSP 唯一真源移交插件 | `apps/crish-desktop/index.html` | P1-2 | ✓ |
| T3-3 | tauri.conf.json 移除 `security.csp`（:29），保留 assetProtocol（:25-28）；JSON 合法性复验（security 剩 assetProtocol，合法） | `apps/agent-workbench/src-tauri/tauri.conf.json` | P1-2、N1 | ✓ |
| T3-4 | check-dist.mjs CSP 断言切**强制**（`--csp-enforce`，CI job 固定加参）；本地 `tauri build` 一次抽查打包产物 index.html 仅一份严格 policy | `scripts/check-dist.mjs`、发布产物抽查 | P1-2 | ✓ |
| T3-5 | CSP 切换点登记：isolation pattern 启用时需回到 tauri.conf.json 配 csp（反向迁移，同样单源）；登记位置 = 本文档附录 + `docs/`（若有 tauri 配置说明文档则同步，主控定夺最终落点） | 文档登记 | 06 风险 R1 | ✓ |

### 3.3 cspPlugin 设计（T3-1 草案）

```ts
import { createHash } from 'node:crypto';

const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self' ipc: http: https: ws: wss:;";   // = 现 index.html:13 字面串（零变化）

function cspPlugin(): Plugin {
  return {
    name: 'crish-csp',
    transformIndexHtml(html, ctx) {
      const isProd = !ctx.server; // dev 有 server，build 无
      let content: string;
      if (!isProd) {
        content = DEV_CSP;
      } else {
        // 对 html 中无 src 的内联 <script> 计算 sha256（静态内容，hash 稳定；
        // 若未来内联 script 变更，hash 自动跟随，无漂移）
        const hashes: string[] = [];
        const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        while ((m = inlineRe.exec(html))) {
          hashes.push(
            `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`
          );
        }
        content = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; ...`; // 见 3.4 终串
      }
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content,
            },
            injectTo: 'head',
          },
        ],
      };
    },
  };
}
```

- dev/build 判定：`ctx.server` 存在 → dev（vite serve 同样走 transformIndexHtml，dev 也由插件注入，保证"唯一真源"两端成立）；
- 若未来内联 script 被删/改，hash 清单自动为空/更新，无人工同步点。

### 3.4 prod 严格串（最终版——**基于 tauri.conf.json:29 现串逐指令对齐，比 06 方案 §4.3 草稿多三处修正**）

```
default-src 'self'; script-src 'self' 'sha256-<内联theme-script-hash>'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; media-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src 'self' ipc: http://ipc.localhost http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765; worker-src 'self' blob:; frame-src 'self' asset: http://asset.localhost https://asset.localhost; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'
```

与 06 方案 §4.3 草稿的差异（修正依据 = "connect-src 清单与 tauri.conf.json 现串一致"原则的补全）：

| 指令 | 草稿 | 修正 | 理由（实读） |
|---|---|---|---|
| script-src | `'self'` | `'self' 'sha256-…'` | 内联主题 script 必须放行（§3.1 #4/#5） |
| connect-src | 缺 `http://ipc.localhost` | 补入 | tauri v2 IPC 的 http 形态，现串有（tauri.conf.json:29） |
| img-src / media-src | 缺 `asset: http://asset.localhost https://asset.localhost` | 补入 | assetProtocol 已启用（:25-28），FilePreview.tsx:119 PDF iframe 与 $APPDATA 资源面依赖 |
| frame-src | 缺 | 补入现串 | PreviewCard 本地资源面 + 与现状交集一致（§3.1 #8） |
| script-src | 草稿已删 `wasm-unsafe-eval` | 保持删除 | 当前无任何 wasm 依赖（xterm webgl 是 WebGL API 非 wasm，实读 @xterm/addon-webgl 为 JS 实现）；注释登记：未来引入 wasm 依赖时回填 `'wasm-unsafe-eval'` |

- style-src 保留 `'unsafe-inline'`：骨架屏内联 CSS（index.html:17-140）依赖（方案已声明，成立）；
- check-dist.mjs 强制断言集（T3-4）：恰 1 个 CSP meta；不含 `unsafe-eval`；script-src 不含 `unsafe-inline`；connect-src 不含泛化 `http:` / `https:` / `ws:` / `wss:`（仅允许具体 localhost 条目）；script-src 含 `sha256-` 前缀条目。

### 3.5 验证（步骤 3）

| 面 | 命令 | 判据 |
|---|---|---|
| dev | `npm run dev:desktop` 手动回归：HMR、骨架屏替换、tiptap 编辑器、xterm 终端、主题预载 | 行为与改前一致（dev 串 = 现字面串） |
| prod 产物 | `npm run build:desktop` + `npm run check:dist -- --csp-enforce` | 单 policy、无 unsafe-eval、无泛化 connect、含 hash |
| 发布包 | 本地 `tauri build` 一次，抽查打包产物内 dist/index.html | 仅一份严格 policy（无 Tauri 追加的第二 meta） |
| 运行面 | 步骤 ⑥ e2e-prod 冒烟（严格 CSP 下跑主流程 + 控制台无 violation） | 见 §⑥ |

### 3.6 不确定处标注

- Tauri v2 在 dev 模式是否注入 CSP：未深究（注入面在打包期是明确事实；dev 由 dev server 直服）。本方案 dev 串与现状字面等价，**无论是否注入行为不变**，不构成风险；
- sha256 hash 方案依赖"vite 构建透传内联 script 原文"（已实测 dist 保留）；若未来 vite 版本改写内联 script 内容，hash 自动重算仍正确——方案自洽；若未来引入**动态内容**的内联 script，hash 将失效，届时改用备选方案 B（抽 `public/theme-init.js` 外链，非模块 script 在 head 中执行，需验证渲染时序）。

---

## ④ 锁文件清理（06-步骤 4，P2-3）

### 4.1 现状（实读确认）

| 文件 | 大小 | 内容问题 | 跟踪面 |
|---|---|---|---|
| `apps/crish-desktop/package-lock.json` | 99KB | lucide-react 声明 `^1.20.0`（:12/:2179），与 app package.json:44 `^0.525.0` 不符 | **已 git 跟踪**（git ls-files 实读确认） |
| `apps/crish-desktop/pnpm-lock.yaml` | 42KB | 2026-08-01 pnpm 实验残留 | **已 git 跟踪** |
| `apps/crish-desktop/pnpm-workspace.yaml` | 52B | 占位注释 `allowBuilds: esbuild: …` | **已 git 跟踪** |

- 根 `package-lock.json`（642 packages）：lucide 为 `^0.525.0`（:87 实读），与 app package.json 一致；唯一真源无冲突。

### 4.2 任务清单

| # | 任务 | 文件面 | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T4-1 | `git rm` 三份过期锁文件并独立提交（删除前 `git log --oneline -- <file>` 确认为 pnpm 实验引入，无历史依赖；实测已跟踪，直接 git rm 即可） | `apps/crish-desktop/` 三文件（删除） | P2-3 | ✓ |
| T4-2 | 验证：根 `npm ci` 全绿；`apps/crish-desktop` 内执行 `npm install --package-lock-only --dry-run` 不产生新锁（hoist 到根锁）；`git status` 干净 | 无改动（验证面） | P2-3 | — |

- **排期建议**：本任务独立无耦合（06 步骤 4 声明），建议**批次内最先执行**（03-review 批 14 建议：锁文件删除最早做，npm ci 面干净）——可与 T5-4（format 基线）并行。

---

## ⑤ lint 口径（06-步骤 5，P2-5）

### 5.1 现状（实读确认）

- ci.yml:58 `npx eslint .`——无 `--max-warnings 0`（CI 不红但本地红，门禁漂移）；
- 根 `package.json:54` `lint:all = eslint . --ext .ts,.tsx --max-warnings 0 && npx --yes stylelint@16 "apps/crish-desktop/src/**/*.css"`——stylelint **未锁定**（npx 每次拉最新 16.x；npm registry 实测 16.x 最新 = **16.26.1**）；
- `.stylelintrc.cjs` 仅 1 条 warning 级规则（`declaration-no-important`，实读确认）——规则升级归 01-S7（C16），本轨道不动；
- `format`（prettier --check .）不在 CI；`.prettierignore` 已排除 `packages/shared-types/src/generated/`（实读确认，无格式噪音隐患）；lint-staged 已配 prettier --write（根 package.json:88-99）。

### 5.2 任务清单

| # | 任务 | 文件面 | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T5-1 | root devDependencies 增加 `"stylelint": "^16.26.1"`（锁定 16.x 具体版本，执行时 `npm view stylelint@16 version` 复核最新后锁死）；`lint:all` 去掉 `npx --yes` 前缀直调 stylelint | `package.json`（devDependencies + scripts:54） | P2-5、N5 | ✓ |
| T5-2 | ci.yml lint job 改 `npx eslint .` → `npm run lint:all`（depcruise 步骤保留）；**前置**：步骤 0 基线记录的 eslint 存量 warning 在 `--max-warnings 0` 下清零（存量 > 0 则先单独提交清零，再切门禁——避免 CI 首红） | `.github/workflows/ci.yml:58` | P2-5 | ✓ |
| T5-3 | ci.yml 新增 `format` job（`npm run format`，prettier --check .；结构同 lint job，npm ci + 单命令） | `.github/workflows/ci.yml` | P2-5、N6 | ✓ |
| T5-4 | 一次性 `npm run format:write` 全仓 prettier 基线——**独立首个提交**（03-review ⑥-7 强制：在任何功能批前落地，否则每批 diff 带格式噪音）；执行前 git status 确认干净，提交内容限定 format 改动 | 全仓（格式化基线提交） | N6、06 风险 R4 | ✓ |

### 5.3 验证（步骤 5）

- 本地 `npm run lint:all` 与 `npm run format` 全绿后提交；
- CI lint / format 两 job 绿；本地口径 = CI 口径（消除漂移）。

---

## ⑥ preview 冒烟（06-步骤 6，P1-1 后半）

### 6.1 可行性依据（实读确认）

- `tests/e2e/mock-engine.ts:390` 已注入 `window.__TAURI_INTERNALS__`（N8，02-review 复核成立），`installMockEngine(page, runStream)`（:436）可复用——生产形态无需 tauri-driver 真壳；
- `apps/crish-desktop/package.json:11` `preview: vite preview`；`vite preview` 默认端口 4173，与 dev 的 5174 互不冲突（06 方案 R5 已列）；
- 现有 `tests/e2e/console-errors.spec.ts:4-28` 提供 console error 收集断言模式可仿（page.on('console') + pageerror + 断言 0 条）。

### 6.2 任务清单

| # | 任务 | 文件面 | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T6-1 | 新建根 `playwright.prod.config.ts`（独立 config，不触碰现 playwright.config.ts 与 dev 面 26 用例） | `playwright.prod.config.ts`（新增） | P1-1 | ✓ |
| T6-2 | 新建 `tests/e2e/prod-smoke.spec.ts`（5 条冒烟用例，独立文件，**不触碰** 5 个 markdown-editor 保护 spec） | `tests/e2e/prod-smoke.spec.ts`（新增） | P1-1 | ✓ |
| T6-3 | ci-mid.yml 新增 `e2e-prod` job（独立 job，避免与既有 e2e job 的 webServer 编排耦合） | `.github/workflows/ci-mid.yml` | P1-1 | ✓ |

### 6.3 prod 配置草案（T6-1）

```ts
// playwright.prod.config.ts —— 生产形态冒烟（06-步骤6）：
// vite preview 服务 dist（严格 CSP + minify + 真实 chunk），mock 引擎注入复用。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /prod-smoke\.spec\.ts$/,
  timeout: 30_000,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npm --workspace @crish/crish-desktop run preview -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
```

### 6.4 prod-smoke 用例清单（T6-2 草案）

| # | 用例 | 断言 | 覆盖的生产专属面 |
|---|---|---|---|
| 1 | 应用加载 | title / #root 渲染 / `.app-initial-loader` 骨架屏被替换消失 | minify + 严格 CSP 下首屏 |
| 2 | 控制台零错误 | 仿 console-errors.spec.ts 模式收集 console error + pageerror，断言 0 条（含 CSP violation 字样计数） | **严格 CSP 无 violation**（06 步骤 3 验收面） |
| 3 | tiptap 编辑器可用 | 进入会话 → 输入文字 → 编辑器渲染（waitFor 收口） | vendor-tiptap chunk 真实加载 + 严格 CSP 下 contenteditable 正常 |
| 4 | 终端面板懒加载 | 打开终端面板（CardPanelLayout/TreeLeafPanel 路径）→ xterm 渲染 | vendor-xterm chunk 真实加载 |
| 5 | daemon mock 主流程 | `installMockEngine` → 发送消息 → 助手回复渲染 | PROD 分支行为（MCP 门控不挂 guest、DevHealthOverlay 不加载——page.evaluate 断言）；import.meta.env.PROD 分岔面 |

- 断言重点（生产专属面，dev 跑不到）：严格 CSP 生效（用例 2）、PROD 分支（用例 5，`window.__TAURI_INTERNALS__` mock 注入在 PROD 同样适用）、懒加载 chunk 真实路径（用例 3/4 隐式覆盖 200 加载）。

### 6.5 ci-mid.yml e2e-prod job 草案（T6-3）

```yaml
  # 生产形态冒烟（06-步骤6）：vite preview 服务 dist（严格 CSP + minify + 真实 chunk）。
  # 依赖 build 产物：shared-types 先构建（N2），build:desktop 后接 preview。
  e2e-prod:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build:shared-types
      - run: npm run build:desktop
      - run: npx playwright test --config playwright.prod.config.ts
```

### 6.6 验证（步骤 6）

- 本地：`npm run build:desktop; if ($?) { npx playwright test --config playwright.prod.config.ts }` 全绿；
- CI 中层 job 绿；dev 面 e2e 全量不受影响（5 个 markdown-editor 保护 spec 保持绿——本轨道不触碰 reference/ 与 5 个 spec 文件）。

---

## ⑦ 验证与提交（步骤 0 + 步骤 7 + 批次 7 收口）

### 7.1 步骤 0 基线测量（T7-1，纯记录无改动；C21 定夺：基线记录**内嵌于本文档附录**，避免悬空）

| # | 命令 | 记录项 |
|---|---|---|
| 1 | `npm run format` | prettier 存量失败文件清单与数量 |
| 2 | `npx --yes stylelint@16 "apps/crish-desktop/src/**/*.css"` | warning/error 计数 |
| 3 | `npx eslint . --max-warnings 0` | 存量 warning 计数（T5-2 清零前置） |
| 4 | `npm run build:desktop` | chunk 清单（名称/字节）、警告数、耗时（步骤 1/2 对照基线） |
| 5 | `Test-Path packages/shared-types/dist` | 存在性 + 最后构建时间（步骤 1 依赖确认） |
| 6 | `git status` | 干净确认（派单前必须执行，03-review P0-4 纪律） |

### 7.2 收尾任务（06-步骤 7）

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T7-1 | 步骤 0 六项基线测量并记录（附录表） | 记录（本文档附录） | 06-步骤0 | — |
| T7-2 | 死脚本删除：`check-tsc-threshold.mjs` / `check-coverage-threshold.mjs`（全仓 grep 仅自引用，语义已被 typecheck 7 段直跑与 vitest coverage 阈值覆盖；删除后全仓 grep 无引用再提交） | `scripts/`（删除 2 文件） | P2-7 | ✓ |
| T7-3 | `dev: "vite --force"` → `"vite"`（app package.json:9）；依赖 optimizeDeps 自动失效（vite.config.ts:204 exclude MCP SDK 保留）；冷启动一次验证 | `apps/crish-desktop/package.json:9` | P3-9 | ✓ |
| T7-4 | 迁移窗口登记（**仅登记不实施**）：12 项 major 落后（vite 7→8、vitest 3→4、lucide 0.525→1.30、eslint 9→10、TS 5.9→7.0.2、zod 3 停更等，审计 §2.4 清单）+ N3（process.platform 平台分支显式化）+ tsconfig 严格项回收（P2-8，归 05 轨道）+ wasm 回填注释（§3.4） | 文档登记（本文档附录 + docs 配置说明处） | P2-6、P2-8、N3 | ✓ |

### 7.3 批次 7 提交清单（T7-5，顺序 = 依赖链）

| 序 | 提交 | 内容 | 前置 |
|---|---|---|---|
| 1 | chore: 删除 app 三份过期锁文件 | T4-1 | —（可最先） |
| 2 | chore: prettier 全仓格式化基线 | T5-4 | git status 干净 |
| 3 | feat: frontend-build job + check-dist.mjs（登记版） | T1-1~T1-3 | 步骤 0 基线 |
| 4 | feat: vendor-tiptap/vendor-xterm 拆分 + onwarn 门禁 | T2-1~T2-4 | 提交 3（chunk 清单基线） |
| 5 | feat: CSP 分层（插件 + index.html + tauri.conf.json + check-dist 强制） | T3-1~T3-5 | 提交 3/4（check-dist 演进） |
| 6 | chore: lint 口径对齐（stylelint 锁定 + lint:all + CI lint/format job） | T5-1~T5-3 | 提交 2（format 基线） |
| 7 | feat: e2e-prod preview 冒烟 | T6-1~T6-3 | 提交 4/5（产物 + 严格 CSP） |
| 8 | chore: 死脚本删除 + dev --force 移除 + 迁移窗口登记 | T7-2~T7-4 | 提交 1~7 全绿 |

**每提交前门禁**：`npm run typecheck` + `npm run test:coverage -- --project=unit` + `npm run lint:all` + `npm run format`（批次 9.3 全量复跑在 master plan 收口，本轨道提交内自检即可）。

**批次 7 全量验证**（提交 8 之后）：
- 快层：typecheck / lint:all / format / vitest-fast / frontend-build / engine-bindings-drift 全绿；
- 中层：vitest 全量 + F3 四目录 + e2e（5 保护 spec）+ e2e-prod 全绿；`cargo test --workspace`（本轨道无 Rust 改动，rust-check/clippy 覆盖即可）；
- 发布面：本地 `tauri build` 一次抽查产物（T3-4）；`npm run build:workbench` 冒烟（tauri 配置面改动后确认 beforeBuildCommand 链仍通）。

### 7.4 归属声明

- 批次 7.3（05 吞错 AST 门禁 + 行数门禁接线，master plan 批次 7 内容）**不在本轨道**——归 05 轨道派单；本轨道不触碰 `scripts/check-swallowed-errors.mjs` / `check-line-counts.mjs`；
- 与 03-review 批 14 的排期建议对齐：锁文件（T4）最早、format 基线（T5-4）在任何产生新代码的批前落地。

---

## ⑧ 风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **chunk 拆分运行时行为变化（懒加载闪烁）**：本轨道只做静态拆分，**不改加载时机**——无新增闪烁；但移交 07 的 lazy 化（§2.6）会引入首开会话/终端的 chunk 拉取延迟（tauri:// 本地协议，磁盘读取级，约 200-500ms 量级） | 中 | T2-4 移交清单强制 07 使用 Suspense fallback（既有 ComposerField/加载态）衔接骨架屏；静态拆分先行使"即使同步加载也不超限"，闪烁面与 06 解耦 |
| R2 | **CSP 收窄破坏面**：严格串 = 现状交集语义的显式等价 + 2 处**放宽**（内联 script 经 hash 放行恢复执行、worker blob 恢复）——**不引入新收窄**；唯一已知限制 = PreviewCard 远程 http/https iframe 内嵌被禁（**现状交集已禁，非新破坏**，previewBrowserStore.ts:340 允许的 http/https 面在 prod 本就不通） | 低 | 已知限制登记（T3-5）；e2e-prod 用例 2 断言零 violation 守护运行面；check-dist `--csp-enforce` 守护产物面 |
| R3 | **unsafe-eval 依赖面**：实读未发现生产代码 eval/new Function 依赖（tiptap/xterm/highlight.js/dompurify 均无）；风险 = 未来引入 eval 依赖在 prod 静默失效（dev 宽松串保留 unsafe-eval 覆盖 vite/HMR 需要） | 低 | check-dist 断言 + e2e-prod 用例 2 双守护；CSP 切换点登记文档提示"新增依赖前对照 connect/script 清单" |
| R4 | **vendor-tiptap raw 体积可能 > 500KB**：onwarn 全局阈值误伤（06 方案 R3） | 低 | "先拆分后定阈值"（T2-2 校准流程）；App 专属 <500KB 断言与全局阈值双轨（§2.4），vendor-tiptap 不按 500 硬卡 |
| R5 | **prettier 全仓基线 diff 噪音**：format:write 若与功能批混提，评审面失控（06 方案 R4） | 中 | T5-4 独立首个提交（§7.3 提交 2），后续门禁只管新变更（lint-staged 已兜底） |
| R6 | **build job 拉长快层预算**（shared-types + tsc -b + vite build 全链） | 低 | 独立 job 并行 + npm ci 缓存（06 方案 R6 同）；与 typecheck 职责重叠但口径统一优先 |
| R7 | **依赖升级窗口与 manualChunks/onwarn API 耦合**：vite 7→8 可能改变 API 形态 | 中 | T7-4 登记迁移窗口在步骤 2 后独立开启；frontend-build + e2e-prod 为回归锚点（06 方案 R7 同） |
| R8 | **tauri 打包产物不在 CI 验证面**：本轨道 CI 覆盖到 vite dist 层，`tauri build` 产物抽查为本地一次验证 | 低 | T3-4 本地抽查 + 发布流程验证登记；devUrl/frontendDist/beforeBuildCommand 链在 T3-3 改动后跑一次 `npm run build:workbench` 冒烟（§7.3） |

---

## 附录 A：步骤 0 基线记录（T7-1 落盘处）

> 执行 Agent 于开工前填写（六项命令原文输出留存）：

| # | 命令 | 结果（执行时填写） |
|---|---|---|
| 1 | `npm run format` | 失败文件数：____ |
| 2 | stylelint 扫描 | warning: ____ / error: ____ |
| 3 | `npx eslint . --max-warnings 0` | 存量 warning：____ |
| 4 | `npm run build:desktop` | chunk 清单（见下）+ 警告数：____ + 耗时：____ |
| 5 | shared-types/dist | 存在：____ / 构建时间：____ |
| 6 | `git status` | 干净：____（若脏，先按 03-review P0-4 处理 messageSnapshotsBridge.ts 脏状态） |

chunk 清单（步骤 4 输出，粘贴）：

```
（执行时粘贴 check-dist.mjs 输出的 { name, bytes } 清单）
```

## 附录 B：CSP 切换点登记（T3-5 落盘处）

- **现状**：CSP 唯一真源 = `apps/crish-desktop/vite.config.ts` cspPlugin（dev 宽松 / prod 严格，注入 dist/index.html）；`tauri.conf.json` 不再携带 csp（2026-08-09 移除）。
- **切换点 1（isolation pattern）**：若未来启用 Tauri isolation pattern，需回到 `tauri.conf.json` 配置 `security.csp`，并从 index.html 移除 meta（反方向迁移，同样保持单源）；届时本插件 prod 分支停用或改为仅 dev 注入。
- **切换点 2（wasm 依赖）**：引入 wasm 依赖时，prod 串 script-src 回填 `'wasm-unsafe-eval'`（当前 xterm webgl 为 WebGL API 非 wasm，已核实）。
- **切换点 3（新依赖引入）**：新增远程直连 / 内联 script / blob worker / iframe 面时，对照 prod 串的 connect-src / script-src / worker-src / frame-src 清单评估；`check-dist.mjs --csp-enforce` 持续守护产物面。

## 附录 C：任务数汇总

① CI build job 3 项（T1-1~T1-3）+ ② chunk 拆分 4 项（T2-1~T2-4）+ ③ CSP 分层 5 项（T3-1~T3-5）+ ④ 锁文件 2 项（T4-1~T4-2）+ ⑤ lint 口径 4 项（T5-1~T5-4）+ ⑥ preview 冒烟 3 项（T6-1~T6-3）+ ⑦ 验证提交 5 项（T7-1~T7-5）= **26 项文件级任务**。

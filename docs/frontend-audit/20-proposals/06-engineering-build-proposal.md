# 工程化与构建维度 · 修复方案（06）

- 方案依据：`docs/frontend-audit/10-analysis/06-engineering-build-audit.md`（主审计）+ `docs/frontend-audit/00-cross-analysis.md`（主控交叉结论 P1-9/P2 批次）+ 本方案新发现（§5）
- 方案日期：2026-08-09
- 修复范围：P1-1（生产构建进 CI）、P1-2（CSP 按 mode 收紧）、P2-3（过期锁文件）、P2-4（App chunk 拆分）、P2-5（lint 口径统一进 CI），顺带处理 P2-7（死脚本）、P3-9（dev --force）；P2-6（依赖过时）仅登记迁移窗口，不属本方案实施面
- 方案性质：系统性工程化收口，共 **8 个步骤**（步骤 0 基线 + 步骤 1~6 主流程 + 步骤 7 收尾），步骤间按逻辑顺序闭环（前步输出 = 后步输入），与 07 性能方案仅 chunk 拆分存在依赖标注（§2.2）

---

## ① 目标态

| 维度 | 现状 | 目标态 |
|---|---|---|
| 生产构建 | 三层 CI 无任何 `vite build`；产物只在开发者本机验证；e2e 全跑 dev server | 快层独立 `frontend-build` job：CI 中始终绿、产物有机器断言；中层新增生产 preview 冒烟（生产形态被自动化执行） |
| CSP | index.html 静态宽 CSP（`unsafe-eval` + `connect-src http: https: ws: wss:`）与 tauri.conf.json 严格 csp 双源并存（交集语义，隐式且脆弱） | 单一真源：vite 插件按 mode 注入（dev 宽松 / prod 严格）；tauri.conf.json 移除 csp 配置；prod 严格串无 `unsafe-eval`、`connect-src` 收敛到 ipc: + daemon 地址清单；CI 断言 dist 无宽 CSP 残留 |
| chunk 拆分 | App chunk 1137.5KB 超限（tiptap+prosemirror+xterm 全在主 chunk），`chunkSizeWarningLimit: 1100` 已失效 | tiptap 族 → `vendor-tiptap`、xterm 族 → `vendor-xterm`；App chunk < 500KB；chunk size 警告升级为 build 失败（阈值 = 门禁而非降噪开关） |
| 锁文件 | apps/crish-desktop 内三份过期锁文件（package-lock 99KB / pnpm-lock 42KB / pnpm-workspace 占位），lucide 声明 `^1.20.0` 与当前不符 | 三文件删除，根 package-lock.json 为唯一真源；`npm ci` 在 CI 与本地全绿 |
| lint 口径 | CI `npx eslint .` 无 `--max-warnings 0`；stylelint/prettier 均不在 CI | CI lint job 对齐本地 `lint:all`（含 `--max-warnings 0` + stylelint）；prettier `--check` 纳入快层；stylelint 版本锁定进 devDependencies |

**入口条件（本方案启动前提）**：`cargo test --workspace` 基线绿、快层 vitest 门禁绿（AGENTS.md 口径）——本方案所有步骤不得破坏既有门禁。

---

## ② 分步方案

### 步骤 0：现状基线固化（前置）

**任务内容**：为后续每步的"完成判据"提供可复测的现状基线，一次跑清六个口径：

1. 全仓格式基线：`npm run format`（prettier --check）——记录当前失败文件清单与数量（预计有存量，见 §5 N6）；
2. stylelint 现状：`npx --yes stylelint@16 "apps/crish-desktop/src/**/*.css"`——记录 warning/error 数（`.stylelintrc.cjs` 仅 1 条 warning 级规则，见 §5 N5）；
3. eslint 存量：`npx eslint . --max-warnings 0`——记录存量 warning 数（当前 CI 无 `--max-warnings 0` 掩盖的漂移量）；
4. 本地生产构建：`npm run build:desktop`——记录 chunk 清单（大小/名称）、警告数、构建耗时（作为步骤 1/2 的对照基线）；
5. shared-types dist 现状：确认 `packages/shared-types/dist/` 是否存在及最后构建时间（决定步骤 1 是否需要显式先构建，见 §5 N2）；
6. `git status` 干净确认（步骤 4 删锁文件前的落点）。

**涉及文件面**：无代码改动（纯测量记录）；产出记录写入 `docs/frontend-audit/30-reviews/06-baseline.md`（或仅本方案附录，主控定夺）。

**验证方式**：六项测量命令均可独立复跑；基线数字与命令输出原文留存。

**完成判据**：六项基线全部记录在案；步骤 0 本身不产生任何源码改动。

---

### 步骤 1：生产构建进 CI（快层独立 job）

**任务内容**（对应 P1-1 前半）：

1. 在 `.github/workflows/ci.yml` 新增 `frontend-build` job（与现有 10 个 job 并行，独立 `npm ci`，快层预算内）：
   - 前置：先构建 shared-types——`npm --workspace @crish/shared-types run build`（vite production 解析 `exports.default → dist/index.js`，CI 无 dist 缓存必须先行构建，§5 N2）；
   - 主命令：`npm run build:desktop`（与本地 `npm run build` 同口径，含 `tsc -b`，避免口径漂移）；
   - 后置断言：执行新增 `scripts/check-dist.mjs`（见步骤 2 联用，先落地"CSP 断言 + chunk 清单断言 + 无警告断言"三件套的最小版本——CSP 断言在步骤 3 收窄后从"登记"转为"强制"）。
2. 新增 `scripts/check-dist.mjs`：解析 `apps/crish-desktop/dist/`，断言：
   - `index.html` 不含 `unsafe-eval`（步骤 3 之前为"登记"模式：仅输出现状，不失败；步骤 3 完成后切"强制"）；
   - 输出各 chunk 名称与字节数（供步骤 2 调阈值）。
3. e2e 生产形态冒烟（P1-1 后半）暂不在此步（依赖步骤 3 的 CSP 注入，见步骤 6）。

**涉及文件面**：`.github/workflows/ci.yml`（新增 job）、`scripts/check-dist.mjs`（新增，本步最小版）、`package.json`（如需挂 `check:dist` 根脚本转发，口径对齐 G7）。

**验证方式**：本地手动复跑 job 三条命令链（shared-types build → build:desktop → check-dist.mjs）；PR 提交后观察快层新 job 绿。

**完成判据**：PR 上 `frontend-build` job 绿色；`check-dist.mjs` 输出 chunk 清单；CI 首次出现"生产产物被机器验证"。

**输出（供下一步）**：chunk 清单基线（名称/大小）——步骤 2 拆分后的对照基准；shared-types 构建命令链——步骤 6 preview 冒烟复用。

---

### 步骤 2：App chunk 拆分（tiptap/xterm vendor 化）

**任务内容**（对应 P2-4）：

1. `apps/crish-desktop/vite.config.ts` 的 `manualChunks`（:218-243）增补两族：
   - `@tiptap/*` 与 `@tiptap/pm`（prosemirror）→ `vendor-tiptap`；
   - `@xterm/*` → `vendor-xterm`；
   - 实现方式沿用现有函数式 + `\\`→`/` 归一（:221-222，Windows-safe 既有模式）。
2. chunk size 警告升级为**构建失败门禁**：`rollupOptions.onwarn` 捕获 `CHUNK_SIZE_WARN` 抛错（或等价方式），删除"降噪"语义的 `chunkSizeWarningLimit: 1100`（:216），阈值重置为 `500`——拆分后 App chunk 预计 <500KB（tiptap 5.4MB + prosemirror 2.8MB 源 → minify 后 vendor-tiptap 约 400~600KB raw，xterm 7.9MB 源 → vendor-xterm 约 250~400KB raw；阈值以步骤 1 实测为准校准，**先拆分后定阈值**）。
3. `scripts/check-dist.mjs` 增补断言：`vendor-tiptap` / `vendor-xterm` 存在、App chunk < 阈值——升级为强制。

**与 07 性能方案的依赖关系（不重复设计）**：
- 本步骤只做**打包结构拆分**（静态 chunk 边界）；tiptap/xterm 的**运行时懒加载时机**（路由/面板级 React.lazy，如终端面板打开才加载 vendor-xterm）归属 07 性能方案；
- 两者正交可叠加：vendor 拆分保证"即使同步加载也不超限"，懒加载保证"首屏不加载"；
- 执行顺序约定：本步骤（06）先行落地 vendor 拆分 → 07 的懒加载在既有 30+ React.lazy 体系上追加，互不阻塞；
- 若 07 方案先行，本步骤阈值校准须以 07 落地后的实测为准（本步骤判据改为"App chunk < 500KB 且无 CHUNK_SIZE_WARN"而非固定数字）。

**涉及文件面**：`apps/crish-desktop/vite.config.ts`（manualChunks / onwarn / chunkSizeWarningLimit）、`scripts/check-dist.mjs`。

**验证方式**：本地 `npm run build:desktop` → 无 CHUNK_SIZE_WARN、dist 出现 vendor-tiptap/vendor-xterm、App chunk < 500KB；`check-dist.mjs` 全过；跑 `npm run test:coverage -- --project=unit`（懒加载面回归：拆分不改加载逻辑，仅结构变化，若有 import 图变化走 depcruise 门禁）。

**完成判据**：CI `frontend-build` job 绿（onwarn 门禁生效）；dist 实测 App chunk < 500KB；chunk 总数仍 ≤ 现状数量级（拆分不引入碎片化）。

**输出（供下一步）**：严格 CSP 注入所需的构建期钩子位置确认（transformIndexHtml 已由 vite build 流程承载，无额外依赖）。

---

### 步骤 3：CSP 分层（dev 宽松 / prod 严格，单一真源）

**任务内容**（对应 P1-2，设计全文见 §4）：

1. `apps/crish-desktop/vite.config.ts` 新增 `cspPlugin()`：
   - `transformIndexHtml` 按 `isProduction` 返回 CSP meta（**替换** index.html 中的静态 meta，而非追加第二个 policy）；
   - dev：与现状等价的宽松串（`unsafe-eval` + 宽 connect-src）——保证 HMR/React refresh/dev 行为零变化；
   - prod：严格串（§4 清单：`script-src 'self'`、`connect-src 'self' ipc: + daemon 地址`、无 `unsafe-eval`、无 `unsafe-inline` script；保留 `style-src 'unsafe-inline'` 因骨架屏内联 CSS，index.html:17-177）。
2. `apps/crish-desktop/index.html` 删除静态 CSP meta（:13）——CSP 唯一真源移交 vite 插件。
3. `apps/agent-workbench/src-tauri/tauri.conf.json` 的 `security.csp`（:29）**移除**（保留 `assetProtocol` 等其它安全字段），避免双 policy 交集语义的不确定性（§5 N1）；在 `docs/` 相应配置说明处登记"切换点"：若未来启用 isolation pattern，需回到 tauri.conf.json 配置 csp（方案 §4.3 说明）。
4. `scripts/check-dist.mjs` 的 CSP 断言切**强制**：dist/index.html 不含 `unsafe-eval`、不含泛化 `http: https: ws: wss:` connect-src、`script-src` 不含 `unsafe-inline`。
5. Rust 侧改动说明（依赖）：tauri.conf.json 是 `apps/agent-workbench/src-tauri/` 配置面，仅 JSON 字段删除，无 Rust 代码改动；打包产物（`tauri build`）由本地/发布流程验证一次（CSP 生效面：index.html 内 meta 随 frontendDist 打包进二进制，`tauri build` 后抽查产物 index.html）。

**涉及文件面**：`apps/crish-desktop/vite.config.ts`、`apps/crish-desktop/index.html`、`apps/agent-workbench/src-tauri/tauri.conf.json`、`scripts/check-dist.mjs`、`docs/`（配置说明登记）。

**验证方式**：
- dev：`npm run dev:desktop` 手动验证 HMR、骨架屏、编辑器（tiptap）正常——宽松串等价迁移，行为零变化；
- prod：`npm run build:desktop` → `check-dist.mjs` 强制断言过；
- 发布形态：本地 `tauri build`（或走发布流程）一次，抽查打包产物 index.html 仅有严格 CSP meta；
- 集成面：prod 严格串下 `connect-src` 收敛后，daemon 通信（`http://localhost:8765` / `ws://localhost:8765`，清单与 tauri.conf.json 现串一致）由步骤 6 preview 冒烟回归。

**完成判据**：dist/index.html 与打包产物均为**单一**严格 CSP policy；`check-dist.mjs` CSP 断言在 CI 强制通过；dev 行为与改前一致（无功能回归）。

**输出（供下一步）**：生产 preview 冒烟可依赖的"严格 CSP 下的真实产物"。

---

### 步骤 4：锁文件清理（根锁唯一真源）

**任务内容**（对应 P2-3）：

1. 删除 `apps/crish-desktop/package-lock.json`、`apps/crish-desktop/pnpm-lock.yaml`、`apps/crish-desktop/pnpm-workspace.yaml`（均 2026-08-01 实验残留；删除前 `git log` 确认三文件为 pnpm 实验引入、无历史依赖）；
2. 根 `package-lock.json` 保持唯一；确认根锁内 lucide-react 为 `^0.525.0` 系（与 app package.json:44 一致，无 `^1.20.0` 陈旧声明）；
3. `git rm` 三文件并提交（本步骤独立提交，与其它步骤无耦合，可并行执行——逻辑顺序上放此处仅为叙述连贯）。

**涉及文件面**：`apps/crish-desktop/` 三锁文件（删除）、根 `package-lock.json`（无改动）。

**验证方式**：`npm ci`（本地 + CI 快层任意 job）全绿；在 `apps/crish-desktop` 目录执行 `npm install --package-lock-only --dry-run` 不产生新锁文件（hoist 到根锁）；`git status` 干净。

**完成判据**：三文件删除且入库；全仓仅根 `package-lock.json` 一份锁；CI 无锁相关告警。

**输出（供下一步）**：干净的依赖面（步骤 5 lint 口径的 stylelint 锁定基于此依赖面）。

---

### 步骤 5：lint 口径统一进 CI（eslint 对齐 + stylelint 锁定 + prettier）

**任务内容**（对应 P2-5）：

1. `.github/workflows/ci.yml` lint job 的 `npx eslint .`（:58）改为 `npm run lint:all`（含 `--ext .ts,.tsx --max-warnings 0` + stylelint）；步骤 0 基线中的 eslint 存量 warning 清零（`--max-warnings 0` 门禁下逐项修复）；
2. stylelint 版本锁定：`npx --yes stylelint@16`（package.json:54）改为 root devDependencies 显式依赖 `stylelint`（锁定 16.x 具体版本）+ `npm run lint:all` 直接调用（§5 N5：当前每次 CI 拉最新 16.x，无锁定）；评估 `.stylelintrc.cjs` 单规则（`declaration-no-important` warning 级）是否升级为 error 级（与存量 673 处 `!important` 的 01 样式审计联动，本步只做版本锁定与入口统一，规则升级留给 01 维度批次）；
3. prettier 进 CI：新增快层 `format` job（或并入 lint job）执行 `npm run format`（prettier --check .）；前置一次性 `npm run format:write` 基线提交（§5 N6：lint-staged 已有 `prettier --write`，历史文件可能未全量格式化）；
4. `scripts/check-dist.mjs` / lint 相关死脚本清理见步骤 7。

**涉及文件面**：`.github/workflows/ci.yml`（lint job 修改 + format job 新增）、`package.json`（devDependencies 增 stylelint、lint:all 脚本微调）、`apps/crish-desktop/**/*.css`（如 rule 升级引发的存量修复）。

**验证方式**：本地 `npm run lint:all` 与 `npm run format` 全绿后提交；CI lint job / format job 绿；`lint:all` 的本地口径 = CI 口径（消除漂移）。

**完成判据**：CI lint = 本地 `lint:all`（含 `--max-warnings 0`）；stylelint 版本锁定且配置生效；prettier `--check` 全仓绿。

**输出（供下一步）**：统一的 lint 门禁基线——步骤 6 preview 冒烟新增文件天然满足门禁。

---

### 步骤 6：生产 preview 冒烟（生产形态 e2e）

**任务内容**（对应 P1-1 后半，闭环"生产产物被自动化执行"）：

1. Playwright 配置层：`playwright.config.ts` 新增 `e2e-prod` project（或独立 `playwright.prod.config.ts`）：
   - webServer：`vite preview` 服务 `apps/crish-desktop/dist`（端口 4173，`baseURL` 对应）——`vite preview` 默认端口 4173，与 dev 的 5174 互不冲突；
   - 复用既有 `tests/e2e/mock-engine.ts`（:390 已注入 `window.__TAURI_INTERNALS__` mock）——生产形态无需真壳（§5 N8）；
   - 用例子集：主流程冒烟（应用加载 / 骨架屏替换 / 懒加载 chunk 可加载 / 编辑器面板 / daemon mock 通信），**不**切换现有 dev 面 26 用例（回归保护名单，dev project 保留）。
2. 挂载位置：中层 `ci-mid.yml` e2e job 追加 preview 冒烟步骤（或独立 job，视预算）。
3. 断言重点（生产专属面，dev 跑不到）：
   - 严格 CSP 生效（页面无 CSP violation console error）；
   - `import.meta.env.PROD` 分支行为（MCP 门控不挂 guest、DevHealthOverlay 不加载——与 dev 差异是**有意验证点**）；
   - minify/define 替换（`process.platform` 编译期注入值）与懒加载 chunk 真实路径。

**涉及文件面**：`playwright.config.ts`（或新建 playwright.prod.config.ts）、`.github/workflows/ci-mid.yml`、`tests/e2e/`（如新增 prod 冒烟 spec，独立文件不触碰 5 个保护 spec）。

**验证方式**：本地 `npm run build:desktop && npx playwright test --config playwright.prod.config.ts` 绿；CI 中层 job 绿。

**完成判据**：生产形态（minify + 严格 CSP + 真实 chunk）首次被 CI 自动化执行且绿；dev 面 e2e 全量不受影响（5 个 markdown-editor 专项 spec 保持绿）。

**输出（供下一步）**：生产形态回归基线——后续所有构建面改动（步骤 7 收尾）以本步为回归锚点。

---

### 步骤 7：收尾清理（死脚本 / dev 体验 / 严格项回收，可选单项独立提交）

**任务内容**：

1. **死脚本处理**（P2-7）：`scripts/check-tsc-threshold.mjs` / `scripts/check-coverage-threshold.mjs` 删除或接线——语义已被快层 typecheck（7 段 tsc 直跑）与 vitest coverage 阈值（45/70/65/45）覆盖（审计 §2.3/§3.4 证据），确认无引用后删除并提交；
2. **dev 体验**（P3-9）：`dev: "vite --force"`（app package.json:9）移除 `--force`，依赖 optimizeDeps 自动失效（配合 vite.config.ts:204 的 exclude MCP SDK，冷启动不再强制 re-opt）；
3. **tsconfig 严格项回收**（P2-8，**低优先、非本维度强制**）：`exactOptionalPropertyTypes` 争取回收 true（tsconfig.app.json:19），`noUnusedLocals` 回 true——涉及存量代码修复面，仅登记不实施，归 05 代码质量维度批次；
4. **依赖过时迁移窗口登记**（P2-6）：vite 7→8、vitest 3→4、lucide 0.525→1.30（跨代 API 重命名，需独立迁移窗口）、zod 3 停更等 12 项 major 落后，登记为独立迁移任务，不随本方案实施（避免与步骤 1~6 的构建面改动耦合）。

**涉及文件面**：`scripts/`（删除两脚本）、`apps/crish-desktop/package.json`（dev 脚本）、`docs/`（迁移窗口登记）。

**验证方式**：删除后全仓 grep 无引用；`dev` 冷启动一次正常；快层全绿。

**完成判据**：死脚本清零；dev 冷启动不再强制 re-opt；迁移窗口登记在案。

---

## ③ CI 接入设计

```
快层 ci.yml（提交/PR，预算 ≤15min）               中层 ci-mid.yml（PR + main）
┌─────────────────────────────────────┐          ┌──────────────────────────────┐
│ typecheck（现有）                    │          │ e2e（现有 5 冒烟 + dev server）│
│ lint → 步骤5 改 npm run lint:all     │          │  + 步骤6 e2e-prod preview 冒烟│
│ format（步骤5 新增）                 │          └──────────────────────────────┘
│ vitest-fast（现有）                  │
│ audit（现有）                        │
│ ★ frontend-build（步骤1 新增）        │
│    npm --workspace @crish/shared-types run build   ← 步骤1 关键依赖（§5 N2）
│    npm run build:desktop             │
│    node scripts/check-dist.mjs       │
│      · CSP 断言（步骤3 起强制）        │
│      · chunk 清单/阈值（步骤2 起强制）  │
│      · onwarn 门禁（步骤2 内置）       │
│ engine-bindings-drift（现有）         │
│ cargo-deny/secret-scan/rust-*（现有） │
└─────────────────────────────────────┘
```

设计决策：

1. **build job 放快层而非中层**：构建回归需要即时反馈（快层 10 job 并行、npm ci 有缓存，独立 job 增量成本 ≈ 1-2min）；中层聚焦测试全量面。
2. **门禁承载方式**：`check-dist.mjs` 单一断言脚本集中产出断言（CSP / chunk / 警告），避免分散在 workflow inline 命令中不可复用；onwarn 抛错在 vite 配置层（构建本身失败，日志直达）。
3. **口径一致性**：job 命令链全部走根脚本或 `npm --workspace` 转发（G7 口径，与现有 job 注释风格一致）；`build:desktop` 与本地 `npm run build` 同口径（含 tsc -b），不引入第二个构建路径。
4. **e2e 生产冒烟挂中层**：preview 冒烟依赖 build 产物 + mock 引擎，属验证面扩展，放中层 e2e job 内追加步骤，不增加快层预算。
5. **回归锚点**：步骤 6 完成后，所有构建面后续改动（依赖升级窗口 P2-6）以 `frontend-build` + `e2e-prod` 为回归门禁。

---

## ④ CSP 分层设计

### 4.1 现状事实（源码实证）

- `apps/crish-desktop/index.html:13` 静态宽 CSP meta（`script-src 'self' 'unsafe-inline' 'unsafe-eval'` + `connect-src 'self' ipc: http: https: ws: wss:`）——dev/prod 共享，构建后原样进入 dist；
- `apps/agent-workbench/src-tauri/tauri.conf.json:29` 严格 `security.csp`（无 unsafe-eval，connect-src 收敛）——打包时由 Tauri 注入；
- **关键机制（新发现 N1）**：Tauri 注入是**追加**第二个 CSP meta，而非替换（`tauri-utils-2.9.3/src/html2.rs:84-90` 源码实证：`inject_csp` 仅 `head.append_child(meta_tag)`，不查删已有 meta）。CSP3 多 policy 语义 = **交集**（每个 policy 独立执行，资源必须通过所有 policy）。

### 4.2 交集语义推论（当前真实安全面）

| 指令 | meta（宽） | tauri 注入（严） | 交集实效 |
|---|---|---|---|
| script-src | self + inline + eval | self + wasm-unsafe-eval | **self**（inline/eval 实际被禁） |
| connect-src | self + 全 http/https/ws/wss | self + ipc: + 8765 清单 | **收敛到 8765 清单**（比 meta 窄） |
| style-src | self + unsafe-inline | self + unsafe-inline | 一致，inline CSS 放行（骨架屏依赖） |
| worker-src | 无 → default-src self | self + blob: | **self**（blob worker 被禁；当前 worker 均为静态 URL，worker-pool.ts:404 `new URL(..., import.meta.url)`，无影响） |

推论：**当前生产包实际执行的 CSP 是"严格"的**——审计 P1-2 的"unsafe-eval 在包内生效"判断在 Tauri 壳内不成立（严格 policy 拦截）。但这是一个**隐式、脆弱、无人知、不可测**的防线：
- 任一宽松侧改动（tauri.conf.json 删除 csp、dangerous_disable_asset_csp_modification、Tauri 版本行为变化）即静默退化为宽 CSP；
- dev 壳（webview 加载 5174，无 Tauri 注入或注入语义不确定）与 prod 壳行为不一致；
- 未来引入 blob worker / 内联 script 会在 prod 静默失效（交集拦截）而 dev 正常——典型生产专属回归；
- 双 CSP meta 在 Chromium 控制台产生 violation/重复告警噪音。

### 4.3 目标态：单一真源 + 分 mode 注入

```
┌─ vite.config.ts cspPlugin()（新增）────────────────────────────┐
│ transformIndexHtml: 替换 index.html 中的 CSP meta（单 policy）   │
│                                                                │
│  dev（vite serve）   → 宽松串（与现状等价，行为零变化）            │
│  prod（vite build）  → 严格串（下表）                            │
└────────────────────────────────────────────────────────────────┘
        │ dist/index.html = 唯一 CSP 源（tauri.conf.json csp 移除）
        ▼
Tauri 打包（frontendDist 随资源入库）→ 产物仅一份严格 CSP policy
```

**prod 严格串（目标）**：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ipc: http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'
```

设计要点：

1. **script-src 'self'**：无 `unsafe-eval`、无 `unsafe-inline`——产物全外链 script（index.html 无内联 script，已实证），懒加载 chunk 走 modulepreload/动态 import（'self' 同源）；tiptap/xterm 均不依赖 wasm（xterm 的 webgl 是 WebGL API 非 wasm），故不保留 `wasm-unsafe-eval`（未来引入 wasm 依赖时再追加，注释登记）；
2. **style-src 'unsafe-inline' 保留**：骨架屏内联 CSS（index.html:17-177）依赖，无 hash/nonce 机制（外链样式也可用 'self'）；
3. **connect-src 收敛清单**：与 tauri.conf.json 现串一致（ipc: + localhost/127.0.0.1:8765 的 http/ws）——前端不直连任何供应商 API（daemon 代理出站），泛化 `http: https: ws: wss:` 无存在理由；
4. **worker-src 'self' blob:**：当前 worker 均为静态 URL（'self' 已够），保留 blob: 为未来 blob worker 留口（交集语义下曾被禁——本方案消除该隐性限制，恢复与 dev 一致行为）；
5. **tauri.conf.json csp 移除**：单 policy 无交集，语义清晰可测；切换点登记：若启用 isolation pattern 或需要 Tauri nonce 注入，改回 tauri.conf.json 配置（届时 index.html 移除 meta，反方向迁移，同样单源）。

### 4.4 验证矩阵

| 面 | 验证方式 | 判据 |
|---|---|---|
| dev | 本地 `npm run dev:desktop` 手动回归 HMR/骨架屏/tiptap | 行为与改前一致 |
| prod 产物 | `npm run build:desktop` + `check-dist.mjs` | dist/index.html 单 policy、无 unsafe-eval、无泛化 connect |
| 发布包 | 本地 `tauri build` 抽查产物 index.html | 仅一份严格 policy |
| 运行面 | 步骤 6 preview 冒烟（严格 CSP 下跑主流程 + mock 引擎） | 无 CSP violation console error |

---

## ⑤ 新发现补充（本方案读码补充，审计未覆盖或需修正）

| # | 内容 | 证据 | 影响 |
|---|---|---|---|
| N1 | **CSP 双源并存走交集语义**（修正审计 P1-2 严重性判断）：Tauri 注入第二个 CSP meta 而非替换（`tauri-utils-2.9.3/src/html2.rs:84-90` append）；CSP3 多 policy = 交集 → 当前生产包实际执行严格面，unsafe-eval 在 Tauri 壳内已被拦截。但防线隐式脆弱（§4.2 推论链），且 worker-src 交集后 blob: 被禁、双 meta 噪音——这正是"生产形态未被自动化执行"掩盖的隐性行为 | 源码实证 + CSP3 规范 | 方案 §4（步骤 3）整体设计依据 |
| N2 | **CI build 必须先构建 shared-types**：vite production mode 解析 `@crish/shared-types` 的 `exports.default → dist/index.js`（shared-types/package.json:9-19）；CI 无 dist 缓存，不先 build 则 vite build 失败或静默解析错误。本地一直能 build 是因为 dist 曾在本地存在——审计 P1-1 建议未显式此依赖 | exports 配置 + vite resolve.conditions 语义 | 步骤 1 job 命令链的关键前置 |
| N3 | **`process.platform` 注入随运行平台漂移**（vite.config.ts:194 `process.platform \|\| 'win32'`）：CI（ubuntu）注入 'linux'、本地（Windows）注入 'win32' → CI 验证的是 linux 平台分支，发布产物走 win32 分支。建议显式化（常量或目标平台参数），归入步骤 7 收尾或依赖升级窗口 | vite.config.ts:194 | 构建验证面失真，低优先 |
| N4 | **`chunkSizeWarningLimit: 1100` 是"降噪开关"而非门禁**：当前每次 build 都超限但只告警不失败，阈值已无意义（审计 §4.1 已点，方案将其转正为 onwarn 抛错门禁） | vite.config.ts:216 | 步骤 2 设计依据 |
| N5 | **stylelint 未锁定版本且配置仅 1 条 warning 规则**：`npx --yes stylelint@16`（package.json:54）每次拉最新 16.x；`.stylelintrc.cjs` 仅 `declaration-no-important: warning`——无 error 级规则，CSS 面实际无硬门禁 | package.json:54、.stylelintrc.cjs | 步骤 5 版本锁定 + 入口统一（规则升级归 01 维度） |
| N6 | **prettier --check 进 CI 有存量前置**：lint-staged 已配 `prettier --write`（package.json:90-95），历史文件可能未全量格式化 → 需要一次性 `format:write` 基线提交后再接 `--check`，否则 CI 首红 | package.json lint-staged 段 | 步骤 5 前置工作 |
| N7 | **worker 均为静态 URL，非 blob**（worker-pool.ts:404）——交集语义下 worker-src 'self' 可用，无生产专属 worker 风险；但 blob URL 使用处（agentCardUtils.ts:128、sidebarHelpers.ts:158、SettingsProfileTab.tsx:59、TelemetryService.ts:124）为下载/导出用途，与 CSP worker-src 无关 | 源码实证 | 消除一个潜在疑虑，方案 §4.3 worker-src 保留 blob: |
| N8 | **生产 preview 冒烟可复用既有 mock 引擎**：`tests/e2e/mock-engine.ts:390` 已注入 `window.__TAURI_INTERNALS__` mock——生产形态 e2e 无需 tauri-driver 真壳，L2 mock 即可覆盖 minify/define/CSP/懒加载面，成本低 | mock-engine.ts:390-408 | 步骤 6 可行性依据 |

---

## ⑥ 风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 步骤 3 移除 tauri.conf.json csp 后，若未来启用 isolation pattern 或引入 wasm 依赖，需回填配置（交接面丢失） | 中 | §4.3 切换点登记入 docs；check-dist.mjs CSP 断言持续守护 prod 串 |
| R2 | 严格 CSP 在**某个未发现的运行路径**上拦截合法资源（如远程字体、iframe、blob worker 未来接入）→ 生产专属静默失效 | 中 | 步骤 6 preview 冒烟在严格 CSP 下跑主流程 + 控制台 violation 断言；connect-src 清单与 tauri.conf.json 现串一致（非新引入收窄） |
| R3 | 步骤 2 阈值校准依赖实测：拆分后 vendor-tiptap raw 体积若 >500KB，onwarn 门禁误伤 | 低 | 判据"先拆分后定阈值"；check-dist.mjs 阈值参数化，校准以步骤 1 清单为据 |
| R4 | 步骤 5 prettier `--check` 全仓基线涉及大量历史文件格式化 diff（格式噪音混入功能提交） | 中 | `format:write` 作为**独立基线提交**先行落地；后续门禁只管新变更（lint-staged 已兜底） |
| R5 | 步骤 6 preview 冒烟与 dev 面 e2e 并存：Playwright webServer 多端口编排复杂度上升 | 低 | 独立 config / project + 独立端口（4173）；现有 5 个保护 spec 不触碰 |
| R6 | 步骤 1 build job 拉长快层预算（shared-types build + tsc -b + vite build 全链） | 低 | 独立 job 并行 + npm ci 缓存；与 typecheck job 职责有重叠（tsc -b）但口径统一优先 |
| R7 | 步骤 7 依赖过时窗口（P2-6）与步骤 2 chunk 拆分的 manualChunks 结构耦合：vite 7→8 升级可能改变 manualChunks/onwarn API 形态 | 中 | 迁移窗口在步骤 2 完成后独立开启；frontend-build + e2e-prod 为回归锚点，升级失败即时暴露 |

---

## 附：步骤依赖图

```
步骤0 基线 ──→ 步骤1 build 进 CI ──→ 步骤2 chunk 拆分 ──→ 步骤3 CSP 分层
   │（数据）          │（产物/断言）      │（onwarn 门禁）     │（严格 CSP 产物）
   │                   └────────┬────────┘                    │
   │                            ▼                             ▼
   │                       步骤6 preview 冒烟（生产形态闭环）◄──┘
   │
   ├──→ 步骤4 锁文件清理（独立，可并行）
   └──→ 步骤5 lint 口径（独立，可并行）──→ 步骤7 收尾（依赖步骤1~6 全绿）
```

逻辑顺序约束：步骤 1 → 2 → 3 → 6 为依赖链（前步产物/断言是后步输入）；步骤 4、5 与主链无耦合，可与步骤 1~3 任意交错；步骤 7 在步骤 1~6 全绿后收口。

import type { KnipConfig } from 'knip';

/**
 * knip 死代码门禁配置（R2-T2）。
 *
 * - workspaces 自动取自根 package.json 的 workspaces 字段（当前 8 项），
 *   此处只按目录为两个应用配置 entry，不枚举 workspace 列表。
 * - entry 覆盖 apps/crish-desktop 与 apps/agent-workbench 的构建/测试入口；
 *   vite/vitest/playwright 配置文件与 src/main.tsx 由 knip 插件自动识别，
 *   根 workspace 的脚本（bench/stress/startup/check/test 等）由 knip 从
 *   package.json scripts 自动解析为入口。
 * - ignore 只保留 .gitignore 未覆盖的分析区：
 *   docs/（含归档区 docs/archive 的历史原型源码）、reference/（git 保留跟踪的
 *   vendored 参考项目）；analysis/、assets/（iconLib 等 vendored 资产）、
 *   dist、target、node_modules、.agent-runtime/、implementer/、
 *   test-results/、perf-report/、scripts/*.mjs 等已由 .gitignore 覆盖
 *   （knip 默认尊重 .gitignore），无需重复登记。
 * - ignoreFiles：被非 import 方式消费的文件（门禁脚本按路径字符串读取，knip
 *   无法跟踪）与跨轮次预留资产——"看似未用"是 knip 盲区，不属于死代码。
 * - rules：unused files / unused dependencies / unused devDependencies 为 error
 *   （门禁）；unused exports / unused exported types / unlisted / binaries /
 *   duplicates 为 warn（记录不阻塞；unlisted/binaries 属 package.json 声明域 =
 *   T1 冻结域，待 T1 落盘；exports/types/duplicates 待 T8 清理后收紧）。
 */
const config: KnipConfig = {
  // 根 workspace 入口补充（T-DEBT-02）：两个 vitest setup 文件被
  // vitest.config.ts 的 projects[].test.setupFiles 真实加载，显式登记为
  // 根 workspace entry（knip 的 vitest 插件不解析嵌套 projects 结构，
  // 见下方 ignoreUnresolved 登记）。tests/perf/*.ts 为手动 perf 基线
  // 采集工具（npx tsx 直接运行，非 import 消费）。注意：声明了
  // workspaces 时顶层 entry 不生效，必须放在 workspaces['.'] 下。
  workspaces: {
    '.': {
      entry: [
        'vitest.setup.ts',
        'apps/crish-desktop/src/test-setup.ts',
        'tests/perf/*.ts',
      ],
    },
    // --- apps/crish-desktop ---
    'apps/crish-desktop': {
      entry: [
        // 构建入口锚点（index.html → main.tsx 链路由 vite 插件解析）
        'index.html',
        // 手动 perf 工具（npx tsx apps/crish-desktop/perf/run-frontend-bench.ts，
        // docs/chat-composer-plugin/survey/07 引用为真实压测工具，非 import 消费）
        'perf/*.ts',
        // 测试入口（对齐 vitest.config.ts 项目 include 面）
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**/*.{ts,tsx}',
        'tests/**/*.{test,spec}.{ts,tsx}',
      ],
    },
    // --- apps/agent-workbench（TS 侧为共享库 + 测试，无 html/main）---
    'apps/agent-workbench': {
      entry: ['src/**/*.test.ts'],
    },
    // --- scripts/mock-daemon（T-DEBT-02）：多端互通 R0-06 产物，WS 夹具
    // 服务器 + 夹具事件集（纯测试基建，不进生产代码）。自带 package.json
    // （ws 已声明在其 dependencies，scripts 即入口）；登记为 workspace 后
    // knip 按其自身声明分析，不再向根 workspace 误报 ws unlisted。
    'scripts/mock-daemon': {},
  },
  ignore: [
    // 文档与归档区（docs/archive 含历史原型源码）
    'docs/**',
    // vendored 参考项目（reference/ui-replica、reference/newui 等被 .gitignore 保留跟踪）
    'reference/**',
    // vendored 资产（assets/iconLib 第三方图标库源仓）：根 .gitignore 第 9 行
    // 全局忽略 assets/，但内含取反规则（!apps/...），knip 的 gitignore 解析
    // 在取反混入后未完全收敛，仍报出 lobe-icons 的仓配置文件。按 vendored
    // 资产口径整体登记（与 .gitignore 既有裁决一致，非新增豁免面）。
    'assets/**',
    // sites/（未跟踪的新站点项目，git status 显示 ?? sites/）：进行中的 WIP，
    // 非本轮死代码清理对象；0 引用（rg 证实），不参与归零断言。
    'sites/**',
    // apps/avatar-studio 孤岛应用（T-BLK-03-a / T-DEBT-03-a，deferred）：
    // 用户裁决 §3.4-1 暂缓处理，按单包粒度登记并引用 GAP-05 裁决；
    // 解除条件：GAP-05 定位裁决生效后恢复 127 全量口径。禁止以此为由
    // 通配排除其它应用目录。
    'apps/avatar-studio/**',
    // shared-types/subagent.ts（DEBT-01 批次）：Rust 侧子代理契约的 TS
    // 镜像（REQ-D08 / T-D-01/02/06/07/08 落地资产，「两侧同值」契约文档，
    // Rust 侧 DEFAULT_RECURSION_GUARD 为唯一权威）。hooks.ts 真实消费
    // SubagentRole / SubagentCapabilityMode；其余 8 个符号为 Rust 权威
    // 默认值的文档镜像，登记保留不视为死代码（ignoreFiles 不抑制
    // exports 类目，故挂 ignore，粒度=单文件并引用任务链）。
    'packages/shared-types/src/subagent.ts',
  ],
  ignoreFiles: [
    // 被 lint:all / lint:css 脚本经 stylelint 自动发现使用（stylelint 未本地安装，
    // knip 插件未激活而误报为 unused file）
    '.stylelintrc.cjs',
    // apps/crish-desktop/public/loader.js：vite.config.ts:136 经
    // joinPath(publicDir, 'loader.js') 字符串路径读取并在构建时内联进
    // index.html（CSP 处理），非 import 消费，knip 无法跟踪。
    'apps/crish-desktop/public/loader.js',
    // apps/crish-desktop/src/components/chat-card/unitChromeTools.ts：被
    // src/extensions/note-paper/unitChrome-open-note.source.test.ts:18 经
    // join(DIR, ...) 路径读取原文（source-reading 契约测试），非 import 消费。
    'apps/crish-desktop/src/components/chat-card/unitChromeTools.ts',
    // scripts/ 下 7 个 check-*.mjs：check-guard-system.mjs 的
    // UNWIRED_ALLOWLIST 按文件名登记管理（有意未接入自动触发点的守卫，
    // 逐条带理由），非 import 消费；删除会破坏守卫台账。
    // （check-coverage-threshold.mjs 实测被 knip 判定可达，无需登记。）
    'scripts/check-chat-state.mjs',
    'scripts/check-layoutstore-actions.mjs',
    'scripts/check-legacy-shim.mjs',
    'scripts/check-lr-t1-memory-prod-ban.mjs',
    'scripts/check-sec7-gfm-emoji.mjs',
    'scripts/check-tsc-threshold.mjs',
    'scripts/check-ui-negative-churn.mjs',
    // scripts/verify-desktop-i18n-mcp.mjs：其自测套件
    // scripts/verify-desktop-i18n-mcp.test.mjs 经 SCRIPT_PATH（execSync
    // node --self-test）调用，非 import 消费。
    'scripts/verify-desktop-i18n-mcp.mjs',
    // 跨轮次预留资产：shared-types 类型已确认有真实 import 消费，
    // 仅保留仍未被引用的 thinking-intensity.ts
    'packages/shared-types/src/thinking-intensity.ts',
  ],
  ignoreBinaries: [
    // PS-02 T2.6：warn 级处置（不阻塞门禁，登记理由防回归）
    // rimraf：packages/test-utils/package.json "clean": "rimraf dist" 消费，
    // 经 npm 脚本调用（根 node_modules 提升解析，未声明 devDep）
    'rimraf',
    // tasklist：tests/e2e/tauri-native-smoke.spec.ts 经 execSync 调用的
    // win32 系统二进制（进程存活探测），非 npm 依赖
    'tasklist',
  ],
  ignoreDependencies: [
    // 被 .husky/pre-commit（npx lint-staged）与 .lintstagedrc.json 使用
    'lint-staged',
  ],
  ignoreUnresolved: [
    // knip 的 vitest 插件只解析顶层 test.setupFiles，不解析
    // vitest.config.ts 中 projects[].test.setupFiles 嵌套结构（顶层
    // globalSetup 可正常解析）；两个 setup 文件被三个 vitest project
    // 真实加载（vitest.config.ts:70-73/97/124），并已登记为根 workspace
    // entry。定点豁免这两个 specifier，非 blanket 放行。
    './vitest.setup.ts',
    './apps/crish-desktop/src/test-setup.ts',
    // tests/e2e/webview 旧 WebView CDP 测试资产（T-DEBT-19）使用 `/src/...`
    // 绝对别名指向 apps/crish-desktop/src；7 个目标文件均真实存在
    // （openTool.ts / note-doc-written.ts / send-to-note.ts / noteApi.ts /
    // noteHydrateIpc.ts / productLeafBindings.ts / productStrictDoc.ts）。
    // 资产文件按 AGENTS.md §9/§15.2 测试基建例外保留不删除；knip 对以
    // `/` 开头的 specifier 走绝对路径解析、不套用 paths 别名，故定点
    // 豁免，解除条件 = T-DEBT-19 归档说明落地后随该行收口。
    '/src/store/workspace-shell/openTool.ts',
    '/src/bridges/note-doc-written.ts',
    '/src/bridges/send-to-note.ts',
    '/src/api/noteApi.ts',
    '/src/api/noteHydrateIpc.ts',
    '/src/extensions/note-paper/productLeafBindings.ts',
    '/src/extensions/note-paper/productStrictDoc.ts',
  ],
  rules: {
    files: 'error',
    dependencies: 'error',
    devDependencies: 'error',
    exports: 'warn',
    types: 'warn',
    unlisted: 'warn',
    binaries: 'warn',
    duplicates: 'warn',
    unresolved: 'error',
  },
};

export default config;

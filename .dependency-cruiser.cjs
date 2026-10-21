/**
 * dependency-cruiser configuration for Crish monorepo.
 *
 * Phase D（22-phase-d-cleanup-plan.md）：TS 旧 agent 包（agent-runtime/core/model/
 * context/mcp/subagent/permissions/tools/orchestrator/daemon + decision-engine）已
 * 删除，剩余层仅 shared-types/shared-utils（Layer 0）、logger/telemetry（Layer 1）、
 * crish-desktop（Layer 2）。
 *
 * Rule groups:
 *  1. Existing rules (preserved): no-circular, no-utils-reverse-dependency
 *  2. Layer rules: no-layer-N-reverse for N=0..1
 *  3. Layer rules 禁止上层依赖（原禁令 11/13 语义）
 *  4. Micro rules (R3 T14): store / api / components 微观依赖约束
 *
 * Layer mapping（Phase D 后精简）:
 *   Layer 0: shared-types, shared-utils
 *   Layer 1: logger, telemetry
 *   Layer 2: crish-desktop (apps/)
 *   Rust crates are not checked by depcruise (documented only).
 *
 * ─── Micro rules (R3 T14) ──────────────────────────────────────────────────
 * 三类微观约束（apps/crish-desktop/src 内）：
 *   A. store 不得 import components
 *   B. api 不得 import store 内部实现（仅允许经公共面：
 *      store/storeAccess.ts —— T11 新建；或 store/index.ts 公共 barrel）
 *   C. components 只经 storeAccess 读 store（仅允许 store/storeAccess.ts）
 * 每族 2 条明细：静态 import 规则 + dynamic-import（懒加载）规则。
 * 通用豁免（from 侧一致，逐条写在规则注释与 pathNot 中）：
 *   - 测试文件（*.test.* / *.spec.*）：豁免，测试可自由引用 store 内部
 *   - generated/engine/** 生成产物：豁免
 *   - api/storeAccess.ts 与 api/store-access/**：facade 桥实现，豁免 B 族
 *     （它们就是 storeAccess 的实现体，必然触碰 store 内部）
 * 注：tsPreCompilationDeps:false 时 `import type` 依赖不进入图谱，故不设
 *     type-only 规则（写了也是死规则）；类型层面约束由合并点按 storeAccess
 *     公共导出执行。
 * 注：storeAccess 由 T11（R3-A3）新建于 store/ 目录；T14 只读引用其路径写规则。
 */

/** @type {import('dependency-cruiser').IConfiguration} */

// ─── Layer mapping ─────────────────────────────────────────────────────────
// Each layer maps to a regex alternation of package paths. Rules reference
// these to forbid reverse (lower→higher) dependencies.
const LAYERS = {
  0: 'packages/(shared-types|shared-utils)',
  1: 'packages/(logger|telemetry)',
  2: 'apps/crish-desktop',
};

/**
 * Build a regex alternation matching all packages at or above the given layer.
 * Used as the `to.path` for reverse-dependency rules: a layer-N package cannot
 * import from any layer > N.
 */
function upperLayersFrom(layer) {
  const upper = [];
  for (let i = layer + 1; i <= 2; i++) {
    upper.push(LAYERS[i]);
  }
  return upper.length > 0 ? '^' + upper.join('|') : '$^';
}

module.exports = {
  forbidden: [
    // ─── Existing rules (preserved) ──────────────────────────────────────
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        '循环依赖守门 = depcruise no-circular 规则（单一守门面，不引入 madge）。' +
        'Disallow circular dependencies across the entire codebase. Type-only imports (import type) are erased at compile time and do not create runtime cycles, so they are excluded from this rule.',
      from: {},
      to: {
        circular: true,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-utils-reverse-dependency',
      severity: 'error',
      comment: 'Shared utils must not import upper business packages',
      from: {
        path: '^packages/shared-utils',
      },
      to: {
        path: '^packages/(logger|telemetry)',
      },
    },

    // ─── Layer-based reverse dependency rules ────────────────────────────
    // Each layer-N package cannot import from any layer > N.

    // Layer 0: shared-types / shared-utils (no upper imports)
    {
      name: 'no-layer-0-reverse',
      severity: 'error',
      comment:
        'Layer 0 packages (shared-types/shared-utils) must not depend on any upper layer',
      from: {
        path: '^' + LAYERS[0],
      },
      to: {
        path: upperLayersFrom(0),
      },
    },
    // Layer 1: logger / telemetry (only Layer 0)
    {
      name: 'no-layer-1-reverse',
      severity: 'error',
      comment:
        'Layer 1 packages (logger/telemetry) must only depend on Layer 0',
      from: {
        path: '^' + LAYERS[1],
      },
      to: {
        path: upperLayersFrom(1),
      },
    },

    // ─── Micro rules (R3 T14) ────────────────────────────────────────────
    // 三类微观约束。路径锚定 apps/crish-desktop/src，仅作用于前端主程序。
    // 每族两条明细：静态 import（dependencyTypesNot: ['dynamic-import']）
    // 与 dynamic-import（懒加载）规则，共同覆盖全部依赖边。
    // 豁免（from 侧统一，见各规则 pathNot）：测试文件（*.test.* / *.spec.*）、
    // generated/engine/**。B 族额外豁免 api/storeAccess.ts 与 api/store-access/**
    // （facade 实现体）。注：tsPreCompilationDeps:false 下 type-only 不进入图谱。

    // ── A 族：store → components 禁止 ────────────────────────────────────
    {
      name: 'no-store-import-components',
      severity: 'error',
      comment:
        'store 域（store/**）不得静态 import components/**（业务组件层）。' +
        'store 应保持纯状态层，UI 依赖必须反向（components → storeAccess）。' +
        '豁免：测试文件与 generated/engine/**（from 侧 pathNot）。',
      from: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/components/',
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    {
      name: 'no-store-import-components-dynamic',
      severity: 'error',
      comment:
        'store 域（store/**）也不得 dynamic-import（懒加载）components/**：' +
        '懒加载同样制造 store → UI 反向依赖，语义同主规则（明细规则）。',
      from: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/components/',
        dependencyTypes: ['dynamic-import'],
      },
    },

    // ── B 族：api → store 仅允许经公共面（storeAccess / index） ─────────
    // storeAccess = store/storeAccess.ts（T11 新建）；公共 index = store/index.ts。
    {
      name: 'no-api-store-internal',
      severity: 'error',
      comment:
        'api 域（api/**）不得静态 import store 内部实现，仅允许经公共面' +
        ' store/storeAccess.ts（T11 产出）或 store/index.ts（barrel）。' +
        '例外：api/storeAccess.ts 与 api/store-access/** 是 facade 实现体，豁免。',
      from: {
        path: '^apps/crish-desktop/src/api/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
          'api/storeAccess\\.ts$',
          'api/store-access/',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          '(storeAccess|index|sessionRuntimeStatusStore)\\.(ts|tsx)$',
        ],
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    {
      name: 'no-api-store-internal-dynamic',
      severity: 'error',
      comment:
        'api 域（api/**）dynamic-import（懒加载）store 内部同样禁止，仅允许' +
        '经公共面；懒加载 store 模块还会破坏 store 单例时序（明细规则）。',
      from: {
        path: '^apps/crish-desktop/src/api/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
          'api/storeAccess\\.ts$',
          'api/store-access/',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          '(storeAccess|index|sessionRuntimeStatusStore)\\.(ts|tsx)$',
        ],
        dependencyTypes: ['dynamic-import'],
      },
    },

    // ── C 族：components → store 仅允许经 storeAccess ───────────────────
    // components 比 api 更严：只允许 store/storeAccess.ts，不允许公共 index。
    {
      name: 'no-components-store-internal',
      severity: 'error',
      comment:
        'components 域（components/**）不得静态 import store 内部实现，' +
        '只允许经 store/storeAccess.ts（T11 产出）读 store；不得直连' +
        ' layoutStore/sessionStore/types 等内部文件，也不得经公共 index 绕行。',
      from: {
        path: '^apps/crish-desktop/src/components/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          'storeAccess\\.(ts|tsx)$',
        ],
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    {
      name: 'no-components-store-internal-dynamic',
      severity: 'error',
      comment:
        'components 域（components/**）dynamic-import（懒加载）store 内部' +
        '同样只允许经 store/storeAccess.ts（明细规则，与静态规则同约束）。',
      from: {
        path: '^apps/crish-desktop/src/components/',
        pathNot: [
          '\\.(test|spec)\\.(ts|tsx)$',
          'generated/engine',
        ],
      },
      to: {
        path: '^apps/crish-desktop/src/store/',
        pathNot: [
          'storeAccess\\.(ts|tsx)$',
        ],
        dependencyTypes: ['dynamic-import'],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules|dist|build|target',
    },
    exclude: {
      path: 'node_modules|dist|build|target',
    },
    tsPreCompilationDeps: false,
    tsConfig: {
      fileName: './tsconfig.base.json',
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
    },
  },
};

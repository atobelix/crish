import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactPlugin from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

const FRONTEND_SWALLOW_BASELINE = join(
  REPO_ROOT,
  'docs/multi-agent-repair/基线记录/frontend-swallowed-errors-baseline.md'
);

// 基线缓存：以（路径, mtime）为键，--update 由独立进程显式执行，进程内缓存安全。
const swallowBaselineCache = new Map();

/**
 * 加载前端吞错基线（frontend-swallowed-errors-baseline.md 的 BASELINE_START/END 标记区）。
 * 格式：`<相对路径> <未注解空 catch 数>`；查表按键小写化，规避 Windows 路径大小写漂移。
 * 基线文件缺失/损坏 → 空 Map（全部文件零容忍，门禁不静默放行）。
 */
function loadSwallowBaseline(baselinePath) {
  try {
    const stat = statSync(baselinePath);
    const cached = swallowBaselineCache.get(baselinePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
    const text = readFileSync(baselinePath, 'utf8');
    const map = new Map();
    const si = text.indexOf('<!-- BASELINE_START -->');
    const ei = text.indexOf('<!-- BASELINE_END -->');
    if (si >= 0 && ei > si) {
      for (const line of text.slice(si + 23, ei).split('\n')) {
        const m = line.match(/^\s*(\S+)\s+(\d+)\s*$/);
        if (m) map.set(m[1].toLowerCase(), Number(m[2]));
      }
    }
    swallowBaselineCache.set(baselinePath, { mtimeMs: stat.mtimeMs, map });
    return map;
  } catch {
    return new Map();
  }
}

/** 绝对路径 → 相对仓库根的 posix 路径（与 scripts/check-swallowed-errors-frontend.mjs 同口径） */
function toRepoRelative(absPath) {
  let p = String(absPath).replace(/\\/g, '/');
  const root = REPO_ROOT.replace(/\\/g, '/');
  if (p.toLowerCase().startsWith(root.toLowerCase())) p = p.slice(root.length);
  return p.replace(/^\/+/, '');
}

const noSilentCatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '空 catch / .catch(() => {}) 静默吞错必须显式处理：补 logInternalError 日志或 /* swallow-ok */ 标注（文件级基线内的存量除外）',
    },
    schema: [
      {
        type: 'object',
        properties: {
          markerRequired: { type: 'boolean' },
          baselineFile: { type: 'string' },
          reportAll: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      silent:
        '空 catch 静默吞错：请补 logInternalError(\'<scope>\', e) 日志，或用 /* swallow-ok: 原因 */ 显式标注（本文件基线 {{allowed}} 处，当前 {{count}} 处）',
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const markerRequired = options.markerRequired === true;
    const reportAll = options.reportAll === true;
    const baselineFile = options.baselineFile
      ? resolve(process.cwd(), options.baselineFile)
      : FRONTEND_SWALLOW_BASELINE;
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const findings = [];

    function isEmptyBlock(block) {
      return (
        block.body.length === 0 ||
        (block.body.length === 1 && block.body[0].type === 'EmptyStatement')
      );
    }

    // 注释豁免：阶段 A 任一注释即视为已注解；阶段 B（markerRequired）仅 swallow-ok marker 豁免。
    function isAnnotated(block) {
      const comments = sourceCode.getCommentsInside(block);
      if (comments.length === 0) return false;
      if (!markerRequired) return true;
      return comments.some((c) => /swallow-ok/.test(c.value));
    }

    return {
      CatchClause(node) {
        if (isEmptyBlock(node.body) && !isAnnotated(node.body)) findings.push(node.body);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'catch' &&
          node.arguments.length === 1
        ) {
          const handler = node.arguments[0];
          if (
            (handler.type === 'ArrowFunctionExpression' ||
              handler.type === 'FunctionExpression') &&
            handler.body.type === 'BlockStatement' &&
            isEmptyBlock(handler.body) &&
            !isAnnotated(handler.body)
          ) {
            findings.push(handler.body);
          }
        }
      },
      'Program:exit'() {
        const count = findings.length;
        if (count === 0) return;
        if (reportAll) {
          for (const node of findings) {
            context.report({ node, messageId: 'silent', data: { count, allowed: 0 } });
          }
          return;
        }
        const filename = context.filename || context.getFilename();
        const rel = toRepoRelative(filename);
        const allowed = loadSwallowBaseline(baselineFile).get(rel.toLowerCase()) ?? 0;
        if (count > allowed) {
          for (const node of findings) {
            context.report({ node, messageId: 'silent', data: { count, allowed } });
          }
        }
      },
    };
  },
};

const deprecatedRequiresReference = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        '@deprecated must include @see or @removeWhen to specify replacement or removal condition',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        for (const comment of comments) {
          const text = comment.value;
          if (
            /@deprecated\b/.test(text) &&
            !/@see\b/.test(text) &&
            !/@removeWhen\b/.test(text)
          ) {
            context.report({
              loc: comment.loc,
              message:
                '@deprecated 注释必须包含 @see 或 @removeWhen 以指明替代路径或删除条件',
            });
          }
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/target/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.agent-runtime/**',
      '**/.agents/**',
      '**/.claude/**',
      '**/.codex/**',
      '**/.codex-tool-scratch/**',
      '**/.firecrawl/**',
      '**/.trae/**',
      'reference/**',
      'assets/**',
      'docs/**',
      'analysis/**',
      'implementer/**',
      'scripts/**',
      '**/.expo/**',
      // 开发临时脚本（如根目录 debug-send.tmp.ts）不入库也不参与门禁
      '**/*.tmp.ts',
      '**/*.tmp.tsx',
      '**/*.tmp.mjs',
    ],
  },
  // Base configuration for Javascript files
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
  },
  // Base configuration for TypeScript files
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    plugins: {
      local: {
        rules: {
          'deprecated-requires-reference': deprecatedRequiresReference,
          'no-silent-catch': noSilentCatch,
        },
      },
    },
    rules: {
      'local/deprecated-requires-reference': 'error',
      'local/no-silent-catch': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
  },
  // 浏览器上下文的预启动脚本：apps/crish-desktop/public/** 由 index.html 直接加载
  // （经 vite 内联为经典脚本），运行在浏览器里用 document/window/localStorage/
  // requestAnimationFrame，不是 Node 模块。按路径声明 browser globals 是语义正确的
  // 最小修复，不放大到其它目录的 JS。
  {
    files: ['apps/crish-desktop/public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  // 静态站点（sites/**，如 sites/crish-launch 产品落地页）：由 index.html 以经典
  // <script src> 直接加载、运行在浏览器里（document/window/history/location/
  // requestAnimationFrame/navigator），不是 Node 模块，也不经打包器。根 JS 块默认的
  // Node globals 对它语义错误；按路径声明 browser globals 并按经典脚本解析。
  {
    files: ['sites/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
  },
  // apps/crish-desktop/scripts/qa/**：脚本本体跑在 Node（CommonJS 由 .cjs 决定），
  // 但 page.evaluate 的回调体在浏览器上下文执行；只补该回调体实际用到的两个全局。
  {
    files: ['apps/crish-desktop/scripts/qa/**/*.cjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  // Restrict Object.assign in Immer-based store files
  {
    files: [
      'apps/crish-desktop/src/store/slices/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="Object"][callee.property.name="assign"]',
          message: 'Immer 下禁止使用 Object.assign，请改用字段级赋值或 Object.entries 迭代',
        },
      ],
    },
  },
  // 测试/模拟代码豁免 no-explicit-any：测试夹具、mock、对抗性输入与 e2e 断言
  // 天然需要 any（覆盖 *.test.ts(x) / *.spec.ts / __tests__ / tests/ 目录与
  // test-utils 包）；生产代码仍全量执行该规则。
  // no-silent-catch 同豁免：吞错门禁只约束生产代码（对标 Rust check-swallowed-errors
  // 测试文件豁免语义），测试夹具允许有意静默。
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/__tests__/**',
      '**/tests/**',
      '**/packages/test-utils/**',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'local/no-silent-catch': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Frontend/Browser specific configuration (React)
  {
    files: [
      'apps/crish-desktop/**/*.{ts,tsx}',
      'apps/agent-workbench/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react: reactPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 维度 5：no-console 守门（warn 级先接入，console 裸调迁移完成后升 error）。
      // 所有 console.* 调用应经 LoggerService 统一输出。
      'no-console': 'warn',
      // 维度 4：组件复杂度守门（warn 级先接入，T4-6/T4-1/T4-2/T4-8 拆分完成后升 error）。
      // 禁止同文件多组件（compound component 模式通过 // eslint-disable-next-line 逐文件豁免）。
      'react/no-multi-comp': ['warn', { ignoreStateless: false }],
      // 维度 4：函数行数守门（warn 级先接入，max 150 覆盖 >100 行的 5 个超长函数；
      // skipComments/skipBlankLines 避免注释与空行惩罚，IIFEs 放行立即执行函数）。
      // 例外：React render 函数天然较长，通过 // eslint-disable-next-line 对已验证的渲染函数豁免。
      'max-lines-per-function': [
        'warn',
        {
          max: 150,
          skipComments: true,
          skipBlankLines: true,
          IIFEs: true,
        },
      ],
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  // 维度 3 步骤 1 / 决策 5：no-restricted-imports 守门（warn 级，深路径收敛有遗漏待修复后升 error）。
  // 禁止 components / hooks / app 出现深路径直连 store/api 子目录私有模块，
  // 强制走公共门面（store/storeAccess.ts、api/storeAccess.ts、各域 store 顶层）。
  // warn 级先接入以收敛存量；维度 3 步骤 2 深路径收敛清零后升级为 error 级硬阻断。
  //
  // 守门口径（glob 段数判定，非 negativeLookahead）：
  // - `**/store/*/**` + `**/store/*/*` 匹配 store/ 后 ≥2 段的深路径（禁止）；
  //   1 段路径（store/storeAccess、store/sessionStore、store/layout-tree barrel、
  //   store/types）不匹配 → 放行（这些是公共门面/顶层 store/barrel 入口）。
  // - `**/api/store-access/**` + `**/api/store-access/*` 同理禁 api/store-access/
  //   下的深路径；api/storeAccess（1 段，且名不同）放行。
  // - 各域 store 自身模块可内部深路径互引（本规则只约束 components/hooks/app 三域）。
  {
    files: [
      'apps/crish-desktop/src/components/**/*.{ts,tsx}',
      'apps/crish-desktop/src/hooks/**/*.{ts,tsx}',
      'apps/crish-desktop/src/app/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: [
                '**/store/*/**',
                '**/store/*/*',
              ],
              message:
                '禁止深路径直连 store 子目录私有模块：components/hooks/app 应经 store/storeAccess.ts 公共读面或各域 store 顶层入口（如 store/sessionStore）。深路径收敛见维度 3 步骤 2。',
            },
            {
              group: [
                '**/api/store-access/**',
                '**/api/store-access/*',
              ],
              message:
                '禁止深路径直连 api/store-access 子目录私有模块：应经 api/storeAccess.ts 公共编排门面。深路径收敛见维度 3 步骤 2。',
            },
          ],
        },
      ],
    },
  },
  // LoggerService.ts 文件级豁免（console 调用是其设计行为——统一日志输出层）
  {
    files: [
      'apps/crish-desktop/src/services/LoggerService.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  // ErrorStore.ts 文件级豁免（防递归——subscriber 回调内 console.error 不得经 LoggerService）
  {
    files: [
      'apps/crish-desktop/src/services/ErrorStore.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  // react-refresh 文件级豁免（置于 React 块之后以确保优先级）：以下组件文件
  // 按既有约定同文件导出常量/hook/子组件（拆分迁移成本高于 fast-refresh 收益，
  // 不影响运行正确性）；新文件仍要求遵守 only-export-components。
  {
    files: [
      'apps/crish-desktop/src/components/agent-card/AgentCard.tsx',
      'apps/crish-desktop/src/components/binary-tree/TreeResizeSash.tsx',
      'apps/crish-desktop/src/components/binary-tree/UnitSessionTabStrip.tsx',
      'apps/crish-desktop/src/components/card-panel/CardPanelHeader.tsx',
      'apps/crish-desktop/src/components/card-panel/CardPanelLayout.tsx',
      'apps/crish-desktop/src/components/chat-card/ChatHeader.tsx',
      'apps/crish-desktop/src/components/chat-card/ChatHeaderControls.tsx',
      'apps/crish-desktop/src/components/chat-composer/ComposerSlashMenu.tsx',
      'apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.tsx',
      'apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx',
      'apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx',
      'apps/crish-desktop/src/components/shell/VirtualList.tsx',
      'apps/crish-desktop/src/components/sidebar/SidebarContextMenus.tsx',
      'apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx',
      'apps/crish-desktop/src/dev/DevHealthOverlay.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);

// 供 scripts/check-swallowed-errors-frontend.mjs 以 reportAll 模式复用同一计数逻辑
// （保证统计脚本与门禁规则口径一致，不另写扫描器）。
export { noSilentCatch };

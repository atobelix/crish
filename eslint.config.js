import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
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
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
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
      'apps/crish-desktop/src/components/shell/GlobalSessionTabBar.tsx',
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

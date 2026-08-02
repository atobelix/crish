import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

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
        },
      },
    },
    rules: {
      'local/deprecated-requires-reference': 'error',
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

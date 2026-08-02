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
  }
);

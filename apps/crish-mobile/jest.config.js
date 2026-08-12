/** @type {import('jest').Config} */
// 移动端 jest 配置（D8 §5.2.2 目标形态）：jest-expo preset
// - moduleNameMapper：workspace 包映射到 src 直出（不映射 dist，防"改了源码 CI 用旧 dist"假绿）
// - 覆盖率阈值 60/75/70/60（D8 第 9 章：对齐桌面 45/70/65/45 的严格度上浮）
// - generated 目录排除覆盖率（生成物由协议漂移门禁保证，R0-05）
module.exports = {
  preset: 'jest-expo',
  // immer 的 react-native export condition 指向 ESM 产物（immer.legacy-esm.js），
  // 不在 jest-expo 默认 allowlist 内 → 需加入 transform 白名单（store 单测经 zustand/middleware/immer 引入）
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|immer|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@noble))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  moduleNameMapper: {
    '^@crish/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
    // 单 React 副本纪律：仓库并存多版本 react（根 node_modules 为桌面端 19.2.7），
    // 组件测试必须让 renderer / react-native / 应用代码共用 app 声明的 19.2.3 同一实例，
    // 否则出现 "Invalid hook call"（两 React 副本）。升级 React 版本时同步此三处映射。
    '^react$': '<rootDir>/node_modules/react/index.js',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime.js',
    '^react/jsx-dev-runtime$': '<rootDir>/node_modules/react/jsx-dev-runtime.js',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/__tests__/**',
    '!**/generated/**',
  ],
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 75,
      functions: 70,
      lines: 60,
    },
  },
};

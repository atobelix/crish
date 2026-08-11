/** @type {import('jest').Config} */
// 移动端 jest 配置（D8 §5.2.2 目标形态）：jest-expo preset
// - moduleNameMapper：workspace 包映射到 src 直出（不映射 dist，防"改了源码 CI 用旧 dist"假绿）
// - 覆盖率阈值 60/75/70/60（D8 第 9 章：对齐桌面 45/70/65/45 的严格度上浮）
// - generated 目录排除覆盖率（生成物由协议漂移门禁保证，R0-05）
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@crish/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
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

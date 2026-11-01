const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 监听 monorepo 根与 packages，确保 @crish/shared-* 解析稳定
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// expo-sqlite web 运行时附带 wa-sqlite wasm 资产
config.resolver.assetExts.push('wasm');

module.exports = config;

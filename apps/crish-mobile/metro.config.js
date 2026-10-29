const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite web 运行时附带 wa-sqlite wasm 资产
config.resolver.assetExts.push('wasm');

module.exports = config;

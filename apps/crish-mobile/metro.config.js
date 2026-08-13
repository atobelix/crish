// R2-16 联调临时配置（本地执行用，不入库；R2-16-acceptance-execution.md 遗留清单登记）
// 目的 1：expo-router require.context 会把 app/ 下 *.test.tsx 一并打包，
//   manual.test.tsx 引入 @testing-library/react-native（devDep）→ Node stdlib（console/util）
//   在原生运行时不可用 → Android Bundling failed。blockList 排除测试文件（标准修复面）。
// 目的 2：crypto.getRandomValues polyfill（noble/curves 需要；Expo Go Hermes 无此全局）。
//   经 serializer.customSerializer 在 bundle 代码最前面注入（不改任何源文件）。
const fs = require('fs');
const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');
const METRO_ROOT = 'C:/Software/conex/node_modules/metro/src';
const baseJSBundle = require(METRO_ROOT + '/DeltaBundler/Serializers/baseJSBundle.js').default;
const bundleToString = require(METRO_ROOT + '/lib/bundleToString.js').default;

const config = getDefaultConfig(__dirname);

config.resolver.blockList = [
  ...(config.resolver.blockList || []),
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__\/.*/,
];

const polyfillSource = fs.readFileSync(
  path.join(__dirname, 'r2-16-crypto-polyfill.js'),
  'utf8'
);

const defaultSerializer = config.serializer.customSerializer || null;
config.serializer.customSerializer = async (
  entryPoint,
  preModules,
  graph,
  options
) => {
  let code;
  if (defaultSerializer) {
    const res = await defaultSerializer(entryPoint, preModules, graph, options);
    code = typeof res === 'string' ? res : res.code;
  } else {
    code = bundleToString(
      baseJSBundle(entryPoint, preModules, graph, options)
    ).code;
  }
  return { code: polyfillSource + '\n' + code, map: null };
};

module.exports = config;

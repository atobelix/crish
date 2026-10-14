#!/usr/bin/env node
/**
 * scripts/check-i18n-unused-keys.mjs
 * 未消费死词条扫描门禁脚本 (Wave 0 门禁脚本)
 *
 * 核心功能：
 *   1. 提取 locales/ 中定义的全部可用字典键（兼容单文件与 locales/{zh-CN,en-US}/ 模块化目录结构）
 *   2. 扫描前端与工作台源码（apps/crish-desktop/src/ 等），检测这些 key 是否被有效消费
 *   3. 支持 105 核心错误码注册表（CRISH_ERROR_REGISTRY）与建议操作（action.*）动态契约放行
 *   4. 支持 --list 打印全量词条消费清单与状态
 *   5. 支持 --guide <metric> 打印修复与清退指引
 *   6. 支持 --strict 严格模式（检出孤儿词条即 exit 1，用于 Wave 5 最终收官）
 *
 * 运行方式:
 *   node scripts/check-i18n-unused-keys.mjs
 *   node scripts/check-i18n-unused-keys.mjs --list
 *   node scripts/check-i18n-unused-keys.mjs --guide unused_i18n_key
 *   node scripts/check-i18n-unused-keys.mjs --strict
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LOCALES_DIR = resolve(REPO_ROOT, 'apps/crish-desktop/src/i18n/locales');
const BASE_LOCALE = 'zh-CN';
const ERROR_REGISTRY_PATH = resolve(REPO_ROOT, 'packages/shared-types/src/errors/info.ts');
const ERROR_CODES_PATH = resolve(REPO_ROOT, 'packages/shared-types/src/errors/codes.ts');

const SCAN_DIRS = [
  'apps/crish-desktop/src',
  'apps/agent-workbench/src',
  'packages/editor-kit/src',
  'packages/block-paper/src',
  'packages/conversation-flow/src',
];

const LIST = process.argv.includes('--list');
const STRICT = process.argv.includes('--strict');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

const GUIDE_TEXT = {
  unused_i18n_key: [
    '指标：unused_i18n_key（未消费孤立词条）',
    '原因：在 locales/ 字典中定义了词条键，但全仓前端源码（apps/crish-desktop/src/ 等）中没有任何静态引用，且未在动态契约（如 105 错误码注册表）中登记。',
    '正确做法：',
    '  1. 若该词条是重构后遗留的历史死代码：直接从 locales/ 对应语言包文件中安全删除；',
    '  2. 若该词条是通过模板字符串动态拼接调用的（如 error.${code}.title）：在 scripts/check-i18n-unused-keys.mjs 的契约白名单中登记对应的模式；',
    '  3. 若该词条是后续波次计划消费的预置词条：在对应业务组件中通过 t("...") 或 <Trans i18nKey="..." /> 完成接入。',
  ],
};

/**
 * 动态加载 TS 模块并提取导出对象
 */
function loadSingleTsModule(filePath) {
  const tsCode = readFileSync(filePath, 'utf8');
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const moduleObj = { exports: {} };
  const customRequire = (relPath) => {
    const dir = dirname(filePath);
    let target = resolve(dir, relPath);
    if (!existsSync(target)) {
      if (existsSync(target + '.ts')) target = target + '.ts';
      else if (existsSync(target + '.js')) target = target + '.js';
      else if (existsSync(join(target, 'index.ts'))) target = join(target, 'index.ts');
    }
    if (existsSync(target) && !statSync(target).isDirectory()) {
      return loadSingleTsModule(target);
    }
    return {};
  };

  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', jsCode);
  fn(moduleObj, moduleObj.exports, customRequire, dirname(filePath), filePath);

  const exp = moduleObj.exports;
  if (!exp || typeof exp !== 'object') return {};

  if (exp.default && typeof exp.default === 'object' && !Array.isArray(exp.default)) {
    return exp.default;
  }
  if (exp.zhCN && typeof exp.zhCN === 'object' && !Array.isArray(exp.zhCN)) {
    return exp.zhCN;
  }
  if (exp.enUS && typeof exp.enUS === 'object' && !Array.isArray(exp.enUS)) {
    return exp.enUS;
  }
  if (exp.dictionary && typeof exp.dictionary === 'object' && !Array.isArray(exp.dictionary)) {
    return exp.dictionary;
  }

  for (const [k, v] of Object.entries(exp)) {
    if (k !== '__esModule' && v && typeof v === 'object' && !Array.isArray(v)) {
      return v;
    }
  }
  return exp;
}

/**
 * 递归读取基准语言字典
 */
function loadLocaleDictionary(localesDir, localeId) {
  const dirPath = join(localesDir, localeId);
  const singleFile = join(localesDir, `${localeId}.ts`);

  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    const aggregated = {};
    const files = readdirSync(dirPath);

    for (const file of files) {
      if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')) {
        const modName = file.replace('.ts', '');
        const modObj = loadSingleTsModule(join(dirPath, file));
        if (modObj && typeof modObj === 'object') {
          aggregated[modName] = modObj;
        }
      }
    }

    if (Object.keys(aggregated).length > 0) {
      return aggregated;
    }

    const indexPath = join(dirPath, 'index.ts');
    if (existsSync(indexPath)) {
      return loadSingleTsModule(indexPath);
    }
  }

  if (existsSync(singleFile) && statSync(singleFile).isFile()) {
    return loadSingleTsModule(singleFile);
  }

  return null;
}

/**
 * 递归展开字典键集合
 */
function flattenDictionaryKeys(obj, prefix = '', result = new Set()) {
  if (!obj || typeof obj !== 'object') return result;
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenDictionaryKeys(v, fullKey, result);
    } else {
      result.add(fullKey);
    }
  }
  return result;
}

/**
 * 递归遍历源码目录，排除 node_modules、locales 字典定义与单元测试文件
 */
function walkSourceFiles(dir, result = []) {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== 'locales' &&
        entry.name !== '__tests__' &&
        entry.name !== '.system_generated'
      ) {
        walkSourceFiles(fullPath, result);
      }
    } else if (entry.isFile()) {
      const isSource = /\.(tsx?|jsx?|mjs)$/.test(entry.name);
      const isTest = /\.(test|spec)\.(tsx?|jsx?)$/.test(entry.name);
      if (isSource && !isTest && !fullPath.includes('src/i18n/locales')) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

/**
 * 提取错误码与操作建议契约白名单（从 shared-types 动态提取）
 */
function getDynamicContractWhitelist() {
  const allowed = new Set();

  if (existsSync(ERROR_REGISTRY_PATH)) {
    const content = readFileSync(ERROR_REGISTRY_PATH, 'utf8');
    // 匹配形如 'provider.network': {
    const codeMatches = content.match(/'([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)':\s*\{/g) || [];
    for (const m of codeMatches) {
      const code = m.replace(/[':\s{]/g, '');
      allowed.add(`error.${code}.title`);
      allowed.add(code);
    }
    // 匹配形如 action: 'action.provider.check_network' 或 action: 'action.common.report_bug'
    const actionMatches = content.match(/action:\s*'([^']+)'/g) || [];
    for (const m of actionMatches) {
      const act = m.replace(/action:\s*'|'/g, '');
      allowed.add(act);
      allowed.add(act.replace(/^action\./, ''));
    }
  }

  if (existsSync(ERROR_CODES_PATH)) {
    const content = readFileSync(ERROR_CODES_PATH, 'utf8');
    const codes = content.match(/'([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)'/g) || [];
    for (const c of codes) {
      const code = c.replace(/'/g, '');
      allowed.add(`error.${code}.title`);
      allowed.add(code);
    }
  }

  return allowed;
}

/**
 * 执行死词条扫描
 */
export function checkUnusedKeys() {
  const t0 = Date.now();

  // 1. 处理 --guide 指令
  if (GUIDE !== undefined) {
    if (GUIDE && GUIDE_TEXT[GUIDE]) {
      console.log(GUIDE_TEXT[GUIDE].join('\n'));
    } else {
      console.log('可用的指引指标：');
      for (const [key, lines] of Object.entries(GUIDE_TEXT)) {
        console.log(`\n--- ${key} ---`);
        console.log(lines.join('\n'));
      }
    }
    process.exit(0);
  }

  console.log('[check-i18n-unused-keys] 开始扫描未消费死词条...');

  if (!existsSync(LOCALES_DIR)) {
    console.error(`❌ [check-i18n-unused-keys] FAIL: 语言包目录不存在: ${LOCALES_DIR}`);
    process.exit(1);
  }

  // 2. 载入基准语言字典全部键集合
  const rawDict = loadLocaleDictionary(LOCALES_DIR, BASE_LOCALE);
  if (!rawDict || typeof rawDict !== 'object') {
    console.error(`❌ [check-i18n-unused-keys] 无法载入基准语言字典: ${BASE_LOCALE}`);
    process.exit(1);
  }

  const dictKeys = flattenDictionaryKeys(rawDict);
  console.log(`  - 基准语言 [${BASE_LOCALE}] 词条总数: ${dictKeys.size} 个`);

  // 3. 收集全仓源码文件并构建文本索引
  const sourceFiles = [];
  for (const scanDir of SCAN_DIRS) {
    const fullDir = resolve(REPO_ROOT, scanDir);
    walkSourceFiles(fullDir, sourceFiles);
  }
  console.log(`  - 扫描源码文件: ${sourceFiles.length} 个`);

  const fileContents = sourceFiles.map((f) => ({
    path: f,
    content: readFileSync(f, 'utf8'),
  }));

  const fullSourceCorpus = fileContents.map((fc) => fc.content).join('\n');

  // 4. 动态契约白名单
  const contractWhitelist = getDynamicContractWhitelist();

  const usedKeys = new Set();
  const orphanKeys = [];

  for (const key of dictKeys) {
    // 检查动态错误码契约放行（例如 error.provider.network.title）
    if (contractWhitelist.has(key)) {
      usedKeys.add(key);
      continue;
    }
    if (key.startsWith('action.') && contractWhitelist.has(key.replace(/^action\./, ''))) {
      usedKeys.add(key);
      continue;
    }

    // 检查源码中是否静态出现该 key（字面量匹配）
    // 匹配形如 'key', "key", `key`
    const isPresent =
      fullSourceCorpus.includes(`'${key}'`) ||
      fullSourceCorpus.includes(`"${key}"`) ||
      fullSourceCorpus.includes(`\`${key}\``) ||
      fullSourceCorpus.includes(`>${key}<`) ||
      fullSourceCorpus.includes(`t('${key}'`) ||
      fullSourceCorpus.includes(`t("${key}"`);

    if (isPresent) {
      usedKeys.add(key);
    } else {
      orphanKeys.push(key);
    }
  }

  // 5. 处理 --list 输出
  if (LIST) {
    console.log(`\n[check-i18n-unused-keys] 全量词条消费清单 (${dictKeys.size} 个词条):`);
    for (const key of [...dictKeys].sort()) {
      const isUsed = usedKeys.has(key);
      const tag = isUsed ? '[USED]  ' : '[UNUSED]';
      console.log(`  ${tag} ${key}`);
    }
  }

  // 6. 报告与判定结论
  const elapsed = Date.now() - t0;
  console.log(`\n[check-i18n-unused-keys] 扫描完成: 已消费 ${usedKeys.size} 个，未消费 ${orphanKeys.length} 个 (耗时: ${elapsed}ms)`);

  if (orphanKeys.length > 0) {
    console.warn(`\n⚠️  [check-i18n-unused-keys] 检出 ${orphanKeys.length} 个疑似未消费的孤立词条:`);
    for (const key of orphanKeys.slice(0, 20)) {
      console.warn(
        `⚠️  [check-i18n-unused-keys] 未消费孤立词条 · 词条 [${key}] · 实测: 0 处引用 · 阈值: 必须被有效消费 · 正确做法: 若为废弃键请从 locales/ 清退；若为后续波次预置词条请尽快接入`
      );
    }
    if (orphanKeys.length > 20) {
      console.warn(`  ... 等共 ${orphanKeys.length} 项未消费词条，使用 --list 查看全量明细。`);
    }

    if (STRICT) {
      console.error(`\n❌ [check-i18n-unused-keys] 严格模式阻断: 发现 ${orphanKeys.length} 个未消费孤立词条！`);
      process.exit(1);
    } else {
      console.log('  提示：当前处于实现准备波次，预置词条未消费暂不阻断。运行 `node scripts/check-i18n-unused-keys.mjs --guide unused_i18n_key` 获取指引。');
      process.exit(0);
    }
  }

  console.log(`\n✅ [check-i18n-unused-keys] 完美！全量词典键均被有效消费，零死词条残留 (耗时: ${elapsed}ms)`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  checkUnusedKeys();
}

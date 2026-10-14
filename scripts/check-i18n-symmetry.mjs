#!/usr/bin/env node
/**
 * scripts/check-i18n-symmetry.mjs
 * 词典 100% 对称性与语言纯度断言扫描器 (Wave 0 门禁脚本)
 *
 * 核心断言：
 *   1. 动态感知全语言包（兼容单文件与 locales/{zh-CN,en-US}/ 模块化目录结构）
 *   2. 键集合对齐断言 (Key Parity)：zh-CN 与 en-US 键集合严格一致，零缺失、零冗余
 *   3. 参数对称性断言 (Parameter Parity)：同一词条在双语字典中的 {param} 参数占位符集合恒等
 *   4. 非中文包语言纯度断言 (Language Purity)：en-US 等非中文包严禁包含汉字与全角中文标点（零容忍防作弊）
 *   5. 叶子节点有效性断言：零空值、零空白、拒绝 "TODO", "TBD" 等敷衍性占位文本
 *
 * 运行方式:
 *   node scripts/check-i18n-symmetry.mjs
 *   node scripts/check-i18n-symmetry.mjs --list
 *   node scripts/check-i18n-symmetry.mjs --guide <metric>
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

const LIST = process.argv.includes('--list');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

// 汉字字符集与全角中文标点正则
const CHINESE_CHAR_REGEX = /[\u4e00-\u9fa5\u4e00-\u9fff]/;
const CHINESE_PUNCT_REGEX = /[\u3000-\u303f\uff01-\uff5e]/;
const CHINESE_PURITY_REGEX = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/;

const INTERPOLATION_REGEX = /\{([a-zA-Z0-9_]+)\}/g;
const JUNK_VALUES = new Set(['todo', 'tbd', 'temp', 'fixme', 'n/a', '...', 'test']);

const GUIDE_TEXT = {
  key_parity_mismatch: [
    '指标：key_parity_mismatch（键集合对齐失败）',
    '原因：目标语言包（如 en-US）与基准语言包（zh-CN）的词条键集合不一致，存在缺失键或未在基准中定义的冗余键。',
    '正确做法：',
    '  1. 若目标语言缺失键：在 apps/crish-desktop/src/i18n/locales/<lang>/ 对应模块中补充该键名并翻译；',
    '  2. 若目标语言冗余键：核对 zh-CN 是否漏定义，或清理孤立废弃键；',
    '  3. 保持双语字典结构 100% 对称，禁止单侧遗漏。',
  ],
  param_parity_mismatch: [
    '指标：param_parity_mismatch（插值参数对称性失败）',
    '原因：同一词条在 zh-CN 与目标语言中的 {param} 参数占位符集合不一致（存在漏参、多参或拼写不一致）。',
    '正确做法：',
    '  1. 检查报错词条在 zh-CN 与 en-US 中的模板字符串；',
    '  2. 确保双语占位符完全同名且集合恒等（例如：zh-CN 为 "{count} 项"，en-US 必须为 "{count} items"，严禁漏掉 {count} 或误写为 {total}）；',
    '  3. 严禁字符串裸拼接，所有动态变量统一由命名占位符包裹。',
  ],
  en_purity_violation: [
    '指标：en_purity_violation（非中文语言纯度违规）',
    '原因：en-US 等非中文语言包中检出了中文字符（[\\u4e00-\\u9fff]）或全角中文标点（[\\u3000-\\u303f\\uff01-\\uff5e]），涉嫌原样复制中文冒充英文的假翻译作弊。',
    '正确做法：',
    '  1. 将检出中文的词条彻底翻译为符合桌面应用规范的地道英文；',
    '  2. 将全角中文标点（，。？！：；（）【】“”‘’）替换为对应的半角英文标点（, . ? ! : ; () [] "" \'\'）；',
    '  3. 严禁在非中文包中保留任何汉字字符与全角标点。',
  ],
};

/**
 * 动态编译并安全执行 TS 代码，提取导出的对象
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

  // 兜底：查找第一个非 __esModule 的对象值
  for (const [k, v] of Object.entries(exp)) {
    if (k !== '__esModule' && v && typeof v === 'object' && !Array.isArray(v)) {
      return v;
    }
  }
  return exp;
}

/**
 * 递归读取语言字典，自动兼容单文件与子目录物理结构
 */
function loadLocaleDictionary(localesDir, localeId) {
  const dirPath = join(localesDir, localeId);
  const singleFile = join(localesDir, `${localeId}.ts`);

  // 1. 若存在对应的子目录（模块化物理目录）
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    const aggregated = {};
    const files = readdirSync(dirPath);

    // 优先按各独立模块文件加载并聚合
    for (const file of files) {
      if (file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')) {
        const modName = file.replace('.ts', '');
        const modObj = loadSingleTsModule(join(dirPath, file));
        if (modObj && typeof modObj === 'object') {
          aggregated[modName] = modObj;
        }
      }
    }

    // 若子目录包含模块文件，返回聚合结果
    if (Object.keys(aggregated).length > 0) {
      return aggregated;
    }

    // 若子目录下仅有 index.ts，加载 index.ts
    const indexPath = join(dirPath, 'index.ts');
    if (existsSync(indexPath)) {
      return loadSingleTsModule(indexPath);
    }
  }

  // 2. 若存在单文件
  if (existsSync(singleFile) && statSync(singleFile).isFile()) {
    const obj = loadSingleTsModule(singleFile);
    return obj;
  }

  return null;
}

/**
 * 递归展开字典为扁平点分映射表
 */
function flattenDictionary(obj, prefix = '', result = new Map()) {
  if (!obj || typeof obj !== 'object') return result;
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenDictionary(v, fullKey, result);
    } else {
      result.set(fullKey, String(v ?? ''));
    }
  }
  return result;
}

/**
 * 提取字符串中的所有参数占位符（排序去重）
 */
function extractParams(str) {
  if (typeof str !== 'string') return [];
  const matches = [];
  let m;
  const re = new RegExp(INTERPOLATION_REGEX.source, 'g');
  while ((m = re.exec(str))) {
    matches.push(m[1]);
  }
  return Array.from(new Set(matches)).sort();
}

/**
 * 执行全仓词典对称性与语言纯度断言
 */
export function checkI18nSymmetry() {
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

  console.log(`[check-i18n-symmetry] 扫描语言包根目录: ${LOCALES_DIR}`);

  if (!existsSync(LOCALES_DIR)) {
    console.error(`❌ [check-i18n-symmetry] FAIL: 语言包目录不存在: ${LOCALES_DIR}`);
    process.exit(1);
  }

  // 2. 探测所有可用语言包
  const entries = readdirSync(LOCALES_DIR);
  const discoveredLocales = new Set();

  for (const entry of entries) {
    const full = join(LOCALES_DIR, entry);
    if (statSync(full).isDirectory()) {
      discoveredLocales.add(entry);
    } else if (entry.endsWith('.ts') && entry !== 'index.ts' && !entry.endsWith('.test.ts')) {
      discoveredLocales.add(entry.replace('.ts', ''));
    }
  }

  if (!discoveredLocales.has(BASE_LOCALE)) {
    console.error(`❌ [check-i18n-symmetry] FAIL: 缺少基准语言包 ${BASE_LOCALE}！`);
    process.exit(1);
  }

  const loadedDictionaries = new Map();
  for (const loc of discoveredLocales) {
    try {
      const rawDict = loadLocaleDictionary(LOCALES_DIR, loc);
      if (!rawDict || typeof rawDict !== 'object') {
        console.error(`❌ [check-i18n-symmetry] 无法从语言包 [${loc}] 中解析出有效的字典对象`);
        process.exit(1);
      }
      const flatMap = flattenDictionary(rawDict);
      loadedDictionaries.set(loc, flatMap);
      console.log(`  - 载入语言包 [${loc}]: ${flatMap.size} 个词条`);
    } catch (err) {
      console.error(`❌ [check-i18n-symmetry] 加载语言包 [${loc}] 异常: ${err.message}`);
      process.exit(1);
    }
  }

  const baseMap = loadedDictionaries.get(BASE_LOCALE);
  let totalViolations = 0;
  const violationReports = [];

  // 3. 对每一个目标语言包执行严格五重断言
  for (const [loc, targetMap] of loadedDictionaries.entries()) {
    if (loc === BASE_LOCALE) continue;

    console.log(`\n[check-i18n-symmetry] 正在比对 [${BASE_LOCALE}] 与 [${loc}]...`);

    // 断言 1: 键对称性 (Key Parity)
    const missingKeys = [...baseMap.keys()].filter((k) => !targetMap.has(k)).sort();
    const redundantKeys = [...targetMap.keys()].filter((k) => !baseMap.has(k)).sort();

    for (const key of missingKeys) {
      totalViolations++;
      violationReports.push(
        `❌ [check-i18n-symmetry] 键集合对齐失败 · ${loc} · 词条 [${key}] · 实测: 缺失 · 阈值: 必须存在 · 正确做法: 在 locales/${loc} 中补充对应词条并翻译`
      );
    }

    for (const key of redundantKeys) {
      totalViolations++;
      violationReports.push(
        `❌ [check-i18n-symmetry] 键集合对齐失败 · ${loc} · 词条 [${key}] · 实测: 冗余 · 阈值: zh-CN 未声明 · 正确做法: 在 zh-CN 补充对应词条或清理 ${loc} 的孤立键`
      );
    }

    // 断言 2, 3, 4, 5: 叶子值检验
    for (const [key, baseVal] of baseMap.entries()) {
      if (!targetMap.has(key)) continue;
      const targetVal = targetMap.get(key);

      // 断言 2: 零空值与有效性
      if (typeof targetVal !== 'string' || targetVal.trim().length === 0) {
        totalViolations++;
        violationReports.push(
          `❌ [check-i18n-symmetry] 空值违规 · ${loc} · 词条 [${key}] · 实测: 空字符串或空白 · 阈值: 非空字符串 · 正确做法: 补充词条翻译，禁止空占位`
        );
        continue;
      }

      // 断言 3: 非中文包语言纯度断言（零容忍拦截汉字与全角中文标点）
      if (!loc.startsWith('zh')) {
        const hasChineseChar = CHINESE_CHAR_REGEX.test(targetVal);
        const hasChinesePunct = CHINESE_PUNCT_REGEX.test(targetVal);
        if (hasChineseChar || hasChinesePunct) {
          totalViolations++;
          const reason = hasChineseChar ? '包含未翻译中文字符' : '包含全角中文标点';
          violationReports.push(
            `❌ [check-i18n-symmetry] 语言纯度违规 · ${loc} · 词条 [${key}] · 实测: ${reason} "${targetVal}" · 阈值: 100% 英文纯度 · 正确做法: 彻底翻译该词条为英文并将标点改为半角英文标点`
          );
        }
      }

      // 断言 4: 参数对称性断言
      const baseParams = extractParams(baseVal);
      const targetParams = extractParams(targetVal);
      if (baseParams.join(',') !== targetParams.join(',')) {
        totalViolations++;
        violationReports.push(
          `❌ [check-i18n-symmetry] 参数对称性失败 · ${loc} · 词条 [${key}] · 实测: [${targetParams.join(', ')}] · 阈值: 基准 [${baseParams.join(', ')}] · 正确做法: 确保双语包含完全一致的 {param} 占位符集合`
        );
      }

      // 断言 5: 拒绝敷衍占位
      const trimmedLower = targetVal.trim().toLowerCase();
      if (JUNK_VALUES.has(trimmedLower) || targetVal.trim() === key) {
        totalViolations++;
        violationReports.push(
          `❌ [check-i18n-symmetry] 敷衍占位违规 · ${loc} · 词条 [${key}] · 实测: 占位文本 "${targetVal}" · 阈值: 真实有效文案 · 正确做法: 补充地道翻译，禁止占位符敷衍`
        );
      }
    }
  }

  // 4. 处理 --list 明细输出
  if (LIST) {
    console.log(`\n[check-i18n-symmetry] 全量词条对称性与纯度检查清单 (${baseMap.size} 个基准词条):`);
    for (const [key, baseVal] of baseMap.entries()) {
      const enMap = loadedDictionaries.get('en-US');
      const enVal = enMap ? enMap.get(key) : undefined;
      const status = enVal ? (CHINESE_PURITY_REGEX.test(enVal) ? '[FAIL:CHINESE]' : '[OK]') : '[MISSING]';
      console.log(`  ${status.padEnd(16)} ${key} -> zh: "${baseVal.slice(0, 30)}" | en: "${(enVal || '').slice(0, 30)}"`);
    }
  }

  // 5. 判定结论与报告输出
  const elapsed = Date.now() - t0;
  if (totalViolations > 0) {
    console.error(`\n❌ [check-i18n-symmetry] 门禁阻断: 发现 ${totalViolations} 处词典违规 (耗时: ${elapsed}ms)`);
    for (const report of violationReports.slice(0, 25)) {
      console.error(report);
    }
    if (violationReports.length > 25) {
      console.error(`  ... 等共 ${totalViolations} 项违规，使用 --list 查看全量明细。`);
    }
    console.error('\n提示：运行 `node scripts/check-i18n-symmetry.mjs --guide <metric>` 获取修复指引。');
    process.exit(1);
  }

  console.log(`\n✅ [check-i18n-symmetry] 完美通过！词典 100% 对齐，纯度无汉字，参数集合恒等 (耗时: ${elapsed}ms)`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  checkI18nSymmetry();
}

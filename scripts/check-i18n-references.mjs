#!/usr/bin/env node
/**
 * scripts/check-i18n-references.mjs
 * i18n 引用完整性门禁（错键家族整改批 6 固化，与审计同一口径）
 *
 * 背景：既有 symmetry 门禁只能保证双语词典键集对称，无法发现「代码引用了
 * 词典中不存在的键」这一类错键（引用侧/契约侧缺陷）。本脚本以运行时口径
 * 复扫三类引用源，解析失败且未登记基线豁免的一律报错：
 *
 *   1. 字面源：apps/crish-desktop/src 非测试源码中的键形字符串字面量
 *      （TS AST 抽取，含对象键名与模板无替换字面量），逐个按
 *      I18nContext.resolveInSingleDict 的三级规则等价判定
 *      （整键直读 → 首段命名空间 + 扁平余键 → 逐段遍历）。
 *   2. 注册表源：错误注册表（packages/shared-types/src/generated/errors/）
 *      的全部错误码 → 候选键 error.<code>.title；全部 action 值 → 候选键本身。
 *      这是 error-translation.ts 以模板 `error.${code}.title` 与 payload.action
 *      动态消费的值域全集。
 *   3. 模板源：源码中的模板字符串骨架（如 settings.tabs.${id}）。值域由数据
 *      驱动、无法静态枚举的动态机制，须在基线中逐项登记为例外后才放行。
 *
 * 豁免基线：scripts/check-i18n-references-baseline.json
 *   每项含 id / source / file（仓库相对路径 glob）/ key（精确）或
 *   keyPattern（正则；特殊值 "@registry-code" 表示键属于注册表错误码集合）
 *   / reason（人工评审理由）。新增豁免须人工评审，禁止整文件放行真实键。
 *
 * 运行方式：
 *   node scripts/check-i18n-references.mjs          # 校验，失败 exit 1
 *   node scripts/check-i18n-references.mjs --dump   # 附带打印全部豁免明细
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(REPO_ROOT, 'apps/crish-desktop/src');
const LOCALES_DIR = join(SRC_DIR, 'i18n', 'locales');
const REGISTRY_INFO_PATH = resolve(REPO_ROOT, 'packages/shared-types/src/generated/errors/info.ts');
const REGISTRY_CODES_PATH = resolve(REPO_ROOT, 'packages/shared-types/src/generated/errors/codes.ts');
const BASELINE_PATH = resolve(__dirname, 'check-i18n-references-baseline.json');

const DUMP = process.argv.includes('--dump');

/* ------------------------------------------------------------------ */
/* 词典加载（与 check-i18n-unused-keys.mjs 同款 TS 转译求值）            */
/* ------------------------------------------------------------------ */

function evaluateTsModule(filePath) {
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
      // 返回原始 exports（保留 .default 与 __esModule），使被求值模块内部的
      // 默认导入（common_1.default 等）与互操作助手按真实语义工作
      return evaluateTsModule(target);
    }
    return {};
  };

  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', jsCode);
  fn(moduleObj, moduleObj.exports, customRequire, dirname(filePath), filePath);
  return moduleObj.exports;
}

function loadSingleTsModule(filePath) {
  const exp = evaluateTsModule(filePath);
  if (!exp || typeof exp !== 'object') return {};
  if (exp.default && typeof exp.default === 'object' && !Array.isArray(exp.default)) {
    return exp.default;
  }
  for (const [k, v] of Object.entries(exp)) {
    if (k !== '__esModule' && v && typeof v === 'object' && !Array.isArray(v)) {
      return v;
    }
  }
  return exp;
}

function loadRuntimeDictionary(localeId) {
  const indexPath = join(LOCALES_DIR, localeId, 'index.ts');
  const dict = loadSingleTsModule(indexPath);
  // 设置域词典已拆为懒加载：静态词典的 settings 仅含核心子集，
  // 引用口径仍按全量校验——把 settings-domain/settingsFull 汇合的全量
  // 设置词典并回 settings 命名空间（与运行时 I18nProvider 的合并口径一致）。
  const fullPath = join(LOCALES_DIR, localeId, 'settings-domain', 'settingsFull.ts');
  if (existsSync(fullPath)) {
    // loadSingleTsModule 返回挑选后的导出值：settingsFull.ts 的默认导出即
    // 全量设置词典对象本身（扁平点分键，与核心 settings 的 title 键同源），
    // 故校验其形态后直接作为 settings 命名空间（形态不符时不合并、保持红）。
    const settingsFull = loadSingleTsModule(fullPath);
    if (
      settingsFull &&
      typeof settingsFull === 'object' &&
      typeof settingsFull.title === 'string'
    ) {
      dict.settings = settingsFull;
    }
  }
  return dict;
}

/* ------------------------------------------------------------------ */
/* resolveInSingleDict 等价实现（与 I18nContext.tsx 逐级对齐）          */
/* ------------------------------------------------------------------ */

function resolveInSingleDict(dict, key) {
  if (!dict || typeof dict !== 'object' || !key) return undefined;

  // 1. 整键直读（扁平配置）
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    const direct = dict[key];
    if (typeof direct === 'string') return direct;
  }

  // 2. 首段命名空间 + 扁平余键
  const firstDot = key.indexOf('.');
  if (firstDot > 0) {
    const ns = key.slice(0, firstDot);
    const subKey = key.slice(firstDot + 1);
    if (Object.prototype.hasOwnProperty.call(dict, ns)) {
      const subDict = dict[ns];
      if (subDict && typeof subDict === 'object') {
        if (Object.prototype.hasOwnProperty.call(subDict, subKey)) {
          const val = subDict[subKey];
          if (typeof val === 'string') return val;
        }
      }
    }
  }

  // 3. 逐段遍历
  const parts = key.split('.');
  let current = dict;
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return undefined;
    }
    if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
    ) {
      current = current[part];
    } else {
      current = undefined;
      break;
    }
  }
  if (typeof current === 'string') return current;
  return undefined;
}

function resolvesInBoth(dictZh, dictEn, key) {
  return (
    resolveInSingleDict(dictZh, key) !== undefined &&
    resolveInSingleDict(dictEn, key) !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* 注册表值域抽取（双引号生成文件，兼容单引号）                          */
/* ------------------------------------------------------------------ */

function loadRegistryDomains() {
  const codes = new Set();
  const codesContent = readFileSync(REGISTRY_CODES_PATH, 'utf8');
  const arrayStart = codesContent.indexOf('CRISH_ERROR_CODES');
  const arrayEnd = codesContent.indexOf(']', arrayStart);
  const arrayText = codesContent.slice(arrayStart, arrayEnd);
  for (const m of arrayText.matchAll(/["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/g)) {
    codes.add(m[1]);
  }

  const actions = new Set();
  const infoContent = readFileSync(REGISTRY_INFO_PATH, 'utf8');
  for (const m of infoContent.matchAll(/action:\s*["']([^"']+)["']/g)) {
    actions.add(m[1]);
  }
  return { codes, actions };
}

/* ------------------------------------------------------------------ */
/* 字面/模板源抽取（TS AST）                                            */
/* ------------------------------------------------------------------ */

const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

function walkSourceFiles(dir, result = []) {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== '__tests__' &&
        fullPath !== LOCALES_DIR
      ) {
        walkSourceFiles(fullPath, result);
      }
    } else if (entry.isFile()) {
      const isSource = /\.(tsx?)$/.test(entry.name);
      const isTest = /\.(test|spec)\.(tsx?)$/.test(entry.name);
      if (isSource && !isTest) result.push(fullPath);
    }
  }
  return result;
}

function extractFromFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
  const literals = [];
  const templates = [];

  const visit = (node, parent) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text;
      if (KEY_SHAPE.test(v)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        // t()/translate() 的第一实参位置：这是「从不直接喂给 t()」这一
        // §四分类前提的强制点——处于该位置的字面量永不适用基线豁免
        let inTranslateCall = false;
        if (parent && ts.isCallExpression(parent) && parent.arguments[0] === node) {
          const callee = parent.expression;
          if (ts.isIdentifier(callee) && (callee.text === 't' || callee.text === 'translate')) {
            inTranslateCall = true;
          } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 't') {
            inTranslateCall = true;
          }
        }
        literals.push({ key: v, line: line + 1, inTranslateCall });
      }
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      const skeleton = parts.join('${}');
      // 占位段以普通字符替换后仍呈点分键形者，才视为动态键骨架
      // （DOM id / React key 类模板如 `size-${}` 不含点分结构，自然排除）
      if (KEY_SHAPE.test(skeleton.split('${}').join('x'))) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        templates.push({ key: skeleton, line: line + 1 });
      }
    }
    node.forEachChild((child) => visit(child, node));
  };
  visit(sf, null);
  return { literals, templates };
}

/* ------------------------------------------------------------------ */
/* 豁免基线                                                             */
/* ------------------------------------------------------------------ */

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function loadBaseline(registryCodes) {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return raw.entries.map((e) => ({
    ...e,
    fileRe: globToRegExp(e.file),
    keyRe:
      e.keyPattern && e.keyPattern !== '@registry-code'
        ? new RegExp(e.keyPattern)
        : null,
    isRegistryCodeSet: e.keyPattern === '@registry-code',
    registryCodes,
  }));
}

function matchBaseline(entries, candidate) {
  for (const e of entries) {
    if (e.source !== 'any' && e.source !== candidate.source) continue;
    if (!e.fileRe.test(candidate.file)) continue;
    if (e.key !== undefined) {
      if (e.key === candidate.key) return e;
    } else if (e.isRegistryCodeSet) {
      if (e.registryCodes.has(candidate.key)) return e;
    } else if (e.keyRe) {
      if (e.keyRe.test(candidate.key)) return e;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function main() {
  console.log('[check-i18n-references] 开始 i18n 引用完整性复扫...');

  const dictZh = loadRuntimeDictionary('zh-CN');
  const dictEn = loadRuntimeDictionary('en-US');
  if (!dictZh || !dictEn || Object.keys(dictZh).length === 0) {
    console.error('❌ [check-i18n-references] FAIL: 词典加载失败');
    process.exit(1);
  }
  console.log(
    `  - 词典加载: zh-CN / en-US（顶层命名空间 ${Object.keys(dictZh).length} 个）`
  );

  const { codes: registryCodes, actions: registryActions } = loadRegistryDomains();
  console.log(
    `  - 注册表值域: 错误码 ${registryCodes.size} 个，action 键 ${registryActions.size} 个`
  );

  const baseline = loadBaseline(registryCodes);
  console.log(`  - 豁免基线: ${baseline.length} 项`);

  const candidates = [];
  const seen = new Set();
  const push = (c) => {
    const id = `${c.source}${c.file}${c.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push(c);
  };

  // 字面/模板源
  const files = walkSourceFiles(SRC_DIR);
  const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');
  for (const f of files) {
    const { literals, templates } = extractFromFile(f);
    for (const lit of literals) {
      push({
        source: 'literal',
        file: rel(f),
        line: lit.line,
        key: lit.key,
        inTranslateCall: lit.inTranslateCall,
      });
    }
    for (const tpl of templates) {
      // error.${code}.title 家族已由注册表源全集覆盖，此处不重复判定
      if (tpl.key === 'error.${}.title') continue;
      push({ source: 'template', file: rel(f), line: tpl.line, key: tpl.key });
    }
  }

  // 注册表源
  const REGISTRY_FILE = 'packages/shared-types/src/generated/errors/info.ts';
  for (const code of registryCodes) {
    push({ source: 'registry', file: REGISTRY_FILE, line: 0, key: `error.${code}.title` });
  }
  for (const act of registryActions) {
    push({ source: 'registry', file: REGISTRY_FILE, line: 0, key: act });
  }

  console.log(`  - 候选键总数: ${candidates.length}（文件 ${files.length} 个）`);

  const failures = [];
  const exempted = [];
  let resolvedCount = 0;

  for (const c of candidates) {
    if (resolvesInBoth(dictZh, dictEn, c.key)) {
      resolvedCount++;
      continue;
    }
    // t() 直呼位置的字面量不适用任何基线豁免（见 extractFromFile 注释）
    const entry =
      c.source === 'literal' && c.inTranslateCall ? null : matchBaseline(baseline, c);
    if (entry) {
      exempted.push({ ...c, baselineId: entry.id });
    } else {
      failures.push(c);
    }
  }

  // 注册表覆盖口径（§七.2）：标题与 action 键分别统计
  const titleTotal = registryCodes.size;
  const titleFailed = failures.filter(
    (f) => f.source === 'registry' && f.key.startsWith('error.')
  ).length;
  const titleExempted = exempted.filter(
    (f) => f.source === 'registry' && f.key.startsWith('error.')
  ).length;
  const actionTotal = registryActions.size;
  const actionFailed = failures.filter(
    (f) => f.source === 'registry' && f.key.startsWith('action.')
  ).length;
  const actionExempted = exempted.filter(
    (f) => f.source === 'registry' && f.key.startsWith('action.')
  ).length;

  console.log(
    `  - 判定: 已解析 ${resolvedCount}，基线豁免 ${exempted.length}，失败 ${failures.length}`
  );
  console.log(
    `  - 注册表标题覆盖: ${titleTotal - titleFailed - titleExempted}/${titleTotal}` +
      (titleExempted ? `（另豁免 ${titleExempted}）` : '')
  );
  console.log(
    `  - 注册表 action 覆盖: ${actionTotal - actionFailed - actionExempted}/${actionTotal}` +
      (actionExempted ? `（另豁免 ${actionExempted}）` : '')
  );

  if (DUMP) {
    console.log('\n[check-i18n-references] 豁免明细 (--dump):');
    for (const e of exempted) {
      console.log(`  [EXEMPT:${e.baselineId}] ${e.key} · ${e.file}${e.line ? ':' + e.line : ''}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ [check-i18n-references] FAIL: ${failures.length} 个引用解析失败（基线外）:`);
    for (const f of failures) {
      console.error(
        `  ✗ [${f.source}] ${f.key} · ${f.file}${f.line ? ':' + f.line : ''}` +
          (f.inTranslateCall ? ' [t()直呼]' : '')
      );
    }
    console.error(
      '  处置: 真错键请修引用/补词典；确属非 i18n 标识或动态机制者，须人工评审后登记到 scripts/check-i18n-references-baseline.json。'
    );
    process.exit(1);
  }

  console.log('\n✅ [check-i18n-references] PASS: 全部引用可解析或已登记豁免，零基线外失败');
  process.exit(0);
}

main();

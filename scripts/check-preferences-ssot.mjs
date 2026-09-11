#!/usr/bin/env node
/**
 * scripts/check-preferences-ssot.mjs
 * 偏好与存储 SSOT 门禁 (Preferences & Storage SSOT Guardrail)
 *
 * 规范要求：
 * 1. 禁止在组件 (components/**) 中直接调用 localStorage.setItem / window.localStorage.setItem；
 * 2. 禁止在非 preferencesClient 的 store (store/**) 中直接调用 localStorage.setItem；
 * 3. 禁止在生产代码中操作已废弃的旧偏好 Key（如 crish_theme, crish_theme_skin, crish-layout-v1, conex_pi_settings 等）。
 *
 * 违规立即以退出码 1 阻断，并输出结构化、可操作的修复指引。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DESKTOP_SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

const REPORT_ONLY = process.argv.includes('--report') || process.argv.includes('--list');

/** 废弃的旧偏好 Key 列表（严禁在生产代码中进行读写或直接引用） */
const DEPRECATED_PREFERENCE_KEYS = [
  'crish_theme',
  'crish_theme_skin',
  'crish_theme_custom_bg',
  'crish_theme_custom_fg',
  'crish_font_size_adjust',
  'crish_theme_brightness_adjust',
  'crish_theme_brightness_vibrant',
  'crish_theme_brightness_auto_time',
  'crish-layout-v1',
  'crish_session_store_v1',
  'conex_pi_settings',
  'crish_settings',
  'crish_sidebar_width',
  'crish:files-list-ratio',
  'crish:file-viewer-word-wrap',
  'crish_app_mode',
  'crish_product_shell',
  'crish_show_engine_settings',
  'crish_fonts',
];

/** 豁免白名单：声明式注册表、类型定义与特定迁移/设置底层等非偏好业务文件 */
const EXEMPT_PATHS = new Set([
  // 集中声明废弃 Key 登记信息的注册表
  'api/localStorageApi.ts',
  // 仅包含命令/Key 字符串常量的定义文件（纯类型/常量声明）
  'api/themeTypes.ts',
  'utils/storageKeys.ts',
  // 全局应用设置（模型/提供商等非 UI 偏好）持久化模块
  'api/clientApiSettings.ts',
  // 旧版二叉树布局存量数据单向迁移器（只读一次后静默）
  'store/layout-tree/migration.ts',
]);

function isExemptPath(relPath) {
  if (relPath.startsWith('api/preferences/')) return true;
  return EXEMPT_PATHS.has(relPath);
}

function isTestFile(relPath) {
  return (
    relPath.includes('__tests__') ||
    /\.test\.[tj]sx?$/.test(relPath) ||
    /\.spec\.[tj]sx?$/.test(relPath)
  );
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const errors = [];

const files = walk(DESKTOP_SRC);

for (const abs of files) {
  const rel = path.relative(DESKTOP_SRC, abs).replace(/\\/g, '/');

  // 忽略单元测试与负向契约测试文件（测试合法测试旧 Key 负向断言与 Mock）
  if (isTestFile(rel)) continue;
  if (isExemptPath(rel)) continue;

  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    // 剔除注释
    const cleanLine = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    if (!cleanLine.trim()) return;

    // 检查 1: 组件直写 localStorage.setItem
    if (rel.startsWith('components/')) {
      if (/(?:window\.)?localStorage\.setItem\s*\(/.test(cleanLine)) {
        errors.push({
          type: 'COMPONENT_SET_ITEM',
          file: rel,
          line: idx + 1,
          code: cleanLine.trim(),
          message: '禁止在组件中直接调用 localStorage.setItem，必须经由对应 Store 或 preferencesClient 统一更新状态',
        });
      }
    }

    // 检查 2: 非 preferencesClient 的 store 直写 localStorage.setItem
    if (rel.startsWith('store/') && !rel.includes('preferencesClient')) {
      if (/(?:window\.)?localStorage\.setItem\s*\(/.test(cleanLine)) {
        errors.push({
          type: 'STORE_SET_ITEM',
          file: rel,
          line: idx + 1,
          code: cleanLine.trim(),
          message: '禁止在非 preferencesClient 的 Store 中直接调用 localStorage.setItem，持久化必须接入统一通道',
        });
      }
    }

    // 检查 3: 操作废弃的偏好 Key
    for (const key of DEPRECATED_PREFERENCE_KEYS) {
      const keyPattern = new RegExp(`['"\`]${key}['"\`]`);
      if (keyPattern.test(cleanLine)) {
        errors.push({
          type: 'DEPRECATED_KEY_USAGE',
          file: rel,
          line: idx + 1,
          code: cleanLine.trim(),
          message: `禁止操作已废弃的偏好 Key [${key}]，旧偏好 Key 必须彻底切除并收敛至 preferencesClient SSOT 架构`,
        });
      }
    }
  });
}

if (errors.length > 0) {
  console.error('[check-preferences-ssot] FAIL: 拦截到违规的 localStorage 写入或废弃偏好 Key 引用：\n');

  const componentViolations = errors.filter((e) => e.type === 'COMPONENT_SET_ITEM');
  const storeViolations = errors.filter((e) => e.type === 'STORE_SET_ITEM');
  const deprecatedKeyViolations = errors.filter((e) => e.type === 'DEPRECATED_KEY_USAGE');

  if (componentViolations.length) {
    console.error(`--- [违规 1] 组件直写 localStorage.setItem (${componentViolations.length} 处) ---`);
    for (const v of componentViolations.slice(0, 20)) {
      console.error(`  - ${v.file}:${v.line}  ${v.code}`);
    }
    if (componentViolations.length > 20) {
      console.error(`  ... 另有 ${componentViolations.length - 20} 处`);
    }
    console.error('');
  }

  if (storeViolations.length) {
    console.error(`--- [违规 2] 非 preferencesClient Store 直写 localStorage.setItem (${storeViolations.length} 处) ---`);
    for (const v of storeViolations.slice(0, 20)) {
      console.error(`  - ${v.file}:${v.line}  ${v.code}`);
    }
    if (storeViolations.length > 20) {
      console.error(`  ... 另有 ${storeViolations.length - 20} 处`);
    }
    console.error('');
  }

  if (deprecatedKeyViolations.length) {
    console.error(`--- [违规 3] 操作废弃偏好 Key (${deprecatedKeyViolations.length} 处) ---`);
    for (const v of deprecatedKeyViolations.slice(0, 30)) {
      console.error(`  - ${v.file}:${v.line}  ${v.code}`);
    }
    if (deprecatedKeyViolations.length > 30) {
      console.error(`  ... 另有 ${deprecatedKeyViolations.length - 30} 处`);
    }
    console.error('');
  }

  console.error('==================== 明确修复指引 ====================');
  console.error('1. 组件直写 localStorage 修复指引：');
  console.error('   - 根因：UI 组件直接调用 localStorage.setItem 破坏了状态单向流与响应式订阅，导致多窗口/多实例状态不同步；');
  console.error('   - 处置：将状态收敛至对应领域 Store (如 useLayoutStore / useSessionStore) 或 preferencesClient，在 Store Action 中管理持久化；');
  console.error('2. Store 直写 localStorage 修复指引：');
  console.error('   - 根因：Store 散落直写 localStorage 会绕过 preferencesSchema 的数据校验与类型守卫；');
  console.error('   - 处置：用户偏好与配置必须统一通过 api/preferences/preferencesClient.ts 发起写入与同步；');
  console.error('3. 废弃偏好 Key 修复指引：');
  console.error('   - 废弃 Key 清单：crish_theme, crish_theme_skin, crish-layout-v1, conex_pi_settings, crish_settings 等；');
  console.error('   - 处置：物理清除对废弃 Key 的读写代码（DELETE-SYMBOL），迁移至规范的 preferencesClient 偏好结构；');
  console.error('4. 铁律：本门禁为刚性守门，严禁通过注释、绕过或弱化门禁来掩盖架构违规！');
  console.error('======================================================');

  if (REPORT_ONLY) {
    console.log('\n[check-preferences-ssot] INFO: 当前处于 --report 模式，已输出完整违规清单。');
    process.exit(0);
  }

  process.exit(1);
}

console.log('[check-preferences-ssot] OK: 偏好 SSOT 门禁通过（零组件直写、零非客户端Store直写、零废弃Key操作）');

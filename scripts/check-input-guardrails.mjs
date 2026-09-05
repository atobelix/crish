#!/usr/bin/env node
/**
 * scripts/check-input-guardrails.mjs
 * 全仓输入框四态体系防倒退与焦点/激活态刚性守门脚本 (Input Four-Patterns & Focus Guardrail)
 *
 * 依据用户刚性裁决与 AGENTS.md §13 规范，全系统严格执行：
 * 1. 形态 ①【侧边栏无边框纯净型】：主侧栏会话搜索、设置侧栏分类搜索（常态背景透明，无边框无阴影）
 * 2. 形态 ②【主对话底栏胶囊型】：ChatComposer 消息输入底栏
 * 3. 形态 ③【标准卡片表单原子型】：基于 ui/Input 的标准输入框（细边框微圆角，鼠标焦点无阴影）
 * 4. 形态 ④【内联浮层/下拉菜单/筛选框（纯光标极简型）】：ModelBadgePickerMenu、SmartExpandablePanel、FilesCard、DiffCard 等
 *    （全态只有光标闪烁，其他全无变化；常态与激活态严禁任何非透明 border、深色焦点外框或阴影）
 *
 * 焦点与激活态刚性防御：
 * - 扫描并拦截输入框/文本域焦点态中混入大于 10% 文本纯黑（如 40%、60% 文本色高对比度焦点环，AGENTS.md §13 严格限制 <= 10%）
 * - 扫描并拦截大于 1.5px 的粗重焦点投影（如 0 0 0 3px 黑环）
 * - 强制形态 ④（搜索/筛选输入框）必须为无边框极简型，严禁出现非透明 border 或深色焦点外框
 * - 扫描并拦截按钮 active 激活态上的硬编码纯黑边框
 * - 输入框邻近圆角一致性与去极端化扫描（杜绝 9999px 药丸、0px 生硬直角、奇葩野值圆角）
 * - 杜绝按钮与输入框果冻弹性缩放 (Jelly bounce)
 *
 * 违规即 Exit 1 阻断 CI 与本地提交。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
export const DESKTOP_SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

export let errors = [];

export function resetErrors() {
  errors = [];
}

export function checkFile(filePath, desc, checks, targetErrors = errors) {
  if (!fs.existsSync(filePath)) {
    targetErrors.push(`[文件缺失] ${desc}: 找不到路径 ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const check of checks) {
    if (check.regex && !check.regex.test(content)) {
      targetErrors.push(`[形态校验失败] ${desc}: ${check.message}`);
    } else if (check.includes && !content.includes(check.includes)) {
      targetErrors.push(`[形态校验失败] ${desc}: ${check.message}`);
    } else if (check.notIncludes && content.includes(check.notIncludes)) {
      targetErrors.push(`[倒退拦截] ${desc}: ${check.message}`);
    }
  }
}

/**
 * 提取成对括号函数调用（支持多层嵌套，如 color-mix 中嵌套 var(...)）
 */
export function extractFunctionCalls(str, fnName) {
  const results = [];
  const lower = str.toLowerCase();
  let searchIdx = 0;
  while (true) {
    const fnIdx = lower.indexOf(fnName.toLowerCase() + '(', searchIdx);
    if (fnIdx === -1) break;
    let depth = 1;
    let i = fnIdx + fnName.length + 1;
    while (i < str.length && depth > 0) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') depth--;
      i++;
    }
    results.push({
      full: str.slice(fnIdx, i),
      args: str.slice(fnIdx + fnName.length + 1, i - 1),
      start: fnIdx,
      end: i,
    });
    searchIdx = i;
  }
  return results;
}

/**
 * 递归解析 CSS 代码块，剔除注释，并穿透 @media/@supports/@container 提取选择器与规则体
 */
export function extractCssRules(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];

  function parseBlock(blockText, parentAtRule = '') {
    let i = 0;
    while (i < blockText.length) {
      const openBrace = blockText.indexOf('{', i);
      if (openBrace === -1) break;

      const rawHeader = blockText.slice(i, openBrace).trim();
      let depth = 1;
      let j = openBrace + 1;
      while (j < blockText.length && depth > 0) {
        if (blockText[j] === '{') depth++;
        else if (blockText[j] === '}') depth--;
        j++;
      }
      const body = blockText.slice(openBrace + 1, j - 1).trim();

      if (/^@(?:media|supports|container)\b/i.test(rawHeader)) {
        parseBlock(body, rawHeader);
      } else if (!/^@/i.test(rawHeader) && !/^(?:\d+%\s*|from\s*|to\s*)/.test(rawHeader)) {
        if (rawHeader.length > 0) {
          rules.push({
            selector: rawHeader,
            body: body,
            atRule: parentAtRule,
          });
        }
      }

      i = j;
    }
  }

  parseBlock(clean);
  return rules;
}

/**
 * 安全逗号拆分顶级选择器列表（不打碎 :is(...) 或属性选择器中的逗号）
 */
export function splitSelectors(selectorStr) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < selectorStr.length; i++) {
    const ch = selectorStr[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * 规则 1 分析器：扫描并拦截焦点态/激活态中混入大于 10% 文本纯黑（AGENTS.md §13）
 */
export function analyzeFocusDarkMix(body) {
  const violations = [];
  const colorMixes = extractFunctionCalls(body, 'color-mix');

  for (const cm of colorMixes) {
    if (/(?:var\(--text-primary\)|var\(--text-color\)|var\(--color-text\)|var\(--text-main\)|#000000|#000|#111111|#111|\bblack\b|rgb\(\s*0)/i.test(cm.full)) {
      const explicitPct = cm.full.match(/(?:var\(--text-primary\)|var\(--text-color\)|var\(--color-text\)|#000|black|rgb\(\s*0)[^,%]*\s+(\d+(?:\.\d+)?)%/i);
      if (explicitPct) {
        const pct = parseFloat(explicitPct[1]);
        if (pct > 10) {
          violations.push({ type: 'COLOR_MIX_EXCEEDS_10', percent: pct, snippet: cm.full });
        }
      } else {
        const otherPctMatch = cm.full.match(/var\(--border-color\)[^,%]*\s+(\d+(?:\.\d+)?)%/i);
        if (otherPctMatch) {
          const darkPct = 100 - parseFloat(otherPctMatch[1]);
          if (darkPct > 10) {
            violations.push({ type: 'COLOR_MIX_EXCEEDS_10', percent: darkPct, snippet: cm.full });
          }
        } else {
          violations.push({ type: 'COLOR_MIX_UNCONSTRAINED', percent: 50, snippet: cm.full });
        }
      }
    }
  }

  // 剔除合规的 color-mix 调用后再检查裸写深黑
  let remaining = body;
  for (let i = colorMixes.length - 1; i >= 0; i--) {
    remaining = remaining.slice(0, colorMixes[i].start) + remaining.slice(colorMixes[i].end);
  }

  const borderOutlineDecls = remaining.match(/(?:border(?:-color)?|outline(?:-color)?)\s*:\s*([^;]+);/gi) || [];
  const darkColorRegex = /(?:#000000|#000|#111111|#111|\bblack\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|rgba\(\s*0\s*,\s*0\s*,\s*0(?:,\s*(?:0\.[2-9]|\d{2,}|1))?\b|\bvar\(--text-primary\)|\bvar\(--text-color\)|\bvar\(--color-text\))/i;

  for (const decl of borderOutlineDecls) {
    if (darkColorRegex.test(decl)) {
      violations.push({ type: 'RAW_DARK_BORDER', snippet: decl.trim() });
    }
  }

  return violations;
}

/**
 * 规则 2 分析器：扫描并拦截大于 1.5px 的粗重焦点投影（如 0 0 0 3px 黑环）
 */
export function analyzeBoxShadowSpread(body) {
  const violations = [];
  const shadowMatches = body.match(/box-shadow\s*:\s*([^;]+);/gi) || [];
  for (const match of shadowMatches) {
    const val = match.replace(/^box-shadow\s*:\s*/i, '').replace(/;$/, '').trim();
    if (val === 'none' || val.includes('none !important')) continue;
    const pxMatches = val.match(/(\d+(?:\.\d+)?)\s*px/g) || [];
    for (const px of pxMatches) {
      const num = parseFloat(px);
      if (num > 1.5) {
        violations.push({ type: 'SHADOW_EXCEEDS_1_5PX', spread: num, snippet: val });
        break;
      }
    }
  }
  return violations;
}

/**
 * 规则 3 分析器：强制形态 ④（搜索/筛选输入框）必须为无边框极简型，严禁出现非透明 border 或深色焦点外框
 */
export function analyzeFormFourMinimalist(selector, body) {
  const violations = [];
  const isFocusOrHover = /(?::focus|:focus-visible|:focus-within|:hover|:active)\b/i.test(selector);

  // 1. 常态与全部状态：严禁非透明 border / border-color
  const borderMatches = body.match(/border\s*:\s*([^;]+);/gi) || [];
  for (const bm of borderMatches) {
    const bVal = bm.replace(/^border\s*:\s*/i, '').replace(/;$/, '').trim();
    if (!/^(?:none|0|0px|transparent)$/i.test(bVal) && !/transparent/i.test(bVal)) {
      violations.push({ type: 'FORM_FOUR_NON_TRANSPARENT_BORDER', snippet: bm });
    }
  }

  const borderColorMatches = body.match(/border-color\s*:\s*([^;]+);/gi) || [];
  for (const bcm of borderColorMatches) {
    const bcVal = bcm.replace(/^border-color\s*:\s*/i, '').replace(/;$/, '').trim();
    if (!/^(?:transparent|none)$/i.test(bcVal)) {
      violations.push({ type: 'FORM_FOUR_NON_TRANSPARENT_BORDER_COLOR', snippet: bcm });
    }
  }

  const outlineMatches = body.match(/outline\s*:\s*([^;]+);/gi) || [];
  for (const om of outlineMatches) {
    const oVal = om.replace(/^outline\s*:\s*/i, '').replace(/;$/, '').trim();
    if (!/^(?:none|0|transparent)$/i.test(oVal) && !/transparent/i.test(oVal)) {
      violations.push({ type: 'FORM_FOUR_VISIBLE_OUTLINE', snippet: om });
    }
  }

  // 2. 焦点/悬浮/激活态：严禁添加任何阴影投影或外框
  if (isFocusOrHover) {
    const shadowMatches = body.match(/box-shadow\s*:\s*([^;]+);/gi) || [];
    for (const sm of shadowMatches) {
      const sVal = sm.replace(/^box-shadow\s*:\s*/i, '').replace(/;$/, '').trim();
      if (sVal !== 'none' && !sVal.includes('none !important')) {
        violations.push({ type: 'FORM_FOUR_FOCUS_SHADOW', snippet: sm });
      }
    }
  }

  return violations;
}

/**
 * 规则 4 分析器：扫描并拦截按钮 active 激活态上的硬编码纯黑边框
 */
export function analyzeButtonActiveBorder(body) {
  const violations = [];
  const darkMixViolations = analyzeFocusDarkMix(body);
  if (darkMixViolations.length > 0) {
    violations.push(...darkMixViolations);
  }

  // 检查 box-shadow 是否包含纯黑边框投影
  const shadowMatches = body.match(/box-shadow\s*:\s*([^;]+);/gi) || [];
  const darkRingRegex = /(?:#000000|#000|#111111|#111|\bblack\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|\bvar\(--text-primary\))/i;
  for (const sm of shadowMatches) {
    if (darkRingRegex.test(sm)) {
      violations.push({ type: 'BUTTON_ACTIVE_BLACK_SHADOW_RING', snippet: sm.trim() });
    }
  }

  return violations;
}

export function runCheckFileSuite(targetErrors = errors) {
  // 1. 检查形态 ①：主侧栏会话搜索框 (SidebarNav.module.css)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/sidebar/SidebarNav.module.css'),
  '形态 ① 主侧栏搜索框 (SidebarNav.module.css)',
  [
    {
      regex: /\.navItem\[role=['"]search['"]\]\s*\{[^}]*background:\s*transparent/,
      message: '常态背景必须为 transparent，严禁给外层画底色框',
    },
    {
      regex: /\.navItem\[role=['"]search['"]\]\s*\{[^}]*border:\s*none/,
      message: '常态边框必须为 none，严禁给外层画边框',
    },
    {
      regex: /\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*border:\s*none/,
      message: '内芯 input 必须带 border: none',
    },
    {
      regex: /\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*box-shadow:\s*none/,
      message: '内芯 input 必须带 box-shadow: none，防止全局黑框污染',
    },
  ]
);

// 2. 检查形态 ①：设置侧边栏搜索框 (SettingsPanel.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/settings/SettingsPanel.module.css'),
  '形态 ① 设置侧栏搜索框 (SettingsPanel.module.css)',
  [
    {
      regex: /\.searchWrap\s*\{[^}]*background:\s*transparent/,
      message: '常态背景必须为 transparent，与主侧栏保持 100% 共享纯无边框形式',
    },
    {
      regex: /\.searchWrap\s*\{[^}]*border:\s*none/,
      message: '常态边框必须为 none',
    },
    {
      regex: /\.search[^{]*\{[^}]*border:\s*none/,
      message: '内芯 search 必须带 border: none',
    },
    {
      regex: /\.search[^{]*\{[^}]*box-shadow:\s*none/,
      message: '内芯 search 必须带 box-shadow: none',
    },
  ]
);

// 3. 检查形态 ④：下拉菜单与浮层搜索框 (ModelBadgePickerMenu.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/provider/ModelBadgePickerMenu.module.css'),
  '形态 ④ 模型选择菜单搜索框 (ModelBadgePickerMenu.module.css)',
  [
    {
      includes: '.searchInput:focus',
      message: '必须包含 .searchInput:focus 显式声明',
    },
    {
      includes: '.searchInput:focus-visible',
      message: '必须包含 .searchInput:focus-visible 显式声明',
    },
    {
      regex: /\.searchInput[^{]*\{[^}]*border:\s*none/,
      message: '必须保持全态 border: none，只有光标闪烁，其他全无变化',
    },
    {
      regex: /\.searchInput[^{]*\{[^}]*box-shadow:\s*none/,
      message: '必须保持全态 box-shadow: none，杜绝生硬黑框',
    },
    {
      regex: /\.searchInput[^{]*\{[^}]*outline:\s*none/,
      message: '必须保持全态 outline: none',
    },
  ]
);

// 4. 检查形态 ④：字体选择浮层搜索框 (FontSelectField.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/settings/FontSelectField.module.css'),
  '形态 ④ 字体选择浮层搜索框 (FontSelectField.module.css)',
  [
    {
      regex: /\.searchInput[^{]*\{[^}]*border:\s*none/,
      message: '必须保持全态 border: none',
    },
    {
      regex: /\.searchInput[^{]*\{[^}]*box-shadow:\s*none/,
      message: '必须保持全态 box-shadow: none',
    },
  ]
);

// 5. 检查全局焦点样式防御 (styles/focus-visible.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'styles/focus-visible.css'),
  '全局焦点防御门禁 (focus-visible.css)',
  [
    {
      regex: /:is\([^)]*role=['"]search['"][^)]*role=['"]menu['"][^)]*role=['"]listbox['"][^)]*\)/,
      message: '必须包含对 role=search, role=menu, role=listbox 的全局排除拦截',
    },
    {
      includes: 'box-shadow: none !important;',
      message: '必须全局剔除内嵌搜索输入框的 box-shadow 污染',
    },
    {
      regex: /(?:\.searchInput|\[class\*=['"]searchInput['"]\]):is\(:focus,\s*:focus-visible\)/,
      message: '必须显式阻断全局样式对 .searchInput 的阴影侵蚀',
    },
    {
      notIncludes: '0 0 0 3px',
      message: '严禁声明 3px 粗重焦点投影环，上限必须严格保持 1.5px (AGENTS.md §13)',
    },
    {
      notIncludes: 'var(--text-primary) 60%',
      message: '严禁混入 60% 文本深黑，上限必须严格保持 <= 10% (AGENTS.md §13)',
    },
  ]
);

// 6. 检查形态 ③：标准原子 Input (components/ui/Input/Input.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/ui/Input/Input.module.css'),
  '形态 ③ 标准原子组件 Input (Input.module.css)',
  [
    {
      includes: 'border: 1px solid var(--border-subtle);',
      message: '必须使用 var(--border-subtle) 细边框，严禁硬编码',
    },
    {
      includes: 'border-radius: var(--radius-md, 6px);',
      message: '必须使用标准圆角',
    },
    {
      regex: /\.input:focus[^{]*\{[^}]*box-shadow:\s*none;/,
      message: '鼠标焦点态必须维持 box-shadow: none，遵守 AGENTS.md §13 软灰规范',
    },
  ]
);

// 7. 检查形态 ③：原子多行文本 Textarea (components/ui/Input/Textarea.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/ui/Input/Textarea.module.css'),
  '形态 ③ 原子组件 Textarea (Textarea.module.css)',
  [
    {
      includes: 'border: 1px solid var(--border-subtle);',
      message: '必须使用 var(--border-subtle) 细边框',
    },
    {
      includes: 'border-radius: var(--radius-md, 6px);',
      message: '必须使用标准圆角',
    },
    {
      regex: /\.nativeTextarea:focus[^{]*\{[^}]*box-shadow:\s*none;/,
      message: '鼠标焦点态必须维持 box-shadow: none',
    },
  ]
);

// 8. 检查形态 ④：Diff 搜索筛选框 (DiffCard.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/diff/DiffCard.module.css'),
  '形态 ④ Diff 搜索筛选框 (DiffCard.module.css)',
  [
    {
      regex: /\.searchInput[^{]*\{[^}]*border:\s*none/,
      message: 'Diff 搜索框必须保持形态 ④ border: none 极简形式',
    },
    {
      regex: /\.searchInput[^{]*\{[^}]*box-shadow:\s*none/,
      message: 'Diff 搜索框必须保持形态 ④ box-shadow: none，杜绝生硬黑框',
    },
    {
      notIncludes: '.searchInput:focus {\n  border-color:',
      message: 'Diff 搜索框聚焦态严禁出现非透明 border-color',
    },
  ]
);

// 9. 检查形态 ④：文件树轻量筛选框 (FilesCard.module.css)
checkFile(
  path.resolve(DESKTOP_SRC, 'components/files/FilesCard.module.css'),
  '形态 ④ 文件轻量筛选框 (FilesCard.module.css)',
  [
    {
      regex: /\.filesPathFilter[^{]*\{[^}]*border:\s*none/,
      message: '文件筛选框必须保持形态 ④ border: none 极简形式',
    },
    {
      regex: /\.filesPathFilter[^{]*\{[^}]*box-shadow:\s*none/,
      message: '文件筛选框必须保持形态 ④ box-shadow: none，杜绝生硬黑框',
    },
  ],
  targetErrors
);
}

// 10. 全仓 CSS 规则级静态深度扫描
// 涵盖：焦点纯黑混入拦截 (>10%)、粗重投影拦截 (>1.5px)、形态 ④ 极简约束、按钮激活纯黑边框、极端圆角拦截、果冻弹跳拦截
export function scanAllCssRules(dir, targetErrors = errors) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        scanAllCssRules(fullPath, targetErrors);
      }
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');

      // shell-reset.css 为底层样式重置层
      if (relPath.includes('shell-reset.css')) {
        continue;
      }

      // AST 级提取全部 CSS 规则（穿透 @media / @supports，剔除注释）
      const rules = extractCssRules(content);

      for (const { selector: rawSelector, body: ruleBody } of rules) {
        const isInputTarget =
          /(?:^|[\s,>+~.])(?:input|textarea|searchbox|searchInput|searchField|inputField|nativeTextarea|cellInput|schedFieldInput|firstRunInput)\b/i.test(
            rawSelector
          ) &&
          !/type=['"](?:checkbox|radio|file|hidden)['"]/i.test(rawSelector);

        const isFocusState =
          /(?::focus|:focus-visible|:focus-within)\b/i.test(rawSelector);

        const isButtonTarget =
          /(?:^|[\s,>+~.])(?:button|\.btn|IconButton|headerBtn|footerAction|actionBtn|iconBtn)\b|\[role=['"]?button['"]?\]/i.test(
            rawSelector
          );

        const isActiveState =
          /(?::active|\.active|\.isActive)\b/i.test(rawSelector);

        const isFormFourSearch =
          /(?:searchInput|searchField|searchFilter|filterInput|pathFilter|fileFilter|diffSearch|filesSearch|searchbox|search-input|search-box)\b/i.test(
            rawSelector
          ) &&
          !relPath.includes('Input/Input.module.css') &&
          !/(?:Icon|ClearBtn|Wrapper|Container|Header)\b/i.test(rawSelector);

        // --- 规则 A：全仓输入框严禁纯黑 / 硬色边框 ---
        if (isInputTarget) {
          if (
            /border(?:-color)?\s*:\s*(?:#000000|#000|#111111|#111|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|\bblack\b)/i.test(
              ruleBody
            )
          ) {
            targetErrors.push(
              `[硬色边框拦截] 在 ${relPath} (${rawSelector}) 中发现纯黑输入框边框声明。必须使用 Design Token (如 var(--border-subtle) 或柔和浅灰)！`
            );
          }
        }

        // --- 规则 1：扫描并拦截输入框/文本域焦点态中混入大于 10% 文本纯黑 (AGENTS.md §13) ---
        if (
          (isInputTarget && isFocusState) ||
          (relPath.includes('focus-visible.css') && /--focus-visible-ring/i.test(ruleBody))
        ) {
          const darkMixViolations = analyzeFocusDarkMix(ruleBody);
          for (const v of darkMixViolations) {
            targetErrors.push(
              `[高对比度焦点环拦截] 在 ${relPath} (${rawSelector}) 中发现焦点态混入过高文本纯黑 (${v.percent ? v.percent + '%' : '硬编码深黑'}): "${v.snippet}". AGENTS.md §13 严格规定焦点/激活态加深混入文本色上限为 10%！`
            );
          }
        }

        // --- 规则 2：扫描并拦截大于 1.5px 的粗重焦点投影 (如 0 0 0 3px 黑环) ---
        if (
          (isInputTarget && isFocusState) ||
          (relPath.includes('focus-visible.css') && isInputTarget)
        ) {
          const shadowViolations = analyzeBoxShadowSpread(ruleBody);
          for (const v of shadowViolations) {
            targetErrors.push(
              `[粗重投影拦截] 在 ${relPath} (${rawSelector}) 中发现大于 1.5px 的粗重焦点投影 (${v.spread}px > 1.5px): "box-shadow: ${v.snippet}". 输入框与焦点态严禁大于 1.5px 的粗重外扩光晕与黑环 (AGENTS.md §13)！`
            );
          }
        }

        // --- 规则 3：强制形态 ④（搜索/筛选输入框）必须为无边框极简型，严禁出现非透明 border 或深色焦点外框 ---
        if (isFormFourSearch) {
          const formFourViolations = analyzeFormFourMinimalist(rawSelector, ruleBody);
          for (const v of formFourViolations) {
            if (v.type === 'FORM_FOUR_FOCUS_SHADOW') {
              targetErrors.push(
                `[形态 ④ 焦点外框拦截] 在 ${relPath} (${rawSelector}) 中发现焦点/悬浮态外框阴影: "${v.snippet}". 形态 ④ 必须保持“全态只有光标闪烁，其他全无变化”，严禁深色焦点外框！`
              );
            } else {
              targetErrors.push(
                `[形态 ④ 极简约束拦截] 在 ${relPath} (${rawSelector}) 中发现非极简边框/轮廓声明: "${v.snippet}". 形态 ④（搜索/筛选输入框）必须为无边框极简型，严禁出现非透明 border！`
              );
            }
          }
        }

        // --- 规则 4：扫描并拦截按钮 active 激活态上的硬编码纯黑边框 ---
        if (isButtonTarget && isActiveState) {
          const btnActiveViolations = analyzeButtonActiveBorder(ruleBody);
          for (const v of btnActiveViolations) {
            targetErrors.push(
              `[按钮激活纯黑边框拦截] 在 ${relPath} (${rawSelector}) 中发现按钮 active 态硬编码纯黑边框声明: "${v.snippet}". 按钮激活态严禁硬编码深黑框，须保持克制与 Design Token 一致 (AGENTS.md §13)！`
            );
          }
        }

        // --- 规则 C：输入框邻近圆角一致性与去极端化扫描 ---
        if (isInputTarget) {
          const radiusMatch = ruleBody.match(/border-radius\s*:\s*([^;]+);/i);
          if (radiusMatch) {
            const radiusVal = radiusMatch[1].trim();

            const isComposer =
              relPath.includes('chat-composer') ||
              relPath.includes('ChatComposer') ||
              rawSelector.includes('composer');
            if (
              !isComposer &&
              /(?:9999px|999px|50%)/.test(radiusVal) &&
              !rawSelector.includes('Pill') &&
              !rawSelector.includes('Badge')
            ) {
              targetErrors.push(
                `[极端圆角拦截] 在 ${relPath} (${rawSelector}) 中发现离谱胶囊圆角: "${radiusVal}"。普通表单/卡片输入框禁止声明 9999px/50% 药丸圆角！`
              );
            }

            if (
              /^(?:0|0px|1px)$/.test(radiusVal) &&
              !relPath.includes('reset') &&
              !ruleBody.includes('border: none')
            ) {
              targetErrors.push(
                `[生硬直角拦截] 在 ${relPath} (${rawSelector}) 中发现 0px/1px 生硬直角。必须接入 Design Tokens 微圆角！`
              );
            }

            const bizarrePixelMatch = radiusVal.match(/\b(17|19|23|27|29|31|37|41|43|47)\s*px\b/i);
            if (bizarrePixelMatch) {
              targetErrors.push(
                `[奇葩野值圆角拦截] 在 ${relPath} (${rawSelector}) 中发现非标奇葩圆角: "${bizarrePixelMatch[0]}"。圆角须接入 Design Tokens 阶梯 (--radius-xs: 2px, --radius-sm: 4px, --radius-md: 6px, --radius-lg: 8px, --radius-xl: 12px)！`
              );
            }
          }
        }

        // --- 规则 D：点击按钮与输入框果冻弹性缩放拦截 (Jelly Bounce Prevention) ---
        if (isButtonTarget || isInputTarget) {
          if (/:active\b/i.test(rawSelector)) {
            if (
              /(?:scale\s*:\s*0\.[89]|transform\s*:[^;]*scale\s*\(\s*0\.[89])/i.test(
                ruleBody
              )
            ) {
              targetErrors.push(
                `[果冻效果拦截] 在 ${relPath} (${rawSelector}) 中发现点击果冻弹性缩放声明: "${ruleBody.slice(0, 80)}"。用户已裁决彻底清除果冻弹跳效果！`
              );
            }
          }
        }
      }
    }
  }
}

// 11. 全仓 TSX 规范扫描：杜绝自造轮子绕过原子 Input
export function scanTsxForBespokeInputs(dir, targetErrors = errors) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        scanTsxForBespokeInputs(fullPath, targetErrors);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.tsx') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('Input.tsx') &&
      !entry.name.includes('Textarea.tsx') &&
      !entry.name.includes('ComboboxInput.tsx')
    ) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');

      // 匹配所有原生 <input 标签（精确大小写，不匹配 React 组件 <Input）
      const tagRegex = /<input(?=[\s/>])([^>]*)\/?>/g;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(content)) !== null) {
        const tagAttributes = tagMatch[1] || '';

        // 忽略非文本控件（文件上传、单选、复选框、隐藏域）
        if (
          /type=['"](?:checkbox|radio|file|hidden)['"]/i.test(tagAttributes)
        ) {
          continue;
        }

        // 计算行号
        const lineNo = content.slice(0, tagMatch.index).split('\n').length;
        const line = content.split('\n')[lineNo - 1];

        // 排除已确立的合法形态与底层实现：
        // 1. 形态 ① 主侧栏与设置侧栏搜索 (SidebarNav, SettingsSidebar)
        // 2. 形态 ② Composer 发送区 (ChatComposer)
        // 3. 形态 ④ 下拉菜单搜索 (ModelBadgePickerMenu, FontSelectField)
        // 4. 行内重命名/轻量过滤器/向导基元 (SessionInlineRename, SessionRow, ChatMsgFilterBar, FilesCard, FileBreadcrumb, FilePreview, DiffCard, SmartSearchHeader, SmartPanelHeader, ComboboxChips, FirstRunWizard, Wizard, WorkflowForm, FontSettingsSection, ImportListSection, SettingsTablist, SettingsSchemaRenderer, MirrorDriftStatusBar)
        const isAllowedForm =
          relPath.includes('SidebarNav') ||
          relPath.includes('SettingsSidebar') ||
          relPath.includes('ChatComposer') ||
          relPath.includes('ModelBadgePickerMenu') ||
          relPath.includes('FontSelectField') ||
          relPath.includes('SessionInlineRename') ||
          relPath.includes('SessionRow') ||
          relPath.includes('ChatMsgFilterBar') ||
          relPath.includes('FilesCard') ||
          relPath.includes('FileBreadcrumb') ||
          relPath.includes('FilePreview') ||
          relPath.includes('DiffCard') ||
          relPath.includes('SmartSearchHeader') ||
          relPath.includes('SmartPanelHeader') ||
          relPath.includes('ComboboxChips') ||
          relPath.includes('FirstRunWizard') ||
          relPath.includes('Wizard') ||
          relPath.includes('WorkflowForm') ||
          relPath.includes('FontSettingsSection') ||
          relPath.includes('ImportListSection') ||
          relPath.includes('SettingsTablist') ||
          relPath.includes('SettingsSchemaRenderer') ||
          relPath.includes('MirrorDriftStatusBar');

        if (!isAllowedForm) {
          targetErrors.push(
            `[TSX组件规范拦截] 在 ${relPath}:${lineNo} 发现原生 <input> 标签: "${line.trim()}". 表单配置项必须强制使用原子 <Input> 组件 (@/components/ui)，严禁私写原生 input 破坏形态 ③ 一致性！`
          );
        }
      }
    }
  }
}

export function runGuardrails() {
  errors = [];
  console.log('🔍 开始执行全仓输入框四态体系防倒退与焦点态刚性静态扫描...');
  runCheckFileSuite(errors);
  scanAllCssRules(DESKTOP_SRC, errors);
  scanTsxForBespokeInputs(path.resolve(DESKTOP_SRC, 'components'), errors);
  return errors;
}

const isDirectRun = process.argv[1] && (
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
);

if (isDirectRun) {
  const resultErrors = runGuardrails();
  if (resultErrors.length > 0) {
    console.error(`\n❌ 输入框防倒退门禁检测未通过！发现 ${resultErrors.length} 处违规：`);
    for (let i = 0; i < resultErrors.length; i++) {
      console.error(`  ${i + 1}. ${resultErrors[i]}`);
    }
    console.error('\n请按照【输入框四态体系与焦点/激活态规范】要求修正后重新执行！');
    process.exit(1);
  } else {
    console.log('✅ 全仓输入框四态体系防倒退检查 100% 通过！四大形态与焦点激活态守门严密完备，无样式倒退。');
    process.exit(0);
  }
}

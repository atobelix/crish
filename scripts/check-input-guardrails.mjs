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
 * 形态 ④ 选择器判定：覆盖所有行内编辑（.titleInput, .renameInput, *title*input* 等）与行内/卡片极简输入（.searchInput, .filesPathFilter 等）
 */
export function isFormFourSelector(selector) {
  if (/(?:Icon|ClearBtn|Wrapper|Container|Header|Btn|Button)\b/i.test(selector)) {
    return false;
  }
  return /(?:searchInput|searchField|searchFilter|pathFilter|fileFilter|diffSearch|filesSearch|searchbox|search-input|search-box|titleInput|renameInput|sessionRenameInput|inlineRename|inlineInput|[a-zA-Z0-9_-]*title[a-zA-Z0-9_-]*input|[a-zA-Z0-9_-]*rename[a-zA-Z0-9_-]*input)\b/i.test(
    selector
  );
}

/**
 * 承载形态 ④ 的容器选择器判定（如 .titleContainer, .renameContainer 等）
 */
export function isFormFourContainerSelector(selector) {
  return /(?:titleContainer|renameContainer|[a-zA-Z0-9_-]*(?:title|rename)[a-zA-Z0-9_-]*(?:Container|Wrap|Wrapper|Shell))\b/i.test(
    selector
  );
}

/**
 * 规则 3 分析器：正本清源形态 ④（纯光标极简型）
 * 强制断言具备 border: none (或 0)、background: transparent、box-shadow: none、outline: none；
 * 严禁任何非零、非透明的 border 声明（哪怕是浅灰 var(--border-color) 也直接拦截）。
 */
export function analyzeFormFourMinimalist(selector, body) {
  const violations = [];
  const isFocusOrHover = /(?::focus|:focus-visible|:focus-within|:hover|:active)\b/i.test(selector);
  const isPseudoElement = /(?:::placeholder|::selection|::-webkit)\b/i.test(selector);

  // 伪元素（如 ::placeholder, ::selection）不执行边框与背景断言
  if (isPseudoElement) {
    return violations;
  }

  // 1. 边框检查：全态严禁任何非零、非透明的 border / border-color 声明
  const borderMatches = body.match(/border\s*:\s*([^;]+);/gi) || [];
  for (const bm of borderMatches) {
    const bVal = bm.replace(/^border\s*:\s*/i, '').replace(/;$/, '').trim();
    const bClean = bVal.replace(/\s*!important/i, '').trim();
    if (!/^(?:none|0|0px|transparent)$/i.test(bClean) && !/transparent/i.test(bClean)) {
      violations.push({ type: 'FORM_FOUR_NON_TRANSPARENT_BORDER', snippet: bm.trim() });
    }
  }

  const borderColorMatches = body.match(/border-color\s*:\s*([^;]+);/gi) || [];
  for (const bcm of borderColorMatches) {
    const bcVal = bcm.replace(/^border-color\s*:\s*/i, '').replace(/;$/, '').trim();
    const bcClean = bcVal.replace(/\s*!important/i, '').trim();
    if (!/^(?:transparent|none|0)$/i.test(bcClean)) {
      violations.push({ type: 'FORM_FOUR_NON_TRANSPARENT_BORDER_COLOR', snippet: bcm.trim() });
    }
  }

  // 2. 轮廓检查：全态严禁出现可见轮廓
  const outlineMatches = body.match(/outline\s*:\s*([^;]+);/gi) || [];
  for (const om of outlineMatches) {
    const oVal = om.replace(/^outline\s*:\s*/i, '').replace(/;$/, '').trim();
    const oClean = oVal.replace(/\s*!important/i, '').trim();
    if (!/^(?:none|0|0px|transparent)$/i.test(oClean) && !/transparent/i.test(oClean)) {
      violations.push({ type: 'FORM_FOUR_VISIBLE_OUTLINE', snippet: om.trim() });
    }
  }

  // 3. 阴影检查：全态严禁添加任何非 none 阴影投影
  const shadowMatches = body.match(/box-shadow\s*:\s*([^;]+);/gi) || [];
  for (const sm of shadowMatches) {
    const sVal = sm.replace(/^box-shadow\s*:\s*/i, '').replace(/;$/, '').trim();
    if (sVal !== 'none' && !sVal.includes('none !important')) {
      violations.push({
        type: isFocusOrHover ? 'FORM_FOUR_FOCUS_SHADOW' : 'FORM_FOUR_VISIBLE_SHADOW',
        snippet: sm.trim(),
      });
    }
  }

  // 4. 背景检查：全态严禁声明非 transparent / none 背景
  const bgMatches = body.match(/(?:background|background-color)\s*:\s*([^;]+);/gi) || [];
  for (const bgm of bgMatches) {
    const bgVal = bgm.replace(/^(?:background|background-color)\s*:\s*/i, '').replace(/;$/, '').trim();
    const bgClean = bgVal.replace(/\s*!important/i, '').trim();
    if (!/^(?:transparent|none)$/i.test(bgClean)) {
      violations.push({ type: 'FORM_FOUR_NON_TRANSPARENT_BG', snippet: bgm.trim() });
    }
  }

  // 5. 常态（基础规则）强制四项刚性断言：border: none, background: transparent, box-shadow: none, outline: none
  if (!isFocusOrHover) {
    const hasBorderNone =
      /border\s*:\s*(?:none|0|0px|transparent)\b/i.test(body) ||
      /border-width\s*:\s*0/i.test(body) ||
      /border-style\s*:\s*none/i.test(body);
    if (!hasBorderNone) {
      violations.push({
        type: 'FORM_FOUR_MISSING_BORDER_NONE',
        snippet: '缺少强制声明 border: none (或 0)',
      });
    }

    const hasBgTransparent =
      /(?:background|background-color)\s*:\s*(?:transparent|none)\b/i.test(body);
    if (!hasBgTransparent) {
      violations.push({
        type: 'FORM_FOUR_MISSING_TRANSPARENT_BG',
        snippet: '缺少强制声明 background: transparent',
      });
    }

    const hasShadowNone = /box-shadow\s*:\s*none\b/i.test(body);
    if (!hasShadowNone) {
      violations.push({
        type: 'FORM_FOUR_MISSING_BOX_SHADOW_NONE',
        snippet: '缺少强制声明 box-shadow: none',
      });
    }

    const hasOutlineNone = /outline\s*:\s*(?:none|0|0px)\b/i.test(body);
    if (!hasOutlineNone) {
      violations.push({
        type: 'FORM_FOUR_MISSING_OUTLINE_NONE',
        snippet: '缺少强制声明 outline: none',
      });
    }
  }

  return violations;
}

/**
 * 容器联动防御分析器：对承载形态 ④ 的容器（如 .titleContainer, .renameContainer 等），严禁声明任何 border 与 box-shadow
 */
export function analyzeFormFourContainer(selector, body) {
  const violations = [];

  // 1. 严禁声明任何非透明/非零边框
  const borderMatches = body.match(/\bborder(?:-top|-bottom|-left|-right|-color)?\s*:\s*([^;]+);/gi) || [];
  for (const bm of borderMatches) {
    const bVal = bm.replace(/^border(?:-top|-bottom|-left|-right|-color)?\s*:\s*/i, '').replace(/;$/, '').trim();
    const bClean = bVal.replace(/\s*!important/i, '').trim();
    if (!/^(?:none|0|0px|transparent)$/i.test(bClean) && !/transparent/i.test(bClean)) {
      violations.push({ type: 'FORM_FOUR_CONTAINER_BORDER', snippet: bm.trim() });
    }
  }

  // 2. 严禁声明任何非 none 的 box-shadow
  const shadowMatches = body.match(/box-shadow\s*:\s*([^;]+);/gi) || [];
  for (const sm of shadowMatches) {
    const sVal = sm.replace(/^box-shadow\s*:\s*/i, '').replace(/;$/, '').trim();
    if (sVal !== 'none' && !sVal.includes('none !important')) {
      violations.push({ type: 'FORM_FOUR_CONTAINER_SHADOW', snippet: sm.trim() });
    }
  }

  return violations;
}

/**
 * 默认边框未重置拦截分析器：凡是命中 input 的非组件原子规则，如果规则体完全漏写 border 声明，发出刚性报错
 */
export function analyzeMissingBorderReset(selector, body) {
  const violations = [];
  const subSelectors = splitSelectors(selector);

  // 排除伪状态、伪类与伪元素
  if (
    subSelectors.every((s) =>
      /(?::focus|:focus-visible|:focus-within|:hover|:active|:disabled|::placeholder|::selection|::-webkit|\[disabled\])\b/i.test(
        s
      )
    )
  ) {
    return violations;
  }

  // 排除隐藏元素与无视觉渲染
  if (/display\s*:\s*none/i.test(body) || /opacity\s*:\s*0/i.test(body)) {
    return violations;
  }

  // 排除已确认为形态 ④ 容器的选择器
  if (subSelectors.some((s) => isFormFourContainerSelector(s))) {
    return violations;
  }

  // 检查是否作为末尾目标定位至具体 input/textarea
  const isTargetingInputElement = subSelectors.some((s) => {
    const parts = s.trim().split(/[\s>+~]+/);
    const lastPart = parts[parts.length - 1];
    return (
      isInputSelector(lastPart) &&
      !/(?:Icon|ClearBtn|Wrapper|Container|Header|Btn|Button)\b/i.test(lastPart) &&
      !/\[data-/i.test(lastPart)
    );
  });

  if (!isTargetingInputElement) {
    return violations;
  }

  // 排除后代字体/行高修饰规则（如 .containerDense .textarea）
  const isDescendantModifier = subSelectors.some(
    (s) =>
      /[\s>+~]/.test(s) &&
      !/(?:input|textarea)\[/i.test(s) &&
      !/:global\(input\)/i.test(s)
  );
  if (isDescendantModifier) {
    return violations;
  }

  // 检查是否具备视觉输入样式声明（高度、内边距、背景、字体、阴影、外观等）
  const definesInputStyling = /(?:height|padding|background|font|color|box-shadow|appearance)\s*:/i.test(
    body
  );
  const hasBorderDecl = /\bborder(?:-top|-bottom|-left|-right|-color|-width|-style)?\s*:/i.test(
    body
  );

  if (definesInputStyling && !hasBorderDecl) {
    violations.push({
      type: 'MISSING_BORDER_RESET',
      snippet: selector,
    });
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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
    ],
    targetErrors
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

  // 10. 检查形态 ④：笔记纸面行内标题输入框 (NotePaperPanel.module.css)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/note-paper/NotePaperPanel.module.css'),
    '形态 ④ 笔记纸面标题输入框 (NotePaperPanel.module.css)',
    [
      {
        regex: /\.titleInput[^{]*\{[^}]*background:\s*transparent/,
        message: '常态背景必须为 transparent，严禁底色框（无底色）',
      },
      {
        regex: /\.titleInput[^{]*\{[^}]*border:\s*none/,
        message: '必须保持形态 ④ border: none 极简形式（无边框）',
      },
      {
        regex: /\.titleInput[^{]*\{[^}]*outline:\s*none/,
        message: '必须保持形态 ④ outline: none 纯光标形式（纯光标）',
      },
      {
        regex: /\.titleInput[^{]*\{[^}]*box-shadow:\s*none/,
        message: '必须保持形态 ④ box-shadow: none，杜绝生硬黑框（无阴影）',
      },
      {
        includes: '.titleInput:focus',
        message: '必须包含 .titleInput:focus 显式声明',
      },
      {
        includes: '.titleInput:focus-visible',
        message: '必须包含 .titleInput:focus-visible 显式声明',
      },
      {
        regex: /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/,
        message: '聚焦态必须保持形态 ④ border: none 极简形式',
      },
      {
        regex: /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*outline:\s*none/,
        message: '聚焦态必须保持形态 ④ outline: none 纯光标形式',
      },
      {
        regex: /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/,
        message: '聚焦态必须保持形态 ④ box-shadow: none，杜绝生硬黑框',
      },
    ],
    targetErrors
  );

  // 11. 检查形态 ③ / 卡片提交输入框：Diff 提交输入框 (DiffCard.module.css)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/diff/DiffCard.module.css'),
    '形态 ③ Diff 提交输入框 (DiffCard.module.css)',
    [
      {
        regex: /\.commitInput[^{]*\{[^}]*box-shadow:\s*none/,
        message: '提交输入框常态必须维持 box-shadow: none，杜绝默认重阴影',
      },
      {
        regex: /\.commitInput[^{]*\{[^}]*outline:\s*none/,
        message: '提交输入框常态必须声明 outline: none',
      },
      {
        regex: /\.commitInput[^{]*\{[^}]*border-radius:\s*var\(--radius-(?:sm|md),\s*(?:4|6)px\)/,
        message: '提交输入框必须采用标准微圆角 (4px/6px)',
      },
      {
        regex: /\.commitInput[^{]*\{[^}]*border:\s*1px solid color-mix/,
        message: '提交输入框必须使用微透明 Design Token 细边框，严禁硬黑框',
      },
      {
        includes: '.commitInput:focus',
        message: '必须包含 .commitInput:focus 显式声明',
      },
      {
        includes: '.commitInput:focus-visible',
        message: '必须包含 .commitInput:focus-visible 显式声明',
      },
      {
        regex: /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*box-shadow:\s*none/,
        message: '提交输入框聚焦态必须维持 box-shadow: none，严禁粗重焦点投影',
      },
      {
        regex: /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*outline:\s*none/,
        message: '提交输入框聚焦态必须维持 outline: none',
      },
      {
        regex: /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*border-color:\s*color-mix\(.*?var\(--text-primary\)\s*(?:[1-9]|10)%\)/,
        message: '提交输入框聚焦态混入文本色上限必须严格保持 <= 10% (AGENTS.md §13)',
      },
    ],
    targetErrors
  );

  // 12. 检查 DiffCardGitActions 提交输入框组件绑定 (DiffCardGitActions.tsx)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/diff/DiffCardGitActions.tsx'),
    'DiffCardGitActions 提交输入框组件 (DiffCardGitActions.tsx)',
    [
      {
        includes: 'className={styles.commitInput}',
        message: '必须绑定 styles.commitInput 规范样式类',
      },
      {
        regex: /<textarea[^>]*className=\{styles\.commitInput\}/,
        message: '必须使用绑定了 styles.commitInput 的 textarea 提交文本域',
      },
    ],
    targetErrors
  );

  // 13. 检查笔记纸面标题行内组件绑定 (EditableTitle.tsx)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/note-paper/EditableTitle.tsx'),
    '笔记纸面标题行内组件 (EditableTitle.tsx)',
    [
      {
        includes: 'className={styles.titleInput}',
        message: '必须绑定 styles.titleInput 规范样式类',
      },
      {
        regex: /<input[^>]*className=\{styles\.titleInput\}/,
        message: '必须使用绑定了 styles.titleInput 的 input 文本控件',
      },
    ],
    targetErrors
  );
  // 14. 检查形态 ④：会话行内重命名输入框 (SessionInlineRename.module.css)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/chat-card/SessionInlineRename.module.css'),
    '形态 ④ 会话行内重命名输入框 (SessionInlineRename.module.css)',
    [
      {
        regex: /\.renameInput[^{]*\{[^}]*background:\s*transparent/,
        message: '常态背景必须为 transparent，保持纯光标形式',
      },
      {
        regex: /\.renameInput[^{]*\{[^}]*border:\s*none/,
        message: '必须保持形态 ④ border: none 极简形式（无边框）',
      },
      {
        regex: /\.renameInput[^{]*\{[^}]*outline:\s*none/,
        message: '必须保持形态 ④ outline: none 纯光标形式',
      },
      {
        regex: /\.renameInput[^{]*\{[^}]*box-shadow:\s*none/,
        message: '必须保持形态 ④ box-shadow: none，杜绝生硬黑框',
      },
      {
        regex: /\.renameInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/,
        message: '聚焦态必须保持形态 ④ border: none 极简形式',
      },
      {
        regex: /\.renameInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/,
        message: '聚焦态必须保持形态 ④ box-shadow: none',
      },
    ],
    targetErrors
  );

  // 15. 检查形态 ④：侧边栏会话行内重命名输入框 (SidebarSessionList.module.css)
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/sidebar/SidebarSessionList.module.css'),
    '形态 ④ 侧边栏行内重命名输入框 (SidebarSessionList.module.css)',
    [
      {
        regex: /\.sessionRenameInput[^{]*\{[^}]*background:\s*transparent/,
        message: '常态背景必须为 transparent',
      },
      {
        regex: /\.sessionRenameInput[^{]*\{[^}]*border:\s*none/,
        message: '必须保持形态 ④ border: none 极简形式',
      },
      {
        regex: /\.sessionRenameInput[^{]*\{[^}]*outline:\s*none/,
        message: '必须保持形态 ④ outline: none',
      },
      {
        regex: /\.sessionRenameInput[^{]*\{[^}]*box-shadow:\s*none/,
        message: '必须保持形态 ④ box-shadow: none',
      },
      {
        regex: /\.sessionRenameInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/,
        message: '聚焦态必须保持形态 ④ border: none',
      },
      {
        regex: /\.sessionRenameInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/,
        message: '聚焦态必须保持形态 ④ box-shadow: none',
      },
    ],
    targetErrors
  );

  // 16. 容器联动防御：形态 ④ 容器严禁声明边框与阴影
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/chat-card/SessionInlineRename.module.css'),
    '形态 ④ 容器联动防御 (SessionInlineRename.module.css)',
    [
      {
        notIncludes: '.renameContainer {\n  border:',
        message: '.renameContainer 容器严禁声明边框',
      },
      {
        notIncludes: '.renameContainer {\n  box-shadow:',
        message: '.renameContainer 容器严禁声明阴影',
      },
    ],
    targetErrors
  );
  checkFile(
    path.resolve(DESKTOP_SRC, 'components/note-paper/NotePaperPanel.module.css'),
    '形态 ④ 容器联动防御 (NotePaperPanel.module.css)',
    [
      {
        notIncludes: '.titleContainer {\n  border:',
        message: '.titleContainer 容器严禁声明边框',
      },
      {
        notIncludes: '.titleContainer {\n  box-shadow:',
        message: '.titleContainer 容器严禁声明阴影',
      },
    ],
    targetErrors
  );
}

/**
 * 精准输入框/文本域目标选择器断言函数
 * 确保对驼峰命名（.titleInput, .commitInput, .searchInput, .tagInput 等）、
 * 属性选择器（[type="text"], [type="search"] 等）以及任意组合选择器（div > input, .card .commitInput 等）无死角匹配。
 */
export function isInputSelector(selector) {
  // 排除单纯的非文本控件（如 checkbox, radio, file, hidden, submit, button, range, color, image），
  // 但允许在 :not(...) 中排他的声明（如 input:not([type="checkbox"])）
  const nonTextInputRegex = /(?<!:not\()\[type=['"]?(?:checkbox|radio|file|hidden|submit|button|range|color|image)['"]?\]/i;
  if (nonTextInputRegex.test(selector)) {
    return false;
  }

  // 容器反向隔离：纯容器/包装层类名严禁误判为 input
  if (/(?:Wrapper|Container|Shell|Row|Group|Header|Icon|ClearBtn|Btn|Button)\b(?![a-zA-Z0-9_-])/i.test(selector)) {
    // 除非包含后代 input/textarea（如 .inputWrapper input, .searchContainer > textarea）
    if (!/[\s>+~](?:input|textarea)\b(?![a-zA-Z0-9_-])/i.test(selector)) {
      return false;
    }
  }

  // 1. 原生标签：input, textarea
  if (/(?:^|[\s,>+~(:(\[])(?:input|textarea)\b(?![a-zA-Z0-9_-])/i.test(selector)) {
    return true;
  }

  // 2. 驼峰/后缀/前缀类名与 ID：.titleInput, #searchbox, .renameInput, .inputField, .inputSearch, .searchField 等
  if (
    /(?:\.[a-zA-Z0-9_-]*(?:input|textarea|searchbox)|#[a-zA-Z0-9_-]*(?:input|textarea|searchbox)|\[class\*?=['"][a-zA-Z0-9_-]*(?:input|textarea|searchbox))\b(?![a-zA-Z0-9_-])/i.test(
      selector
    )
  ) {
    return true;
  }
  if (/(?:\.input[a-zA-Z0-9_-]*|#input[a-zA-Z0-9_-]*|\.searchField|#searchField)\b(?![a-zA-Z0-9_-])/i.test(selector)) {
    return true;
  }

  // 3. 属性选择器：[type="text"], [type="search"] 等以及 [role="searchbox"]
  if (/[type=['"]?(?:text|search|password|email|url|number|tel)['"]?\]/i.test(selector)) {
    return true;
  }
  if (/[role=['"]?searchbox['"]?\]/i.test(selector)) {
    return true;
  }

  return false;
}

// 14. 全仓 CSS 规则级静态深度扫描
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
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');

      // shell-reset.css 为底层样式重置层
      if (relPath.includes('shell-reset.css')) {
        continue;
      }

      // AST 级提取全部 CSS 规则（穿透 @media / @supports，剔除注释）
      const rules = extractCssRules(content);

      for (const { selector: rawSelector, body: ruleBody } of rules) {
        // 使用 splitSelectors 对可能由逗号组合的复杂选择器列表拆分，以实现无死角精准判定
        const subSelectors = splitSelectors(rawSelector);

        // 是否包含输入框目标（支持驼峰命名如 .titleInput, .commitInput, .searchInput, .tagInput，属性选择器 [type="text"], [type="search"]，原生标签及任意组合选择器）
        const isInputTarget = subSelectors.some((s) => isInputSelector(s));

        // 是否处于焦点状态
        const isFocusState = subSelectors.some((s) =>
          /(?::focus|:focus-visible|:focus-within)\b/i.test(s)
        );

        // 是否包含按钮目标
        const isButtonTarget = subSelectors.some((s) =>
          /(?:^|[\s,>+~.])(?:button|\.btn|IconButton|headerBtn|footerAction|actionBtn|iconBtn)\b|\[role=['"]?button['"]?\]/i.test(
            s
          )
        );

        // 是否处于激活状态
        const isActiveState = subSelectors.some((s) =>
          /(?::active|\.active|\.isActive)\b/i.test(s)
        );

        // 是否属于形态 ④ 容器
        const isFormFourContainer = subSelectors.some((s) =>
          isFormFourContainerSelector(s)
        );
        if (isFormFourContainer) {
          const containerViolations = analyzeFormFourContainer(
            rawSelector,
            ruleBody
          );
          for (const v of containerViolations) {
            targetErrors.push(
              `[形态 ④ 容器联动拦截] 在 ${relPath} (${rawSelector}) 中发现承载形态 ④ 的容器声明了边框或阴影: "${v.snippet}". 形态 ④ 容器严禁声明 border 与 box-shadow！`
            );
          }
        }

        // 是否属于形态 ④ 搜索/筛选/纯光标输入框与行内编辑
        const isFormFourSearch =
          subSelectors.some((s) => isFormFourSelector(s)) &&
          !relPath.includes('Input/Input.module.css') &&
          !relPath.includes('Input/Textarea.module.css') &&
          !relPath.includes('SettingsUI.module.css');

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
          // NotePaperPanel 的 :global(input):focus-visible 走独立的 05-C 纸面软环规范（--np-focus-edge 6%），由 notePaperFocusRing.contract.test.ts 刚性锁定
          if (!(relPath.includes('NotePaperPanel.module.css') && rawSelector.includes(':global(input)'))) {
            const shadowViolations = analyzeBoxShadowSpread(ruleBody);
            for (const v of shadowViolations) {
              targetErrors.push(
                `[粗重投影拦截] 在 ${relPath} (${rawSelector}) 中发现大于 1.5px 的粗重焦点投影 (${v.spread}px > 1.5px): "box-shadow: ${v.snippet}". 输入框与焦点态严禁大于 1.5px 的粗重外扩光晕与黑环 (AGENTS.md §13)！`
              );
            }
          }
        }

        // --- 规则 3：强制形态 ④（搜索/筛选/行内重命名输入框）必须为无边框极简型，严禁出现非透明 border 或深色焦点外框 ---
        if (isFormFourSearch) {
          const formFourViolations = analyzeFormFourMinimalist(rawSelector, ruleBody);
          for (const v of formFourViolations) {
            if (v.type === 'FORM_FOUR_FOCUS_SHADOW') {
              targetErrors.push(
                `[形态 ④ 焦点外框拦截] 在 ${relPath} (${rawSelector}) 中发现焦点/悬浮态外框阴影: "${v.snippet}". 形态 ④ 必须保持“全态只有光标闪烁，其他全无变化”，严禁深色焦点外框！`
              );
            } else if (v.type === 'FORM_FOUR_NON_TRANSPARENT_BG') {
              targetErrors.push(
                `[形态 ④ 背景拦截] 在 ${relPath} (${rawSelector}) 中发现非透明背景: "${v.snippet}". 形态 ④ 必须保持 background: transparent，严禁给外层画底色框！`
              );
            } else if (v.type.startsWith('FORM_FOUR_MISSING_')) {
              targetErrors.push(
                `[形态 ④ 缺失强制声明] 在 ${relPath} (${rawSelector}) 中未声明必需属性: "${v.snippet}". 形态 ④ 必须强制显式声明 border: none, background: transparent, box-shadow: none, outline: none！`
              );
            } else {
              targetErrors.push(
                `[形态 ④ 极简约束拦截] 在 ${relPath} (${rawSelector}) 中发现非极简边框/轮廓声明: "${v.snippet}". 形态 ④（搜索/筛选/行内重命名输入框）必须为无边框极简型，严禁出现非透明 border！`
              );
            }
          }
        }

        // --- 规则 E：输入框默认边框未重置拦截 (Default Border Not Reset) ---
        if (
          isInputTarget &&
          !isFormFourSearch &&
          !relPath.includes('Input/Input.module.css') &&
          !relPath.includes('Input/Textarea.module.css') &&
          !relPath.includes('SettingsUI.module.css')
        ) {
          const missingBorderViolations = analyzeMissingBorderReset(rawSelector, ruleBody);
          for (const v of missingBorderViolations) {
            targetErrors.push(
              `[默认边框未重置拦截] 在 ${relPath} (${rawSelector}) 中输入框规则定义了视觉外观样式但未重置/声明 border。必须显式声明 border: none 或规范 border 边框，防止原生 2px 凹陷重边框！`
            );
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
      if (!fs.existsSync(fullPath)) {
        continue;
      }
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
        // 4. 行内重命名/轻量过滤器/向导基元 (SessionInlineRename, SessionRow, ChatMsgFilterBar, FilesCard, FileBreadcrumb, FilePreview, DiffCard, SmartSearchHeader, SmartPanelHeader, ComboboxChips, FirstRunWizard, Wizard, WorkflowForm, FontSettingsSection, ImportListSection, SettingsTablist, SettingsSchemaRenderer, MirrorDriftStatusBar, EditableTitle, NotePaperStrictHeader)
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
          relPath.includes('MirrorDriftStatusBar') ||
          relPath.includes('EditableTitle') ||
          relPath.includes('NotePaperStrictHeader') ||
          relPath.includes('NoteSidebarDrawer');

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

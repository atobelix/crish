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
 *
 * 用法：
 *   node scripts/check-input-guardrails.mjs
 *   node scripts/check-input-guardrails.mjs --guide <metric>   打印该指标的正确做法（未知/缺省 metric → 列出可用指标并 exit 1）
 *
 * 指标名 = 本脚本 FAIL 输出中的规则标签（[<标签>]），一一对应：
 *   form_contract_assertion[形态校验失败/倒退拦截] · guard_target_missing[文件缺失] ·
 *   hardcoded_dark_border[硬色边框拦截] · focus_dark_mix_over_10[高对比度焦点环拦截] ·
 *   focus_shadow_over_1_5px[粗重投影拦截] · form_four_focus_shadow[形态 ④ 焦点外框拦截] ·
 *   form_four_non_transparent_bg[形态 ④ 背景拦截] · form_four_missing_declaration[形态 ④ 缺失强制声明] ·
 *   form_four_minimalist_violation[形态 ④ 极简约束拦截] · form_four_container_leak[形态 ④ 容器联动拦截] ·
 *   missing_border_reset[默认边框未重置拦截] · button_active_dark_border[按钮激活纯黑边框拦截] ·
 *   extreme_pill_radius[极端圆角拦截] · hard_right_angle[生硬直角拦截] · bizarre_radius[奇葩野值圆角拦截] ·
 *   jelly_bounce[果冻效果拦截] · bespoke_native_input[TSX组件规范拦截] ·
 *   ghost_motion_token[幽灵 token 拦截] · layout_keyframes_animation[布局属性动画拦截]
 *
 * 注：--guide 仅在直接运行时生效（本模块被 check-token-ssot / check-layout-tokens 导入复用解析器）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
export const DESKTOP_SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');
/** packages 扫描根（T22：对齐 §19.5「全仓」扫描宣称） */
export const PACKAGES_ROOT = path.resolve(REPO_ROOT, 'packages');

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
 * 规则 2 分析器：扫描并拦截输入框焦点态的粗重环形/外扩投影（如 0 0 0 3px 黑环）
 * （audit-repair-202609 · T22 精确化）：
 * - 按投影语法解析每段阴影的长度语义：offsetX offsetY [blur] [spread]；
 * - 拦截条件 = spread > 1.5px（外扩环）**或** 同心光晕（offset 均为 0 且
 *   blur > 1.5px）；带偏移的柔和投影（如 0 2px 4px）不再误判为粗环；
 * - 纯黑/文本色投影的禁令不受影响（见 analyzeButtonActiveBorder / 规则 1）。
 */
export function analyzeBoxShadowSpread(body) {
  const violations = [];
  const shadowMatches = body.match(/box-shadow\s*:\s*[^;]+;/gi) || [];
  for (const match of shadowMatches) {
    const val = match.replace(/^box-shadow\s*:\s*/i, '').replace(/;$/, '').trim();
    const valClean = val.replace(/\s*!important/i, '').trim();
    if (/^none$/i.test(valClean)) continue;

    // 顶层逗号拆分多段阴影（rgb()/color-mix() 内逗号不打碎），逐段解析
    for (const seg of splitSelectors(valClean)) {
      // 剥离函数组（rgba()/var()/color-mix() 等，避免内部数字混入长度序列）
      let cleaned = seg;
      let prevCleaned = '';
      while (cleaned !== prevCleaned) {
        prevCleaned = cleaned;
        cleaned = cleaned.replace(/[\w-]*\([^()]*\)/g, ' ');
      }
      // 长度序列（按出现顺序）：offsetX offsetY [blur] [spread]。
      // CSS 允许长度写为无单位 0（如 `0 0 0 3px`），故数值均按长度计。
      const lens = (cleaned.match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?/gi) || []).map(
        (v) => parseFloat(v)
      );
      if (lens.length < 2) continue; // 无有效长度语义（如 var(--ring)），跳过

      const spread = lens.length >= 4 ? lens[3] : 0;
      const blur = lens.length >= 3 ? lens[2] : 0;
      const offsetX = lens[0];
      const offsetY = lens[1];
      const isConcentricGlow = offsetX === 0 && offsetY === 0 && blur > 1.5;

      if (spread > 1.5 || isConcentricGlow) {
        violations.push({
          type: 'SHADOW_EXCEEDS_1_5PX',
          spread: Math.max(spread, isConcentricGlow ? blur : 0),
          snippet: val,
        });
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
        // 2026-09-11 放宽：裸兜底清退（T3）后消费点形如 var(--radius-md)，
        // 静态默认已由 tokens.css 提供；两种形态均视为「标准圆角」。
        regex: /border-radius:\s*var\(--radius-md(?:\s*,\s*6px)?\);/,
        message: '必须使用标准圆角（--radius-md；兜底可选）',
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
        // 2026-09-11 放宽：同上，兼容裸兜底清退后的 var(--radius-md) 形态。
        regex: /border-radius:\s*var\(--radius-md(?:\s*,\s*6px)?\);/,
        message: '必须使用标准圆角（--radius-md；兜底可选）',
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
        // 2026-10-11：圆角兜底值批量清退（theme review P2-5），兜底改为可选
        regex: /\.commitInput[^{]*\{[^}]*border-radius:\s*var\(--radius-(?:sm|md)(?:\s*,\s*(?:4|6)px)?\)/,
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
        regex: /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*border-color:\s*color-mix\(.*?var\(--text-primary\)\s*(?:[1-9]|10)%\s*\)/s,
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
        regex: /<(?:textarea|Textarea)[^>]*className=\{styles\.commitInput\}/,
        message: '必须使用绑定了 styles.commitInput 的 textarea/Textarea 提交文本域',
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
        regex: /<(?:input|Input)[^>]*className=\{styles\.titleInput\}/,
        message: '必须使用绑定了 styles.titleInput 的 input/Input 文本控件',
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

        // 是否包含按钮目标：任何词素含 btn / button 的类名、原生 button 标签、[role="button"]
        const isButtonTarget = subSelectors.some((s) =>
          /\w*(?:btn|button)\b|(?:^|[\s,>+~.])button\b|\[role=['"]?button['"]?\]/i.test(
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
                `[奇葩野值圆角拦截] 在 ${relPath} (${rawSelector}) 中发现非标奇葩圆角: "${bizarrePixelMatch[0]}"。圆角须接入 Design Tokens 5 档 (--radius-s: 4px, --radius-m: 8px, --radius-l: 12px, --radius-input: 20px, --radius-pill: 9999px；按钮例外 --radius-btn: 7px)！`
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

        // 忽略非文本控件（文件上传、单选、复选框、隐藏域、颜色选择、滑块）
        if (
          /type=['"](?:checkbox|radio|file|hidden|color|range)['"]/i.test(
            tagAttributes
          )
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
          relPath.includes('ColorPicker') ||
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

// --- 规则 E：binary-tree 标签条动效单一真理路径守卫 ---
// 1) 幽灵 token（--dur-fast / --ease-default）禁入——时长/缓动必须引用 tokens.css；
// 2) @keyframes 禁止动画布局属性——条带几何展开/收拢必须走 transition 单轨
//   （@starting-style 入场 / [data-leaving] 离场），keyframes 仅允许 transform/opacity/色彩。
export function scanStripMotionGuards(targetErrors = errors) {
  const stripDir = path.join(DESKTOP_SRC, 'components', 'binary-tree');
  if (!fs.existsSync(stripDir)) return;
  const entries = fs.readdirSync(stripDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue;
    const fullPath = path.join(stripDir, entry.name);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');

    if (/--dur-fast|--ease-default/.test(content)) {
      targetErrors.push(
        `[幽灵 token 拦截] 在 ${relPath} 发现不存在的动效 token（--dur-fast / --ease-default）。时长与缓动必须引用 tokens.css 的 --duration-* / --ease-* 阶梯！`
      );
    }

    const keyframesMatches = content.matchAll(
      /@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g
    );
    const layoutPropPattern =
      /(?:^|[;{\s])(?:width|max-width|min-width|height|flex-basis|flex|padding(?:-(?:left|right|top|bottom))?\s*:|margin(?:-(?:left|right|top|bottom))?\s*:|top\s*:|left\s*:|right\s*:|bottom\s*:|border-width\s*:)/;
    for (const kf of keyframesMatches) {
      if (layoutPropPattern.test(kf[2])) {
        targetErrors.push(
          `[布局属性动画拦截] 在 ${relPath} 的 @keyframes ${kf[1]} 中发现布局属性动画。条带几何展开/收拢必须走 transition 单轨（@starting-style 入场 / [data-leaving] 离场），keyframes 仅允许 transform/opacity/色彩！`
        );
      }
    }
  }
}

export function runGuardrails() {
  errors = [];
  console.log('🔍 开始执行全仓输入框四态体系防倒退与焦点态刚性静态扫描...');
  runCheckFileSuite(errors);
  scanAllCssRules(DESKTOP_SRC, errors);
  // audit-repair-202609 T22：扫描根对齐 AGENTS.md §19.5「全仓」宣称——
  // packages/ 的 CSS（block-paper chrome/paper-list 等）纳入同一分析器
  //（当前无输入框选择器、零违规，接入为防回潮覆盖面）。
  scanAllCssRules(PACKAGES_ROOT, errors);
  scanTsxForBespokeInputs(path.resolve(DESKTOP_SRC, 'components'), errors);
  scanStripMotionGuards(errors);
  return errors;
}

// ── 指引（--guide <metric>）─────────────────────────────────────────────────
// 输出契约（五元规约）：违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法。
// 指标名 = 本脚本 FAIL 输出中的规则标签（[<标签>]），一一对应。
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GUIDE_FLAG = process.argv.includes('--guide');
const GUIDE = argVal('--guide');

const GUIDE_TEXT = {
  form_contract_assertion: [
    '违反项：形态 ①②③④ 具名文件的刚性断言未成立（FAIL 标签 [形态校验失败] / [倒退拦截]）。',
    '当前值：runCheckFileSuite 中某条断言不成立（FAIL 行已给出「描述 + 断言」）；阈值：全部断言 100% 成立。',
    '正确做法：按 FAIL 行给出的描述把声明补回对应类的规则体，禁止删断言绕过：',
    '  形态 ①：.navItem[role="search"] { background: transparent; border: none; }',
    '          .navItem input[type="search"] { border: none; box-shadow: none; }',
    '  形态 ③：border: 1px solid var(--border-subtle); border-radius: var(--radius-md);  且 :focus { box-shadow: none; }',
    '  形态 ④：border: none; outline: none; box-shadow: none; background: transparent;',
    '权威出处：AGENTS.md §19（输入框四态体系与全生命周期防倒退铁律）；守护单测 src/components/ui/Input/input-three-patterns-guard.test.ts。',
    '注意：断言为精确串/正则匹配；等价的其它写法（如圆角写成 var(--radius-md, 6px)）已按 D29 放宽为两种形态皆可，其余仍会 FAIL。',
  ],
  guard_target_missing: [
    '违反项：断言目标文件不存在（FAIL 标签 [文件缺失]）。',
    '当前值：文件缺失；阈值：文件必须存在。',
    '正确做法：从版本库恢复该文件（git checkout -- <FAIL 行给出的路径>）。',
    '若确属合法搬迁：必须同步修正 runCheckFileSuite 中的路径与对应断言 —— 禁止以「文件不在」为由删除断言。',
  ],
  hardcoded_dark_border: [
    '违反项：输入框 border 声明里出现纯黑/硬色（FAIL 标签 [硬色边框拦截]，规则 A）。',
    '当前值：border/border-color 命中 #000000 / #000 / #111111 / #111 / rgb(0,0,0) / black；阈值：0 命中。',
    '正确做法：改用 Design Token 的柔和边框：',
    '  错误：border: 1px solid #000;',
    '  正确：border: 1px solid var(--border-subtle);   // 或 color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)',
    '权威出处：AGENTS.md §13（禁止粗、深、实心黑边）；AGENTS.md §19 形态 ③（细边框 var(--border-subtle)）。',
  ],
  focus_dark_mix_over_10: [
    '违反项：焦点/激活态混入过高文本纯黑（FAIL 标签 [高对比度焦点环拦截]，规则 1）。',
    '当前值：color-mix 中 var(--text-primary) 等文本色的混入百分比（无显式百分比时按 50% 计）；阈值：≤ 10%（AGENTS.md §13）。',
    '正确做法：把混入量压到 ≤ 10%，常规元素优先 3%~6%：',
    '  错误：border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);',
    '  正确：border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);',
    '禁止在 border/outline 声明里裸写 var(--text-primary) / #000 / black（RAW_DARK_BORDER 分支同样拦截）。',
    '权威出处：AGENTS.md §13「焦点对比度上限约 10%」。',
  ],
  focus_shadow_over_1_5px: [
    '违反项：输入框焦点态出现粗重外扩投影或同心光晕（FAIL 标签 [粗重投影拦截]，规则 2）。',
    '当前值：box-shadow 的 spread > 1.5px，或 offset 均为 0 且 blur > 1.5px（同心光晕）；阈值：≤ 1.5px。',
    '正确做法：焦点态不加重投影；确需柔和提示时用带偏移的小半径阴影，或直接 box-shadow: none：',
    '  错误：box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.2);',
    '  正确：box-shadow: none;   或   box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);',
    '例外：NotePaperPanel 的 :global(input):focus-visible 走 05-C 纸面软环规范（--np-focus-edge 6%），由 notePaperFocusRing.contract.test.ts 锁定。',
    '权威出处：AGENTS.md §13（默认不要重阴影）；AGENTS.md §19 形态 ④（全态只有光标闪烁）。',
  ],
  form_four_focus_shadow: [
    '违反项：形态 ④ 输入框在 :focus / :hover 态声明了外框阴影（FAIL 标签 [形态 ④ 焦点外框拦截]）。',
    '当前值：焦点/悬浮规则体内 box-shadow ≠ none；阈值：全态 box-shadow: none。',
    '正确做法：删除该阴影声明，显式写回 none，让焦点只由光标闪烁提示：',
    '  .searchInput:focus, .searchInput:focus-visible { border: none; outline: none; box-shadow: none; background: transparent; }',
    '权威出处：AGENTS.md §19 形态 ④「全态只有光标闪烁，其他什么变化也没有」。',
  ],
  form_four_non_transparent_bg: [
    '违反项：形态 ④ 输入框声明了非透明背景（FAIL 标签 [形态 ④ 背景拦截]）。',
    '当前值：background / background-color 不是 transparent / none；阈值：必须为 transparent。',
    '正确做法：去掉底色，让浮层背景透出：',
    '  错误：background: var(--bg-card);',
    '  正确：background: transparent;',
    '权威出处：AGENTS.md §19 形态 ④；AGENTS.md §19 形态 ①（常态无底色，直接平铺在侧栏）。',
  ],
  form_four_missing_declaration: [
    '违反项：形态 ④ 输入框常态规则体缺少强制四项声明（FAIL 标签 [形态 ④ 缺失强制声明]）。',
    '当前值：缺少 border: none / background: transparent / box-shadow: none / outline: none 中的一项或多项；阈值：四项必须显式齐全。',
    '正确做法：在常态基础规则（非 :focus/:hover）里一次补齐四项：',
    '  .searchInput { border: none; outline: none; box-shadow: none; background: transparent; }',
    '权威出处：AGENTS.md §19 形态 ④（强制 border/outline/box-shadow/background 四件套）。',
  ],
  form_four_minimalist_violation: [
    '违反项：形态 ④ 输入框出现非极简的边框/轮廓/阴影（FAIL 标签 [形态 ④ 极简约束拦截]）。',
    '当前值：border / border-color / outline / box-shadow 为非零非透明值（浅灰 var(--border-color) 也算违规）；阈值：全态 border:none + outline:none + box-shadow:none。',
    '正确做法：删除可见边框/轮廓/阴影，仅保留光标：',
    '  .searchInput { border: none; outline: none; box-shadow: none; background: transparent; }',
    '注意：伪元素（::placeholder / ::selection / ::-webkit-*）不参与该断言；容器类（Icon/ClearBtn/Wrapper/Container/Header/Btn）也不判定为形态 ④。',
    '权威出处：AGENTS.md §19 形态 ④。',
  ],
  form_four_container_leak: [
    '违反项：承载形态 ④ 的容器（.titleContainer / .renameContainer / *Title*Container 等）声明了边框或阴影（FAIL 标签 [形态 ④ 容器联动拦截]）。',
    '当前值：容器规则体内出现非零非透明 border / 非 none 的 box-shadow；阈值：容器严禁声明 border 与 box-shadow。',
    '正确做法：把边框/阴影从容器上删除（需要区分层级时用间距或背景差，不要画框）：',
    '  .renameContainer { /* 不要写 border / box-shadow */ }',
    '权威出处：AGENTS.md §19 形态 ④（浮层内绝不产生任何边框、高亮或阴影）。',
  ],
  missing_border_reset: [
    '违反项：输入框规则体定义了视觉外观却完全没声明 border（FAIL 标签 [默认边框未重置拦截]，规则 E）。',
    '当前值：规则体含 height/padding/background/font/color/box-shadow/appearance 但无任何 border* 声明；阈值：必须显式重置或声明 border。',
    '正确做法：显式写 border: none（形态 ①/④ 极简型）或规范细边框（形态 ③）：',
    '  形态 ④：.searchInput { border: none; }',
    '  形态 ③：.input { border: 1px solid var(--border-subtle); }',
    '不写 border 会继承浏览器原生 2px 凹陷重边框，因此本规则为硬拦截。',
    '权威出处：AGENTS.md §19 形态 ③/④。',
  ],
  button_active_dark_border: [
    '违反项：按钮 :active / .active 态出现硬编码纯黑边框或纯黑投影环（FAIL 标签 [按钮激活纯黑边框拦截]，规则 4）。',
    '当前值：border/border-color 或 box-shadow 命中 #000000 / #000 / #111111 / #111 / rgb(0,0,0) / black / var(--text-primary)；阈值：0 命中。',
    '正确做法：激活态用克制的 token 混色，且混入文本色 ≤ 10%：',
    '  错误：.btn:active { box-shadow: 0 0 0 2px var(--text-primary); }',
    '  正确：.btn:active { box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%); }',
    '权威出处：AGENTS.md §13（克制的激活边框：禁止粗、深、实心黑边）。',
  ],
  extreme_pill_radius: [
    '违反项：普通输入框/卡片声明了药丸级极端圆角（FAIL 标签 [极端圆角拦截]，规则 C）。',
    '当前值：border-radius 为 9999px / 999px / 50%；阈值：仅系统级浮动 Badge / Pill / 全局主底栏（ChatComposer）允许。',
    '正确做法：接入 Design Tokens 圆角阶梯，并与相邻容器保持视觉一致：',
    '  错误：border-radius: 9999px;',
    '  正确：border-radius: var(--radius-lg);   // 8px；侧栏搜索框与相邻侧栏条目一致',
    '权威出处：AGENTS.md §20「严禁离谱极端圆角」（4px / 6px / 8px / 12px / 16px 标尺）。',
  ],
  hard_right_angle: [
    '违反项：输入框声明 0px/1px 生硬直角（FAIL 标签 [生硬直角拦截]，规则 C）。',
    '当前值：border-radius 恰为 0 / 0px / 1px 且规则体不含 border: none（reset 层豁免）；阈值：必须接入微圆角 token。',
    '正确做法：改为就近的圆角阶梯值：',
    '  错误：border-radius: 0;',
    '  正确：border-radius: var(--radius-sm);   // 4px；小尺寸内嵌控件与相邻小元素一致',
    '若该控件确为无边框极简型（border: none），请显式写出 border: none，本规则会自动豁免。',
    '权威出处：AGENTS.md §20「严禁出现生硬刺眼的 0px/1px 方角」。',
  ],
  bizarre_radius: [
    '违反项：输入框声明脱离 Design Tokens 阶梯的奇葩圆角值（FAIL 标签 [奇葩野值圆角拦截]，规则 C）。',
    '当前值：border-radius 命中 17/19/23/27/29/31/37/41/43/47 px 等野值；阈值：仅允许 2/4/6/8/12/16px 阶梯。',
    '正确做法：替换为最近的阶梯 token：',
    '  错误：border-radius: 17px;',
    '  正确：border-radius: var(--radius-lg);   // 8px（就近归位，必要时同步调整相邻元素）',
    '阶梯定义：--radius-xs: 2px · --radius-sm: 4px · --radius-md: 6px · --radius-lg: 8px · --radius-xl: 12px。',
    '权威出处：AGENTS.md §20「严禁出现 17px、23px 等脱离 Design Tokens 阶梯的奇葩自由数字」。',
  ],
  jelly_bounce: [
    '违反项：按钮/输入框 :active 态声明果冻弹性缩放（FAIL 标签 [果冻效果拦截]，规则 D）。',
    '当前值：:active 规则体内命中 scale: 0.8x / 0.9x 或 transform: ... scale(0.8x|0.9x)；阈值：0 命中。',
    '正确做法：删除点击缩放，只保留颜色/背景的克制反馈：',
    '  错误：.btn:active { transform: scale(0.96); }',
    '  正确：.btn:active { background: var(--btn-active-bg); }',
    '权威出处：AGENTS.md §20 第 3 条（刚性阻断按钮果冻弹跳 :active scale(0.96)）。',
  ],
  bespoke_native_input: [
    '违反项：TSX 中私写原生 <input>（FAIL 标签 [TSX组件规范拦截]）。',
    '当前值：<input> 命中且所在文件不在形态白名单（SidebarNav / ChatComposer / ModelBadgePickerMenu / SessionInlineRename / EditableTitle / DiffCard …）；阈值：表单配置项必须 0 命中。',
    '正确做法：改用原子组件，禁止自造轮子：',
    '  错误：<input className="myInput" value={v} onChange={onChange} />',
    '  正确：import { Input } from "@/components/ui";  →  <Input value={v} onChange={onChange} />',
    '若该处确属已裁决的形态 ①②④，请把文件加入 scanTsxForBespokeInputs 的 isAllowedForm 白名单（须说明形态归属），而不是留在裸写状态。',
    '权威出处：AGENTS.md §19 形态 ③（必须强制使用原子 <Input> 组件）；AGENTS.md §20 第 3 条。',
  ],
  ghost_motion_token: [
    '违反项：binary-tree 组件 CSS 引用了不存在的动效 token（FAIL 标签 [幽灵 token 拦截]）。',
    '当前值：命中 --dur-fast / --ease-default；阈值：0 命中。',
    '正确做法：改用 tokens.css 的真实阶梯：',
    '  错误：transition: width 200ms --ease-default;',
    '  正确：transition: width var(--duration-fast) var(--ease-out);',
    '权威出处：apps/crish-desktop/src/components/binary-tree/ 单一真理路径守卫（scanStripMotionGuards）；token 阶梯见 src/styles/tokens.css。',
  ],
  layout_keyframes_animation: [
    '违反项：binary-tree 组件 CSS 的 @keyframes 里动画了布局属性（FAIL 标签 [布局属性动画拦截]）。',
    '当前值：@keyframes 体内命中 width / max-width / min-width / height / flex / flex-basis / padding* / margin* / top / left / right / bottom / border-width；阈值：0 命中。',
    '正确做法：条带几何展开/收拢走 transition 单轨（@starting-style 入场 / [data-leaving] 离场），keyframes 只允许 transform / opacity / 色彩：',
    '  错误：@keyframes expand { from { width: 0 } to { width: 120px } }',
    '  正确：.strip { transition: transform var(--duration-fast) var(--ease-out); }  /* 或 @starting-style { opacity: 0 } */',
    '权威出处：apps/crish-desktop/src/components/binary-tree/ 单一真理路径守卫（scanStripMotionGuards）。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-input-guardrails] 未知指标：${metric}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-input-guardrails] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && (
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
);


if (isDirectRun) {
  // 指引模式：仅直接运行时生效，导入方（check-token-ssot / check-layout-tokens）的 argv 不触发。
  if (GUIDE_FLAG) printGuide(GUIDE);
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

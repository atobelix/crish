#!/usr/bin/env node
/**
 * scripts/check-input-guardrails.mjs
 * 全仓输入框四态体系防倒退刚性守门脚本 (Input Four-Patterns Guardrail)
 *
 * 依据用户刚性裁决，全系统严格仅允许四种输入框形态，严禁出现第五种或样式倒退：
 * 1. 形态 ①【侧边栏无边框纯净型】：主侧栏会话搜索、设置侧栏分类搜索（常态无框无底色）
 * 2. 形态 ②【主对话底栏胶囊型】：ChatComposer 消息输入底栏
 * 3. 形态 ③【标准卡片表单原子型】：基于 ui/Input 的标准输入框（模型配置、价格配置、表单等）
 * 4. 形态 ④【内联浮层/下拉菜单搜索框（纯光标极简型）】：ModelBadgePickerMenu 等（全态只有光标闪烁，其他全无变化）
 *
 * 违规即 Exit 1 阻断 CI 与本地提交。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DESKTOP_SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

let errors = [];

function checkFile(filePath, desc, checks) {
  if (!fs.existsSync(filePath)) {
    errors.push(`[文件缺失] ${desc}: 找不到路径 ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const check of checks) {
    if (check.regex && !check.regex.test(content)) {
      errors.push(`[形态校验失败] ${desc}: ${check.message}`);
    } else if (check.includes && !content.includes(check.includes)) {
      errors.push(`[形态校验失败] ${desc}: ${check.message}`);
    } else if (check.notIncludes && content.includes(check.notIncludes)) {
      errors.push(`[倒退拦截] ${desc}: ${check.message}`);
    }
  }
}

console.log('🔍 开始执行全仓输入框四态体系防倒退静态扫描...');

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
      includes: '.searchInput:is(:focus, :focus-visible)',
      message: '必须显式阻断全局样式对 .searchInput 的阴影侵蚀',
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

// 8. 全仓 CSS 规则级静态深度扫描
// 涵盖：纯黑硬边框拦截、厚重阴影拦截、离谱极端圆角拦截、按钮果冻弹跳拦截、形态 ① & ④ 隔离拦截
function scanAllCssRules(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        scanAllCssRules(fullPath);
      }
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');

      // focus-visible.css 是全局键盘导航可访问性基线层，独立在第 5 节严格校验，不混入组件规则扫描
      if (relPath.includes('focus-visible.css') || relPath.includes('shell-reset.css')) {
        continue;
      }

      // 提取全部 CSS 规则（兼容单行与多行）
      const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
      let match;
      while ((match = ruleRegex.exec(content)) !== null) {
        const rawSelector = match[1].trim();
        const ruleBody = match[2].trim();

        // 过滤掉 @keyframes 内部百分比帧及媒体查询头
        if (/^(?:\d+%\s*|from\s*|to\s*|@)/.test(rawSelector)) {
          continue;
        }

        const isInputTarget =
          /(?:^|[\s,>+~.])(?:input|textarea|searchbox|searchInput|searchField|inputField)\b/i.test(
            rawSelector
          ) &&
          !/type=['"](?:checkbox|radio|file)['"]/i.test(rawSelector);

        const isButtonTarget =
          /(?:^|[\s,>+~.])(?:button|\.btn|IconButton|headerBtn|footerAction|actionBtn|iconBtn)\b/i.test(
            rawSelector
          );

        // --- 规则 A：全仓输入框严禁纯黑 / 硬色边框 ---
        if (isInputTarget) {
          if (
            /border(?:-color)?\s*:\s*(?:#000000|#000|#111111|#111|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|black)/i.test(
              ruleBody
            )
          ) {
            errors.push(
              `[硬色边框拦截] 在 ${relPath} (${rawSelector}) 中发现纯黑输入框边框声明。必须使用 Design Token (如 var(--border-subtle) 或柔和浅灰)！`
            );
          }
        }

        // --- 规则 B：全仓输入框严禁外发光重阴影 ---
        if (isInputTarget && !ruleBody.includes('box-shadow: none')) {
          const shadowMatch = ruleBody.match(/box-shadow\s*:\s*([^;]+);/i);
          if (shadowMatch) {
            const shadowVal = shadowMatch[1].trim();
            // 允许 1px hairline 微变量或 none，禁止多重厚重阴影 / 黑色投影环
            if (
              !shadowVal.includes('none') &&
              !shadowVal.includes('var(--hairline') &&
              !shadowVal.includes('var(--border-subtle') &&
              !shadowVal.includes('var(--focus-border-color') &&
              (shadowVal.includes('rgba(0') ||
                shadowVal.includes('#000') ||
                shadowVal.includes('#111') ||
                /\b[2-9]\d*px|\b[3-9]px/.test(shadowVal))
            ) {
              errors.push(
                `[厚重阴影拦截] 在 ${relPath} (${rawSelector}) 中发现厚重阴影: "box-shadow: ${shadowVal}"。输入框严禁重阴影，聚焦态必须保持克制！`
              );
            }
          }
        }

        // --- 规则 C：输入框邻近圆角一致性与去极端化扫描 ---
        // 用户裁决：“圆角没有要求，只要和旁边的元素的圆角一致即可，当然太离谱的肯定是不行。”
        if (isInputTarget) {
          const radiusMatch = ruleBody.match(/border-radius\s*:\s*([^;]+);/i);
          if (radiusMatch) {
            const radiusVal = radiusMatch[1].trim();

            // 1. 拦截普通表单输入框上的极端药丸圆角（形态 ② ChatComposer 外部容器放行）
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
              errors.push(
                `[极端圆角拦截] 在 ${relPath} (${rawSelector}) 中发现离谱胶囊圆角: "${radiusVal}"。普通表单/卡片输入框禁止声明 9999px/50% 药丸圆角！`
              );
            }

            // 2. 拦截生硬刺眼的 0px / 1px 直角（破坏邻近圆角一致性）
            if (
              /^(?:0|0px|1px)$/.test(radiusVal) &&
              !relPath.includes('reset') &&
              !ruleBody.includes('border: none')
            ) {
              errors.push(
                `[生硬直角拦截] 在 ${relPath} (${rawSelector}) 中发现 0px/1px 生硬直角。必须接入 Design Tokens 微圆角！`
              );
            }

            // 3. 拦截脱离设计系统阶梯的野值奇葩圆角（如 17px, 23px, 27px, 31px 等）
            const bizarrePixelMatch = radiusVal.match(/\b(17|19|23|27|29|31|37|41|43|47)\s*px\b/i);
            if (bizarrePixelMatch) {
              errors.push(
                `[奇葩野值圆角拦截] 在 ${relPath} (${rawSelector}) 中发现非标奇葩圆角: "${bizarrePixelMatch[0]}"。圆角须接入 Design Tokens 阶梯 (--radius-xs: 2px, --radius-sm: 4px, --radius-md: 6px, --radius-lg: 8px, --radius-xl: 12px)！`
              );
            }
          }
        }

        // --- 规则 D：点击按钮与输入框果冻弹性缩放拦截 (Jelly Bounce Prevention) ---
        // 用户裁决：“点击按钮的果冻效果也去掉”
        if (isButtonTarget || isInputTarget) {
          if (/:active\b/i.test(rawSelector)) {
            if (
              /(?:scale\s*:\s*0\.[89]|transform\s*:[^;]*scale\s*\(\s*0\.[89])/i.test(
                ruleBody
              )
            ) {
              errors.push(
                `[果冻效果拦截] 在 ${relPath} (${rawSelector}) 中发现点击果冻弹性缩放声明: "${ruleBody.slice(0, 80)}"。用户已裁决彻底清除果冻弹跳效果！`
              );
            }
          }
        }

        // --- 规则 E：形态 ①（侧栏搜索）与形态 ④（下拉/浮层搜索）污染扫描 ---
        const isFormOneOrFour =
          /(?:menu|listbox|picker|popover|sidebarNav|settingsSidebar)\b/i.test(
            rawSelector
          ) &&
          /(?:input|searchInput)\b/i.test(rawSelector) &&
          !rawSelector.includes('menuItem') &&
          !rawSelector.includes('comboboxInputWrapper');

        if (isFormOneOrFour) {
          // 形态 ① 和形态 ④ 在 hover 与 focus 态严禁添加边框或阴影
          if (/(?::focus|:hover|:focus-visible)/i.test(rawSelector)) {
            if (
              /border\s*:\s*(?!none\b)[^;]+;/i.test(ruleBody) ||
              /box-shadow\s*:\s*(?!none\b)[^;]+;/i.test(ruleBody)
            ) {
              errors.push(
                `[形态隔离拦截] 在 ${relPath} (${rawSelector}) 中发现对形态 ①/④ 搜索框声明了外边框或阴影。形态 ④ 必须保持“全态只有光标闪烁，其他全无变化”！`
              );
            }
          }
        }
      }
    }
  }
}

// 9. 全仓 TSX 规范扫描：杜绝自造轮子绕过原子 Input
function scanTsxForBespokeInputs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        scanTsxForBespokeInputs(fullPath);
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
          errors.push(
            `[TSX组件规范拦截] 在 ${relPath}:${lineNo} 发现原生 <input> 标签: "${line.trim()}". 表单配置项必须强制使用原子 <Input> 组件 (@/components/ui)，严禁私写原生 input 破坏形态 ③ 一致性！`
          );
        }
      }
    }
  }
}

scanAllCssRules(DESKTOP_SRC);
scanTsxForBespokeInputs(path.resolve(DESKTOP_SRC, 'components'));

// 输出扫描结果
if (errors.length > 0) {
  console.error(`\n❌ 输入框防倒退门禁检测未通过！发现 ${errors.length} 处违规：`);
  for (let i = 0; i < errors.length; i++) {
    console.error(`  ${i + 1}. ${errors[i]}`);
  }
  console.error('\n请按照【输入框四态体系与邻近圆角一致性】要求修正后重新执行！');
  process.exit(1);
} else {
  console.log('✅ 全仓输入框四态体系防倒退检查 100% 通过！四大形态守门严密完备，无样式倒退。');
  process.exit(0);
}

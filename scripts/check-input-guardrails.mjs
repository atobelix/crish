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

// 7. 全仓 CSS 纯黑硬边框扫描
function scanCssForPureBlackBorders(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        scanCssForPureBlackBorders(fullPath);
      }
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      // 检查是否有针对 input/textarea 的纯黑边框声明
      const inputRuleRegex = /(?:^|\})([^{}]*(?:input|textarea)[^{]*\{[^}]*\})/gi;
      let match;
      while ((match = inputRuleRegex.exec(content)) !== null) {
        const ruleBody = match[1];
        if (
          /border(?:-color)?\s*:\s*(?:#000000|#000|#111111|#111|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|black)/i.test(
            ruleBody
          )
        ) {
          const relPath = path.relative(REPO_ROOT, fullPath);
          errors.push(
            `[严重倒退拦截] 在 ${relPath} 中发现输入框纯黑硬边框声明: "${match[1].trim().slice(0, 100)}..."。必须使用 Design Token 柔和浅灰！`
          );
        }
      }
    }
  }
}

scanCssForPureBlackBorders(DESKTOP_SRC);

// 输出扫描结果
if (errors.length > 0) {
  console.error(`\n❌ 输入框防倒退门禁检测未通过！发现 ${errors.length} 处违规：`);
  for (let i = 0; i < errors.length; i++) {
    console.error(`  ${i + 1}. ${errors[i]}`);
  }
  console.error('\n请按照【输入框四态体系】要求修正后重新执行！');
  process.exit(1);
} else {
  console.log('✅ 全仓输入框四态体系防倒退检查 100% 通过！四大形态守门严密完备，无样式倒退。');
  process.exit(0);
}

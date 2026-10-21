#!/usr/bin/env node
/**
 * check-frontend-convergence.mjs — 前端重构终极收敛防回潮门禁引擎
 *
 * 职责（双源澄清）：G-01~G-12 合规门禁——对 12 大刚性检测规则做违规拦截，
 * 退出码 0/1 驱动 CI 阻断。与 check-convergence-metrics.mjs（收敛度量工具，
 * 产出基线数字供收敛度量表填 Δ）是两个不同职责的脚本，不合并。
 *
 * 权威输入依据：
 *   - docs/red-team-plans/00-红队前端系统级重构与终极收敛实施总方案.md
 *   - docs/red-team-plans/detailed-plans/02-原子设计系统与同心几何维度详案.md
 *   - docs/red-team-plans/detailed-plans/08-死代码物理清剿与CSS纯净化维度详案.md
 *   - docs/red-team-plans/audits/02-蓝队工程约束与防回潮门禁交叉审计报告.md
 *   - docs/red-team-plans/remediation/03-状态分域与死代码清剿最佳修复方案.md
 *
 * 覆盖 17 大不可违背的刚性检测规则（G-01 ~ G-17）：
 *   Rule 1 (G-01): 业务层零裸原生交互标签阻断 (No Naked Interactive Elements)
 *   Rule 2 (G-02): 浮层零 cloneElement 与零 stopPropagation (No Trigger Cloning & Event Hijack)
 *   Rule 3 (G-03): 零裸 ResizeObserver / 零 window.resize / 零 0px 回流 / 零 flushSync (No Raw RO & Thrashing)
 *   Rule 4 (G-04): 零非法 radius-full / 9999px 药丸圆角（仅保留 Switch/Avatar 白名单）(Zero-Pill Rule)
 *   Rule 5 (G-05): 7 级标准 Z-Index 标尺合规性检查（封顶 9000，拦截 100,000 等裸数字与废弃 Token）(7-Tier Scale)
 *   Rule 6 (G-06): 业务层 CSS Modules 零 !important 拦截 (Zero Business Important)
 *   Rule 7 (G-07): 入口 index.css 零废弃全局样式表 import (CSS Hygiene)
 *   Rule 8 (G-08): 叶子分发 TreeLeafPanel 零静态 switch(panelId) 与字符串前缀解析 (Microkernel ViewRegistry Invariant)
 *   Rule 9 (G-09): 状态层零伪门面别名同体 (useSessionStore = useLayoutStore) 与零 withAutoIndex 中间件 (Store Slicing)
 *   Rule 10 (G-10): 空态表面零状态渗透 (!onEmptySurface 刚性门闩) (Clean Slate Invariant)
 *   Rule 11 (G-11): 全仓零 onShowToast 属性透传 (No Toast Prop Drilling)
 *   Rule 12 (G-12): 严禁使用原生 HTML title 属性作为悬浮提示 (No Native Title Attribute)
 *   Rule 13 (G-13): 全仓零 GBK 乱码固化与编码损坏阻断 (Zero GBK Mojibake)
 *   Rule 14 (G-14): 业务层 CSS Modules 禁书 :global 幽灵提权选择器 (No Ghost Global Selectors)
 *   Rule 15 (G-15): 业务层 onKeyDown 裸判 Enter 提交阻断 (Enter Key IME Guard Invariant)
 *   Rule 16 (G-16): S7 文案单点（FINAL-PLAN §2.1）
 *   Rule 17 (G-17): 载体判定单定义（FINAL-PLAN §2 S-4）
 *
 * 用法：node scripts/check-frontend-convergence.mjs [--verbose]
 * 退出码：0 全部通过；1 存在违规项（CI / Git 阻断）
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-frontend-convergence.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：G-01~G-12 任一刚性规则命中（前端收敛防回潮：未接线标记回潮、波次命名、死代码回潮等）。",
    "文件:行号 / 当前值：FAIL 按规则分组逐条给出文件:行号；当前值 = 违规数。",
    "阈值：全部 0。",
    "正确做法：按 docs/red-team-plans/ 对应详案整改对应规则项；新豁免必须登记理由与期限，禁止加白名单了事。",
    "复核：node scripts/check-frontend-convergence.mjs  # 期望 OK",
  ];
  console.log('[check-frontend-convergence] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DESKTOP_SRC = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');
const UI_DIR = join(DESKTOP_SRC, 'components', 'ui');

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

function collectFiles(dir, extRe, excludeRe, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const posixPath = toPosix(full);
    if (excludeRe && excludeRe.test(posixPath)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, extRe, excludeRe, out);
    } else if (extRe.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

function report(ruleId, ruleCode, file, line, message) {
  const rel = toPosix(file).replace(toPosix(REPO_ROOT) + '/', '');
  const lineStr = line > 0 ? `:${line}` : '';
  violations.push(`[Rule ${ruleId} / ${ruleCode}] ${rel}${lineStr} -> ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则执行引擎
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rule 1 (G-01): 业务层零裸原生交互标签阻断
 * 使用 TypeScript AST 遍历排除注释、字符串、类型定义，精确定位业务层 JSX 裸标签与 createElement。
 */
function runRule1_NakedTags() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(tsx|jsx)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/|components\/ui\/)/
  );

  const FORBIDDEN_TAGS = new Set(['button', 'input', 'textarea', 'select']);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    function visit(node) {
      // 1. JSX 元素检查: <button>, <input>, <textarea>, <select>
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sf);
        if (FORBIDDEN_TAGS.has(tagName)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          report(
            1,
            'G-01',
            file,
            line + 1,
            `发现业务层裸原生交互标签 <${tagName}>，必须替换为 @/components/ui 标准原子组件！`
          );
        }
      }

      // 2. React.createElement('button', ...) 检查
      if (ts.isCallExpression(node)) {
        const exprText = node.expression.getText(sf);
        if (
          exprText === 'createElement' ||
          exprText === 'React.createElement' ||
          exprText.endsWith('.createElement')
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            if (FORBIDDEN_TAGS.has(firstArg.text)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              report(
                1,
                'G-01',
                file,
                line + 1,
                `发现业务层 createElement('${firstArg.text}') 裸交互标签，必须替换为 @/components/ui 原子组件！`
              );
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);
  }
}

/**
 * Rule 2 (G-02): 浮层零 cloneElement 与零 stopPropagation
 * 检查 Menu 及其全浮层基元组件（Menu, ConfirmDialog, SmartPanel, Dialog 等）禁止使用 cloneElement 劫持 Trigger，
 * 禁止使用 stopPropagation 破坏 LayerStack。
 */
function runRule2_MenuCloneElement() {
  const targetFiles = [
    ...collectFiles(join(UI_DIR, 'Menu'), /\.(tsx|ts)$/, /(\.test\.|\.spec\.)/),
    join(UI_DIR, 'ConfirmDialog', 'ConfirmDialog.tsx'),
    join(UI_DIR, 'SmartPanel', 'SmartPanel.tsx'),
    join(UI_DIR, 'Dialog', 'Dialog.tsx'),
  ].filter((f) => existsSync(f));

  for (const file of targetFiles) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (
        lineText.includes('cloneElement(') ||
        lineText.includes('React.cloneElement(')
      ) {
        report(
          2,
          'G-02',
          file,
          idx + 1,
          `浮层基元组件禁止使用 cloneElement 劫持触发器，必须使用 Anchor 或标准 Slot 模式！`
        );
      }
      if (lineText.includes('stopPropagation()')) {
        report(
          2,
          'G-02',
          file,
          idx + 1,
          `浮层基元组件禁止使用 stopPropagation 截断全局事件流，必须接入 LayerStack 统一调度！`
        );
      }
      if (/window\.addEventListener\s*\(\s*['"]pointerup['"]/.test(lineText)) {
        report(
          2,
          'G-02',
          file,
          idx + 1,
          `浮层基元组件禁止注册全局捕获 pointerup 监听器（WO-26 死锁残留）！`
        );
      }
    });
  }
}

/**
 * Rule 3 (G-03): 零裸 ResizeObserver / 零 window.resize / 零 0px 回流 / 零 flushSync
 * 业务组件必须接入 ResizeObserverManager 或 WindowResizeBridge，禁止强制回流与同步刷新。
 */
function runRule3_RawResizeAndThrashing() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(ts|tsx)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/|ResizeObserverManager\.ts|WindowResizeBridge\.ts)/
  );

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      if (/new\s+ResizeObserver\s*\(/.test(lineText)) {
        report(
          3,
          'G-03',
          file,
          idx + 1,
          `禁止在业务代码使用裸 new ResizeObserver()，必须接入 ResizeObserverManager 统一批处理！`
        );
      }
      if (/window\.addEventListener\s*\(\s*['"]resize['"]/.test(lineText)) {
        report(
          3,
          'G-03',
          file,
          idx + 1,
          `禁止在业务组件直接监听 window resize 事件，必须接入 WindowResizeBridge！`
        );
      }
      if (
        /\.style\.height\s*=\s*['"]0px['"]/.test(lineText) ||
        /\.style\.height\s*=\s*['"]0['"]/.test(lineText)
      ) {
        report(
          3,
          'G-03',
          file,
          idx + 1,
          `禁止写入 height='0px' 触发强制同步回流，必须使用 CSS field-sizing: content 或状态驱动！`
        );
      }
      if (/flushSync\s*\(/.test(lineText)) {
        report(
          3,
          'G-03',
          file,
          idx + 1,
          `禁止调用 flushSync() 强刷渲染阻塞主线程！`
        );
      }
    });
  }
}

/**
 * Rule 4 (G-04): 零非法 radius-full / 9999px 药丸圆角（仅保留 Switch/Avatar 白名单）
 * 桌面端严格遵循 12/8/6/4/2px 同心几何圆角标尺。
 */
function runRule4_ZeroPillRadius() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(css|module\.css)$/,
    /(reduced-motion\.css|src\/styles\/|\.test\.|\.spec\.)/
  );

  for (const file of files) {
    const posix = toPosix(file);
    // 合法白名单：Switch 轨道、Avatar 头像、PulseDot / StatusDot 加载指示器、Tooltip 胶囊提示（AGENTS.md §12 / RULE-07）
    const isSwitchTrack = posix.includes('Switch.module.css');
    const isAvatar = posix.includes('Avatar');
    const isPulseDot =
      posix.includes('PulseDot') ||
      posix.includes('StatusDot') ||
      posix.includes('StatusPulseDot');
    const isTooltip = posix.includes('Tooltip.module.css');

    if (isSwitchTrack || isAvatar || isPulseDot || isTooltip) continue;

    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      if (
        /var\(--radius-full\b/.test(lineText) ||
        /var\(--radius-pill\b/.test(lineText) ||
        /--radius-9999/.test(lineText) ||
        /var\([^)]*,\s*(?:9999px|999px|1000px)\)/.test(lineText)
      ) {
        report(
          4,
          'G-04',
          file,
          idx + 1,
          `禁止在非白名单元素上使用 var(--radius-full/pill/9999)，桌面端必须遵循同心几何标尺！`
        );
      }
      if (/border-radius:\s*(9999px|999px|1000px)/.test(lineText)) {
        report(
          4,
          'G-04',
          file,
          idx + 1,
          `禁止硬编码 border-radius: 9999px 药丸圆角，必须使用 12/8/6/4/2px 同心几何标尺！`
        );
      }
    });
  }
}

/**
 * Rule 5 (G-05): 7 级标准 Z-Index 标尺合规性检查（封顶 9000）
 * 彻底消除 100,000 恶性通胀魔数与 26 个历史废弃 Token。
 */
function runRule5_ZIndexStandard() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(css|module\.css|tsx|ts)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/)/
  );

  const FORBIDDEN_TOKENS = [
    '--z-first-run',
    '--z-drag-overlay-max',
    '--z-cheatsheet',
    '--z-settings-panel',
    '--z-toast-max',
    '--z-model-flyout',
    '--z-dialog',
    '--z-card-header',
    '--z-header',
    '--z-toolbar',
    '--z-split',
    '--z-overlay',
    '--z-mask',
    '--z-flyout',
    '--z-floating',
    '--z-fullscreen-error',
    '--z-preview',
    '--z-quick-switcher',
    '--z-command-palette',
    '--z-search',
    '--z-prompt',
    '--z-menu-item',
    '--z-kbd',
    '--z-banner',
    '--z-badge',
    '--z-notification',
  ];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      for (const token of FORBIDDEN_TOKENS) {
        if (lineText.includes(token)) {
          report(
            5,
            'G-05',
            file,
            idx + 1,
            `禁止使用已废弃的 Z-Index Token: ${token}，必须使用 7 级标准标尺！`
          );
        }
      }

      // 检查 CSS 中的裸数字 z-index: >= 100 且未通过 CSS 变量（排除 z-index.css 中的变量赋值）
      if (!file.endsWith('z-index.css') && /z-index:\s*[1-9][0-9]{2,}\s*;/.test(lineText)) {
        report(
          5,
          'G-05',
          file,
          idx + 1,
          `禁止使用高位裸数字 z-index，必须使用 7 级标准 Token（封顶 9000）！`
        );
      }

      // 检查有毒/恶性通胀 fallback 默认值（如 var(--z-tooltip, 9999)）
      if (/var\(--z-[^,]+,\s*(?:9999|99999|100000|\d{5,})\)/.test(lineText)) {
        report(
          5,
          'G-05',
          file,
          idx + 1,
          `禁止在 var(--z-*) 中使用 >9000 的恶性通胀默认值！`
        );
      }
    });
  }

  // 强化检测：识别 TSX 中的内联 zIndex 违规（封顶 9000）
  const tsxFiles = collectFiles(DESKTOP_SRC, /\.(tsx|jsx)$/, /(\.test\.|\.spec\.)/);
  for (const file of tsxFiles) {
    const content = readFileSync(file, 'utf8');
    if (/zIndex\s*:\s*(?:9[0-9]{3,}|[1-9][0-9]{4,})/.test(content)) {
      report(5, 'G-05', file, 1, `TSX 内联样式禁止使用超过 9000 的恶性通胀 zIndex！`);
    }
  }
}

/**
 * Rule 6 (G-06): 业务层 CSS Modules 零 !important 拦截
 * 排除 reduced-motion 系统级无障碍覆盖与 tokens。
 */
function runRule6_ZeroImportant() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(css|module\.css)$/,
    /(reduced-motion\.css|tokens\.css|src\/styles\/|\.test\.|\.spec\.)/
  );

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      if (lineText.includes('!important')) {
        report(
          6,
          'G-06',
          file,
          idx + 1,
          `业务样式表禁止使用 !important，必须通过扁平化 CSS Modules 特异性解决样式层叠！`
        );
      }
    });
  }
}

/**
 * Rule 7 (G-07): 入口 index.css 零废弃全局样式表 import
 * 除 shell-reset.css（盒模型/字体）与 shell-layout.css（仅高度链）外，禁止 styles/shell/* 回潮。
 * 继续拦截 shell-workspace / polish / menus / sidebar / dragdrop / scrollbar 及任何第三份 shell 表。
 * 仍严禁引入 settings/、panels.css、chat.css 等废弃样式。
 */
function runRule7_CssHygiene() {
  const indexCss = join(DESKTOP_SRC, 'index.css');
  if (existsSync(indexCss)) {
    const content = readFileSync(indexCss, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      if (/@import\s+['"]\.\/styles\/settings\//.test(lineText)) {
        report(
          7,
          'G-07',
          indexCss,
          idx + 1,
          `index.css 禁止导入已废弃的 styles/settings/ 全局样式表！`
        );
      }
      if (/@import\s+['"]\.\/styles\/panels\.css['"]/.test(lineText)) {
        report(
          7,
          'G-07',
          indexCss,
          idx + 1,
          `index.css 禁止导入已废弃的 styles/panels.css！`
        );
      }
      if (/@import\s+['"]\.\/styles\/chat\.css['"]/.test(lineText)) {
        report(
          7,
          'G-07',
          indexCss,
          idx + 1,
          `index.css 禁止导入已废弃的 styles/chat.css 全局样式表！`
        );
      }
      if (/@import\s+['"]\.\/styles\/shell\/(?!shell-reset\.css|shell-layout\.css)/.test(lineText)) {
        report(
          7,
          'G-07',
          indexCss,
          idx + 1,
          `index.css 禁止导入已废弃的 styles/shell/ 全局样式表（仅放行 shell-reset.css 与 shell-layout.css）！`
        );
      }
    });
  }
}

/**
 * Rule 8 (G-08): 叶子分发 TreeLeafPanel 零静态 switch(panelId)
 * 视图分发层必须统一经由 ViewRegistry 声明式渲染。
 */
function runRule8_ViewRegistryInvariant() {
  const leafPanel = join(
    DESKTOP_SRC,
    'components',
    'binary-tree',
    'TreeLeafPanel.tsx'
  );
  if (existsSync(leafPanel)) {
    const content = readFileSync(leafPanel, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      if (/switch\s*\(\s*(panelId|activeTab|leaf\.panelId)\s*\)/.test(lineText)) {
        report(
          8,
          'G-08',
          leafPanel,
          idx + 1,
          `TreeLeafPanel 禁止使用 switch(panelId) 静态分发，必须通过 ViewRegistry 动态声明式渲染！`
        );
      }
      if (/panelId\.startsWith\(['"]file-viewer:/.test(lineText)) {
        report(
          8,
          'G-08',
          leafPanel,
          idx + 1,
          `TreeLeafPanel 禁止使用 file-viewer 字符串前缀解析，必须使用结构化实例参数！`
        );
      }
      if (/KNOWN_BODY_IDS|PANEL_TITLE_MAP|PANEL_LABELS/.test(lineText)) {
        report(
          8,
          'G-08',
          leafPanel,
          idx + 1,
          `TreeLeafPanel 禁止维护静态面板映射字典，必须由 ViewRegistry 自描述管理！`
        );
      }
    });
  }
}

/**
 * Rule 9 (G-09): 状态层零伪门面别名同体与零 withAutoIndex 中间件
 * 各 Zustand Store 必须物理独立切分，彻底清除全量自动索引同步阻塞。
 */
function runRule9_StoreFacades() {
  const storeDir = join(DESKTOP_SRC, 'store');
  const files = collectFiles(storeDir, /\.(ts|tsx)$/, /(\.test\.|\.spec\.)/);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      if (/export\s+const\s+use(Session|Workspace|SettingsUi)Store\s*=\s*useLayoutStore/.test(lineText)) {
        report(
          9,
          'G-09',
          file,
          idx + 1,
          `禁止将 Store 别名同体导出为 useLayoutStore，所有 Store 必须为物理独立实例！`
        );
      }
      if (/import\s+{[^}]*useLayoutStore\s+as\s+useSessionStore[^}]*}/.test(lineText)) {
        report(
          9,
          'G-09',
          file,
          idx + 1,
          `禁止伪装导入 useLayoutStore as useSessionStore！`
        );
      }
      if (/withAutoIndex|autoIndexMiddleware/.test(lineText)) {
        report(
          9,
          'G-09',
          file,
          idx + 1,
          `禁止引入/包装 withAutoIndex / autoIndexMiddleware 阻塞中间件！`
        );
      }
    });
  }
}

/**
 * Rule 10 (G-10): 空态表面零状态渗透 (!onEmptySurface 刚性门闩)
 * 会话 Diff 必须由纯函数派生，动态胶囊必须装配 !onEmptySurface 刚性门闩。
 */
function runRule10_CleanSlateInvariant() {
  const ribbonsFile = join(
    DESKTOP_SRC,
    'components',
    'chat-card',
    'ChatStatusRibbons.tsx'
  );
  if (existsSync(ribbonsFile)) {
    const content = readFileSync(ribbonsFile, 'utf8');
    if (!content.includes('onEmptySurface')) {
      report(
        10,
        'G-10',
        ribbonsFile,
        1,
        `ChatStatusRibbons 必须装配 onEmptySurface 刚性门闩，阻断空态动态胶囊挂载渗透！`
      );
    }
  }

  // 检查 chat-card 组件中禁止直接跨域直连 terminalStore.diffFiles
  const chatCardFiles = collectFiles(
    join(DESKTOP_SRC, 'components', 'chat-card'),
    /\.(ts|tsx)$/,
    /(\.test\.|\.spec\.)/
  );
  for (const file of chatCardFiles) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('terminalStore.diffFiles') || content.includes('useTerminalStore((s) => s.diffFiles)')) {
      report(
        10,
        'G-10',
        file,
        1,
        `会话组件禁止直接读取全局 Git 变更！必须基于当前会话 messages 纯函数派生！`
      );
    }
  }
}

/**
 * Rule 11 (G-11): 全仓零 onShowToast 属性透传 (No Toast Prop Drilling)
 * 所有组件必须使用 useToast() / toast 单例，严禁声明与传递 onShowToast Props。
 */
function runRule11_NoToastPropDrilling() {
  const srcFiles = collectFiles(DESKTOP_SRC, /\.(ts|tsx)$/, /(\.test\.|\.spec\.)/);
  for (const file of srcFiles) {
    // 跳过 ToastContext 自身定义
    if (file.includes('ToastContext.tsx') || file.includes('useToastQueue.ts')) continue;
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/onShowToast\s*[:\?=]/.test(lineText) || /onShowToast=\{/.test(lineText)) {
        report(
          11,
          'G-11',
          file,
          idx + 1,
          `禁止声明或透传 onShowToast 属性！请改用 useToast() Context 单例！`
        );
      }
    });
  }
}

/**
 * Rule 12 (G-12): 严禁使用原生 HTML title 属性作为悬浮提示 (No Native Title Attribute)
 * 交互元素悬浮提示必须统一使用项目自定义 <Tooltip content={...}> 组件包裹。
 * 基于 TypeScript AST 遍历，支持多行标签换行与全标签检测。
 */
function runRule12_NoNativeTitle() {
  const tsxFiles = collectFiles(
    DESKTOP_SRC,
    /\.(tsx|jsx)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/|components\/ui\/Tooltip\/Tooltip\.tsx|components\/ui\/Tooltip\.tsx)/
  );
  for (const file of tsxFiles) {
    const content = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sf);
        // HTML 原生小写标签（button, div, span, a, input, select 等）
        const isStandardHtmlTag = /^[a-z]/.test(tagName);
        for (const prop of node.attributes.properties) {
          if (ts.isJsxAttribute(prop) && prop.name.getText(sf) === 'title') {
            if (isStandardHtmlTag) {
              const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf));
              report(
                12,
                'G-12',
                file,
                line + 1,
                `禁止在原生标签 <${tagName}> 上使用 HTML title 属性作为悬浮提示！必须使用 <Tooltip> 组件！`
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
}

/**
 * Rule 13 (G-13): 全仓零 GBK 乱码固化与编码损坏阻断 (Zero GBK Mojibake & Encoding Corruption)
 * 检查全仓 UTF-8 BOM、U+FFFD 替换符、PUA 损坏区与 GBK 逆变换乱码。
 */
function runRule13_ZeroGbkMojibake() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(css|module\.css|ts|tsx)$/,
    /(\.test\.(ts|tsx)|\.spec\.(ts|tsx)|tests\/)/
  );

  const FEATURE_CHARS = '閳ユ柡鈧姘顒烽敍妞ょ數鐎鏂鍙鍘鍦鎻鎷鎸鍗鍐鍑鍔鈥鈧锛濠婃艾濮╅崠鐚寸鈹€';
  const FEATURE_SET = new Set(FEATURE_CHARS.split(''));
  const KATAKANA_RE = /[\u30a0-\u30ff]/;

  function gbkInverseRecover(line) {
    if (!/[\u4e00-\u9fff]/.test(line)) return null;
    try {
      const gbkBytes = Buffer.from(line, 'gbk');
      const recovered = new TextDecoder('utf-8', { fatal: true }).decode(gbkBytes);
      const cjkCount = (recovered.match(/[\u4e00-\u9fff]/g) || []).length;
      if (cjkCount >= 2) return recovered;
    } catch {
      /* ignore */
    }
    return null;
  }

  function featureHitCount(line) {
    let hits = 0;
    for (const ch of line) {
      if (FEATURE_SET.has(ch)) hits++;
    }
    if (KATAKANA_RE.test(line)) hits++;
    return hits;
  }

  for (const file of files) {
    const bytes = readFileSync(file);
    // 1. BOM
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      report(13, 'G-13', file, 1, '禁止使用 UTF-8 BOM，必须使用 UTF-8 无 BOM 编码！');
    }
    // 2. Strict UTF-8 decode
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      report(13, 'G-13', file, 1, '非法 UTF-8 字节编码损坏（疑似包含 GBK 原始字节）！');
      continue;
    }

    const lines = text.split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      if (lineText.includes('\uFFFD')) {
        report(13, 'G-13', file, idx + 1, '发现 U+FFFD 乱码替换符，注释或代码文本已损坏！');
      }
      if (/[\uE000-\uF8FF]/.test(lineText)) {
        report(13, 'G-13', file, idx + 1, '发现 PUA 私有区字符（U+E000–U+F8FF），属于 GBK 乱码固化铁证！');
      }
      const recovered = gbkInverseRecover(lineText);
      if (recovered) {
        report(13, 'G-13', file, idx + 1, `发现 GBK 乱码（逆变换恢复提示：${recovered.slice(0, 20)}）！`);
      }
      if (/[\u4e00-\u9fff]/.test(lineText) && featureHitCount(lineText) >= 3) {
        report(13, 'G-13', file, idx + 1, '命中多个 GBK mojibake 特征字符！');
      }
    });
  }
}

/**
 * Rule 14 (G-14): 业务层 CSS Modules 禁书 :global(.button|.input|.textarea|.menu*) 幽灵提权选择器
 * 检查全仓业务 CSS Modules，禁止书写 :global(.button|.input|.textarea|.menu*) 等死选择器。
 */
function runRule14_NoGhostGlobalSelectors() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(module\.css)$/,
    /(\.test\.|\.spec\.|components\/ui\/)/
  );

  const GHOST_RE = /:global\(\s*\.(?:button|input|textarea|menu[a-zA-Z0-9_-]*)(?![a-zA-Z0-9_-])/;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
      if (GHOST_RE.test(lineText)) {
        report(
          14,
          'G-14',
          file,
          idx + 1,
          `业务层 CSS Modules 禁止书写 :global(.button|.input|.textarea|.menu*) 幽灵提权选择器！`
        );
      }
    });
  }
}

/**
 * Rule 15 (G-15): 业务层 onKeyDown 裸判 Enter 提交阻断 (Enter Key IME Guard Invariant)
 * 业务层 <Input> 与 <Textarea> 必须通过 onEnter 契约或包含 isComposing 守卫处理回车，
 * 禁止在 onKeyDown 中裸判 key === 'Enter' 绕过 IME 输入法保护。
 */
function runRule15_EnterKeyImeGuard() {
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(tsx|jsx)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/|components\/ui\/)/
  );

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const functionMap = new Map();
    function collectFunctions(node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        functionMap.set(node.name.getText(sf), node);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            decl.name &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            functionMap.set(decl.name.getText(sf), decl.initializer);
          } else if (
            decl.name &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            (decl.initializer.expression.getText(sf) === 'useCallback' ||
              decl.initializer.expression.getText(sf).endsWith('.useCallback')) &&
            decl.initializer.arguments[0] &&
            (ts.isArrowFunction(decl.initializer.arguments[0]) ||
              ts.isFunctionExpression(decl.initializer.arguments[0]))
          ) {
            functionMap.set(decl.name.getText(sf), decl.initializer.arguments[0]);
          }
        }
      }
      ts.forEachChild(node, collectFunctions);
    }
    collectFunctions(sf);

    function checkHandlerText(handlerText, nodeForLoc, tagName) {
      const ENTER_RE = /\b(?:e|event|ev)\.key\s*===?\s*['"]Enter['"]/;
      if (ENTER_RE.test(handlerText)) {
        const hasImeGuard =
          handlerText.includes('isComposing') ||
          handlerText.includes('229') ||
          handlerText.includes('Process');
        if (!hasImeGuard) {
          const { line } = sf.getLineAndCharacterOfPosition(nodeForLoc.getStart(sf));
          report(
            15,
            'G-15',
            file,
            line + 1,
            `<${tagName}> onKeyDown 中直接判定 key === 'Enter'，缺乏 isComposing / keyCode === 229 守卫！必须改用 onEnter 契约！`
          );
        }
      }
    }

    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sf);
        if (tagName === 'Input' || tagName === 'Textarea') {
          for (const prop of node.attributes.properties) {
            if (
              ts.isJsxAttribute(prop) &&
              prop.name.getText(sf) === 'onKeyDown' &&
              prop.initializer
            ) {
              if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
                const expr = prop.initializer.expression;
                if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
                  checkHandlerText(expr.getText(sf), prop, tagName);
                } else if (ts.isIdentifier(expr)) {
                  const idName = expr.getText(sf);
                  const fnNode = functionMap.get(idName);
                  if (fnNode) {
                    checkHandlerText(fnNode.getText(sf), prop, tagName);
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sf);
  }
}

/**
 * Rule 16 (G-16): S7 文案单点（FINAL-PLAN §2.1）
 * 生产代码中 S7 域文案字面量只允许出现在 api/userFacingErrors.ts（DOMAIN_MESSAGES SSOT）；
 * 其它位置必须经 DOMAIN_MESSAGES.S7 / isLegacyDomainNoticeThought 引用。测试文件豁免。
 */
function runRule16_S7CopySingleSource() {
  const S7_LITERAL = '上一轮任务仍在收尾中';
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(ts|tsx)$/,
    /(\.test\.|\.spec\.|__tests__|tests\/)/
  );
  for (const file of files) {
    if (toPosix(file).endsWith('/api/userFacingErrors.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((lineText, idx) => {
      if (lineText.includes(S7_LITERAL)) {
        report(16, 'G-16', file, idx + 1, 'S7 文案字面量只能定义在 api/userFacingErrors.ts（引用 DOMAIN_MESSAGES.S7）！');
      }
    });
  }
}

/**
 * Rule 17 (G-17): 载体判定单定义（FINAL-PLAN §2 S-4）
 * `export function isContextStateCarrierMessage` / `isContextStateInjection` 全仓（apps + packages 源码）只能各有 1 处定义。
 */
function runRule17_CarrierPredicateSingleDefinition() {
  const roots = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages')];
  const files = [];
  for (const r of roots) collectFiles(r, /\.(ts|tsx)$/, /(node_modules|dist|\.test\.|\.spec\.|__tests__)/, files);
  for (const name of ['isContextStateCarrierMessage', 'isContextStateInjection']) {
    const re = new RegExp(`export\\s+function\\s+${name}\\b`);
    const hits = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (re.test(src)) hits.push(file);
    }
    if (hits.length !== 1) {
      for (const f of hits.length ? hits : [DESKTOP_SRC]) {
        report(17, 'G-17', f, 0, `${name} 必须全仓唯一定义（当前 ${hits.length} 处），其余位置 re-export！`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主执行入口
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  console.log('🛡️  [check:convergence] 启动前端重构终极收敛防回潮门禁扫描 (G-01 ~ G-17)...\n');

  runRule1_NakedTags();
  runRule2_MenuCloneElement();
  runRule3_RawResizeAndThrashing();
  runRule4_ZeroPillRadius();
  runRule5_ZIndexStandard();
  runRule6_ZeroImportant();
  runRule7_CssHygiene();
  runRule8_ViewRegistryInvariant();
  runRule9_StoreFacades();
  runRule10_CleanSlateInvariant();
  runRule11_NoToastPropDrilling();
  runRule12_NoNativeTitle();
  runRule13_ZeroGbkMojibake();
  runRule14_NoGhostGlobalSelectors();
  runRule15_EnterKeyImeGuard();
  runRule16_S7CopySingleSource();
  runRule17_CarrierPredicateSingleDefinition();

  const rulesPassed = [
    { id: 'G-01', name: '业务层零裸交互标签', hit: violations.some((v) => v.includes('[Rule 1 / G-01]')) },
    { id: 'G-02', name: '浮层零 cloneElement 与零 stopPropagation', hit: violations.some((v) => v.includes('[Rule 2 / G-02]')) },
    { id: 'G-03', name: '零裸 RO / 零 window.resize / 零 0px 回流 / 零 flushSync', hit: violations.some((v) => v.includes('[Rule 3 / G-03]')) },
    { id: 'G-04', name: '零非法 radius-full 药丸（Switch/Avatar 白名单）', hit: violations.some((v) => v.includes('[Rule 4 / G-04]')) },
    { id: 'G-05', name: '7 级标准 Z-Index 标尺合规性（封顶 9000）', hit: violations.some((v) => v.includes('[Rule 5 / G-05]')) },
    { id: 'G-06', name: '业务层 CSS Modules 零 !important', hit: violations.some((v) => v.includes('[Rule 6 / G-06]')) },
    { id: 'G-07', name: '入口 index.css 零废弃全局样式表 import', hit: violations.some((v) => v.includes('[Rule 7 / G-07]')) },
    { id: 'G-08', name: '叶子分发 TreeLeafPanel 零静态 switch(panelId)', hit: violations.some((v) => v.includes('[Rule 8 / G-08]')) },
    { id: 'G-09', name: '状态层零伪门面别名同体与零 withAutoIndex 中间件', hit: violations.some((v) => v.includes('[Rule 9 / G-09]')) },
    { id: 'G-10', name: '空态表面零状态渗透 (!onEmptySurface 刚性门闩)', hit: violations.some((v) => v.includes('[Rule 10 / G-10]')) },
    { id: 'G-11', name: '全仓零 onShowToast 属性透传 (No Toast Prop Drilling)', hit: violations.some((v) => v.includes('[Rule 11 / G-11]')) },
    { id: 'G-12', name: '严禁使用原生 HTML title 属性 (强制 <Tooltip>)', hit: violations.some((v) => v.includes('[Rule 12 / G-12]')) },
    { id: 'G-13', name: '全仓零 GBK 乱码固化与编码损坏阻断', hit: violations.some((v) => v.includes('[Rule 13 / G-13]')) },
    { id: 'G-14', name: '业务层 CSS Modules 禁书 :global 幽灵提权选择器', hit: violations.some((v) => v.includes('[Rule 14 / G-14]')) },
    { id: 'G-15', name: '业务层 onKeyDown 裸判 Enter 提交阻断 (强制 onEnter / IME 守卫)', hit: violations.some((v) => v.includes('[Rule 15 / G-15]')) },
    { id: 'G-16', name: 'S7 文案单点（仅 userFacingErrors.ts）', hit: violations.some((v) => v.includes('[Rule 16 / G-16]')) },
    { id: 'G-17', name: '载体判定单定义（isContextStateCarrierMessage）', hit: violations.some((v) => v.includes('[Rule 17 / G-17]')) },
  ];

  console.log('┌──────┬──────────────────────────────────────────────────────────────┬────────────┐');
  console.log('│ 规则 │ 规则名称                                                     │ 状态       │');
  console.log('├──────┼──────────────────────────────────────────────────────────────┼────────────┤');
  for (const r of rulesPassed) {
    const status = r.hit ? '❌ 违规' : '✅ 通过';
    const paddedId = r.id.padEnd(4, ' ');
    // Handle wide unicode characters in padding
    const namePadded = r.name + ' '.repeat(Math.max(0, 60 - Buffer.byteLength(r.name, 'utf8') + r.name.length - 2));
    console.log(`│ ${paddedId} │ ${namePadded} │ ${status}    │`);
  }
  console.log('└──────┴──────────────────────────────────────────────────────────────┴────────────┘\n');

  if (violations.length > 0) {
    console.error(
      `❌ [check:convergence] 扫描拦截！共发现 ${violations.length} 处收敛违规：\n`
    );
    for (const v of violations) {
      console.error(`  ✗ ${v}`);
    }
    console.error(
      '\n🚫 请按照红队重构契约与架构规范修复上述违规项，禁止 --no-verify 绕过门禁！\n'
    );
    process.exit(1);
  }

  console.log(
    '🎉 [check:convergence] 完美通过！全仓 17 大收敛规则 0 违规，架构纯净无回潮 (All 17 Rules Passed, 0 Violations)。\n'
  );
  process.exit(0);
}

main();

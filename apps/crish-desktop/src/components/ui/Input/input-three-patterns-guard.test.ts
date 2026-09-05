import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  analyzeFocusDarkMix,
  analyzeBoxShadowSpread,
  analyzeFormFourMinimalist,
  analyzeButtonActiveBorder,
  isInputSelector,
} from '../../../../../../scripts/check-input-guardrails.mjs';

/**
 * 输入框四态体系与焦点/激活态守门刚性防御契约 (Input Four-Patterns & Focus Guard Contract)
 *
 * 严格落实用户刚性裁决与 AGENTS.md §13 (输入框与焦点态、色彩空间与克制激活态)：
 * 1. 形态 ①【侧边栏无边框纯净型】：常态 background: transparent, border: none, box-shadow: none
 * 2. 形态 ②【主对话底栏胶囊型】：ChatComposer 消息发送输入条
 * 3. 形态 ③【标准卡片表单原子型】：基于 ui/Input 的标准卡片输入框，微圆角与细边框
 * 4. 形态 ④【内联浮层/卡片顶栏筛选框（纯光标极简型）】：ModelBadgePickerMenu、DiffCard、FilesCard 等，全态只有光标闪烁，严禁非透明边框与深色焦点外框
 * 5. 焦点态与激活态刚性门禁：
 *    - 严禁混入 > 10% 文本纯黑（如 40%、60% 文本色焦点环）
 *    - 严禁 > 1.5px 粗重焦点投影（如 0 0 0 3px 黑环）
 *    - 严禁按钮 active 激活态硬编码纯黑边框
 */
describe('输入框四态体系与焦点/激活态刚性防御契约', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const desktopSrc = path.resolve(currentDir, '../../..');
  const repoRoot = path.resolve(desktopSrc, '../../..');

  it('形态 ① 防御：主侧栏会话搜索框必须为无边框纯透明形式', () => {
    const sidebarNavCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/sidebar/SidebarNav.module.css'),
      'utf-8'
    );
    expect(sidebarNavCss).toMatch(/\.navItem\[role=['"]search['"]\]\s*\{[^}]*background:\s*transparent/);
    expect(sidebarNavCss).toMatch(/\.navItem\[role=['"]search['"]\]\s*\{[^}]*border:\s*none/);
    expect(sidebarNavCss).toMatch(/\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*border:\s*none/);
    expect(sidebarNavCss).toMatch(/\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*box-shadow:\s*none/);
  });

  it('形态 ① 防御：设置侧边栏搜索框必须与主侧栏 100% 共享无边框纯透明形式', () => {
    const settingsPanelCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/settings/SettingsPanel.module.css'),
      'utf-8'
    );
    expect(settingsPanelCss).toMatch(/\.searchWrap\s*\{[^}]*background:\s*transparent/);
    expect(settingsPanelCss).toMatch(/\.searchWrap\s*\{[^}]*border:\s*none/);
    expect(settingsPanelCss).toMatch(/\.search[^{]*\{[^}]*border:\s*none/);
    expect(settingsPanelCss).toMatch(/\.search[^{]*\{[^}]*box-shadow:\s*none/);
  });

  it('形态 ④ 防御：下拉菜单与浮层搜索框必须是“纯光标极简型”（只有光标闪烁，其他全无变化）', () => {
    const pickerMenuCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/provider/ModelBadgePickerMenu.module.css'),
      'utf-8'
    );
    expect(pickerMenuCss).toContain('.searchInput:focus');
    expect(pickerMenuCss).toContain('.searchInput:focus-visible');
    expect(pickerMenuCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(pickerMenuCss).toMatch(/\.searchInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(pickerMenuCss).toMatch(/\.searchInput[^{]*\{[^}]*outline:\s*none/);

    const fontSelectCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/settings/FontSelectField.module.css'),
      'utf-8'
    );
    expect(fontSelectCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(fontSelectCss).toMatch(/\.searchInput[^{]*\{[^}]*box-shadow:\s*none/);
  });

  it('形态 ④ 防御：DiffCard 与 FilesCard 搜索/筛选框必须保持纯光标极简型（全态无框无阴影）', () => {
    const diffCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCard.module.css'),
      'utf-8'
    );
    expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(diffCardCss).not.toMatch(/\.searchInput:focus[^{]*\{[^}]*border-color:/);

    const filesCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/files/FilesCard.module.css'),
      'utf-8'
    );
    expect(filesCardCss).toMatch(/\.filesPathFilter[^{]*\{[^}]*border:\s*none/);
    expect(filesCardCss).toMatch(/\.filesPathFilter[^{]*\{[^}]*box-shadow:\s*none/);
  });

  it('全局防御：focus-visible.css 必须阻断全局焦点阴影对形态 ① 与形态 ④ 的穿透污染', () => {
    const focusVisibleCss = fs.readFileSync(
      path.resolve(desktopSrc, 'styles/focus-visible.css'),
      'utf-8'
    );
    expect(focusVisibleCss).toMatch(/role=['"]search['"][\s\S]*?role=['"]menu['"][\s\S]*?role=['"]listbox['"]/);
    expect(focusVisibleCss).toContain('box-shadow: none !important;');
    expect(focusVisibleCss).toMatch(/(?:\.searchInput|\[class\*=['"]searchInput['"]\]):is\(:focus,\s*:focus-visible\)/);
  });

  it('全局焦点软灰规范：focus-visible.css 混入文本色严格 <= 10%，阴影投影严格 <= 1.5px (AGENTS.md §13)', () => {
    const focusVisibleCss = fs.readFileSync(
      path.resolve(desktopSrc, 'styles/focus-visible.css'),
      'utf-8'
    );
    expect(focusVisibleCss).not.toContain('var(--text-primary) 60%');
    expect(focusVisibleCss).not.toContain('var(--border-color) 40%');
    expect(focusVisibleCss).not.toContain('0 0 0 3px');

    expect(focusVisibleCss).toMatch(/--focus-visible-ring:\s*color-mix\(\s*in srgb,\s*var\(--border-color\)\s*90%,\s*var\(--text-primary\)\s*10%\s*\)/);
    expect(focusVisibleCss).toMatch(/0 0 0 1\.5px var\(--focus-visible-ring\)/);
  });

  it('形态 ③ 防御：标准原子 Input 必须保持微圆角与 Design Token 色板，严禁原生硬黑框', () => {
    const inputCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/ui/Input/Input.module.css'),
      'utf-8'
    );
    expect(inputCss).toContain('border: 1px solid var(--border-subtle);');
    expect(inputCss).toContain('border-radius: var(--radius-md, 6px);');
    expect(inputCss).toMatch(/\.input:focus[^{]*\{[^}]*box-shadow:\s*none;/);
  });

  it('形态 ③ 防御：标准原子 Textarea 必须保持微圆角与 Design Token 细边框，严禁原生硬黑框', () => {
    const textareaCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/ui/Input/Textarea.module.css'),
      'utf-8'
    );
    expect(textareaCss).toContain('border: 1px solid var(--border-subtle);');
    expect(textareaCss).toContain('border-radius: var(--radius-md, 6px);');
    expect(textareaCss).toMatch(/\.nativeTextarea:focus[^{]*\{[^}]*box-shadow:\s*none;/);
  });

  // --- AST 守卫刚性拦截单元测试 ---
  it('AST 刚性拦截：焦点态混入大于 10% 文本纯黑（如 40%、60% 文本色焦点环）必须被 100% 阻断', () => {
    const violations60 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);
    `);
    expect(violations60.length).toBeGreaterThan(0);
    expect(violations60.some(v => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 60)).toBe(true);

    const violations40 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 60%, var(--text-primary) 40%);
    `);
    expect(violations40.length).toBeGreaterThan(0);
    expect(violations40.some(v => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 40)).toBe(true);

    const rawViolations = analyzeFocusDarkMix(`
      border: 1px solid var(--text-primary);
    `);
    expect(rawViolations.length).toBeGreaterThan(0);
    expect(rawViolations.some(v => v.type === 'RAW_DARK_BORDER')).toBe(true);

    const allowed10 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
    `);
    expect(allowed10).toEqual([]);

    const allowed6 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
    `);
    expect(allowed6).toEqual([]);
  });

  it('AST 刚性拦截：大于 1.5px 的粗重焦点投影（如 0 0 0 3px 黑环）必须被 100% 阻断', () => {
    const violations3px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 1px var(--bg-card), 0 0 0 3px var(--focus-visible-ring);
    `);
    expect(violations3px.length).toBeGreaterThan(0);
    expect(violations3px.some(v => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 3)).toBe(true);

    const violations2px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 2px #000;
    `);
    expect(violations2px.length).toBeGreaterThan(0);
    expect(violations2px.some(v => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 2)).toBe(true);

    const allowed1_5px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 1px var(--bg-card), 0 0 0 1.5px var(--focus-visible-ring);
    `);
    expect(allowed1_5px).toEqual([]);

    const allowedNone = analyzeBoxShadowSpread(`
      box-shadow: none;
    `);
    expect(allowedNone).toEqual([]);
  });

  it('AST 刚性拦截：强制形态 ④（搜索/筛选输入框）必须为无边框极简型，严禁出现非透明 border 或深色焦点外框', () => {
    const borderViolation = analyzeFormFourMinimalist('.searchInput', `
      border: 1px solid var(--border-subtle);
      background: transparent;
    `);
    expect(borderViolation.length).toBeGreaterThan(0);
    expect(borderViolation.some(v => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER')).toBe(true);

    const focusShadowViolation = analyzeFormFourMinimalist('.searchInput:focus', `
      box-shadow: 0 0 0 1.5px var(--focus-border-color);
    `);
    expect(focusShadowViolation.length).toBeGreaterThan(0);
    expect(focusShadowViolation.some(v => v.type === 'FORM_FOUR_FOCUS_SHADOW')).toBe(true);

    const cleanFormFour = analyzeFormFourMinimalist('.searchInput:focus', `
      border: none;
      box-shadow: none;
      outline: none;
    `);
    expect(cleanFormFour).toEqual([]);
  });

  it('AST 刚性拦截：按钮 active 激活态上的硬编码纯黑边框必须被 100% 阻断', () => {
    const blackHexViolation = analyzeButtonActiveBorder(`
      border-color: #000;
    `);
    expect(blackHexViolation.length).toBeGreaterThan(0);

    const blackKeywordViolation = analyzeButtonActiveBorder(`
      border: 1px solid black;
    `);
    expect(blackKeywordViolation.length).toBeGreaterThan(0);

    const blackRingViolation = analyzeButtonActiveBorder(`
      box-shadow: 0 0 0 1px #000;
    `);
    expect(blackRingViolation.length).toBeGreaterThan(0);

    const cleanButtonActive = analyzeButtonActiveBorder(`
      background-color: var(--tint-hover);
      border-color: var(--border-subtle);
    `);
    expect(cleanButtonActive).toEqual([]);
  });

  it('形态 ④ 防御：笔记纸面行内标题输入框 (NotePaperPanel.module.css 与 EditableTitle.tsx) 必须保持纯光标极简型（全态无框无阴影纯光标）', () => {
    const notePaperCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/note-paper/NotePaperPanel.module.css'),
      'utf-8'
    );
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*background:\s*transparent/);
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*border:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*outline:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(notePaperCss).toContain('.titleInput:focus');
    expect(notePaperCss).toContain('.titleInput:focus-visible');
    expect(notePaperCss).toMatch(/\.titleInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput:focus(?:-visible)?[^{]*\{[^}]*outline:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/);

    const editableTitleTsx = fs.readFileSync(
      path.resolve(desktopSrc, 'components/note-paper/EditableTitle.tsx'),
      'utf-8'
    );
    expect(editableTitleTsx).toContain('className={styles.titleInput}');
  });

  it('形态 ③ / 卡片提交输入框防御：DiffCard 提交输入框 (.commitInput 与 DiffCardGitActions) 必须保持微圆角与克制软灰焦点态', () => {
    const diffCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCard.module.css'),
      'utf-8'
    );
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*outline:\s*none/);
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*border-radius:\s*var\(--radius-(?:sm|md),\s*(?:4|6)px\)/);
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*border:\s*1px solid color-mix/);
    expect(diffCardCss).toContain('.commitInput:focus');
    expect(diffCardCss).toContain('.commitInput:focus-visible');
    expect(diffCardCss).toMatch(/\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*box-shadow:\s*none/);
    expect(diffCardCss).toMatch(/\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*outline:\s*none/);
    expect(diffCardCss).toMatch(/\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*border-color:\s*color-mix\(.*?var\(--text-primary\)\s*(?:[1-9]|10)%\)/);

    const gitActionsTsx = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCardGitActions.tsx'),
      'utf-8'
    );
    expect(gitActionsTsx).toContain('className={styles.commitInput}');
  });

  it('AST 刚性拦截：全形态驼峰输入框、属性选择器（[type="text"], [type="search"]）与组合选择器无死角扫描与拦截', () => {
    // 1. 验证驼峰命名、属性选择器与复杂组合选择器被 isInputSelector 准确识别
    const validInputs = [
      '.titleInput',
      '.titleInput:focus',
      '.commitInput',
      '.commitInput:focus-visible, .commitInput:focus',
      '.searchInput',
      '.tagInput',
      '.filterInput',
      '.customInput',
      '.textInput',
      '[type="text"]',
      '[type="search"]',
      '[type=\'text\']',
      '[type=search]',
      'input[type="text"]',
      'input[type="search"]',
      'div > [type="text"]',
      '.card .commitInput:focus',
      'form > .titleInput',
      '[type=\'search\']:focus-visible',
      '[type=text]:focus',
      ':is(input, textarea)',
      ':is(.titleInput, .commitInput)',
      ':is([type="text"], [type="search"])',
      '.navItem input[type=\'search\']',
      'textarea.commitInput',
      'input.titleInput',
    ];
    for (const sel of validInputs) {
      expect(isInputSelector(sel)).toBe(true);
    }

    // 2. 验证非输入框选择器（容器、外壳、图标、按钮、复选框等）不被误判为输入框
    const nonInputs = [
      '.inputWrapper',
      '.inputContainer',
      '.inputShell',
      '.inputRow',
      '.searchRow',
      '.searchIcon',
      '.searchClearBtn',
      'input[type="checkbox"]',
      'input[type="radio"]',
      'input[type="file"]',
    ];
    for (const sel of nonInputs) {
      expect(isInputSelector(sel)).toBe(false);
    }

    // 3. 验证属性选择器与驼峰类名输入框中的深色投影与超标混入会被 AST 分析器严格拦截
    const shadowViolation = analyzeBoxShadowSpread('box-shadow: 0 0 0 3px #000;');
    expect(shadowViolation.length).toBeGreaterThan(0);

    const darkMixViolation = analyzeFocusDarkMix('border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);');
    expect(darkMixViolation.length).toBeGreaterThan(0);

    const formFourShadow = analyzeFormFourMinimalist('.titleInput:focus', 'box-shadow: 0 0 0 1.5px var(--focus-border-color);');
    expect(formFourShadow.length).toBeGreaterThan(0);
  });

  it('全仓刚性守护：自动化静态守门脚本 check-input-guardrails.mjs 必须 100% 通过（0 错误）', () => {
    const stdout = execSync('node scripts/check-input-guardrails.mjs', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(stdout).toContain('全仓输入框四态体系防倒退检查 100% 通过');
  });
});

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
  analyzeFormFourContainer,
  analyzeMissingBorderReset,
  isInputSelector,
  isFormFourSelector,
  isFormFourContainerSelector,
} from '../../../../../scripts/check-input-guardrails.mjs';

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
  const desktopSrc = path.resolve(currentDir, '../..');
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
    // 严禁 60% 混入
    expect(focusVisibleCss).not.toContain('var(--text-primary) 60%');
    expect(focusVisibleCss).not.toContain('var(--border-color) 40%');
    // 严禁 3px 投影
    expect(focusVisibleCss).not.toContain('0 0 0 3px');

    // 验证严格 10% 混入与 1.5px 软焦点环
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
    // 60% 违规
    const violations60 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);
    `);
    expect(violations60.length).toBeGreaterThan(0);
    expect(violations60.some(v => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 60)).toBe(true);

    // 40% 违规
    const violations40 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 60%, var(--text-primary) 40%);
    `);
    expect(violations40.length).toBeGreaterThan(0);
    expect(violations40.some(v => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 40)).toBe(true);

    // 裸写 var(--text-primary) 纯黑硬框违规 (100%)
    const rawViolations = analyzeFocusDarkMix(`
      border: 1px solid var(--text-primary);
    `);
    expect(rawViolations.length).toBeGreaterThan(0);
    expect(rawViolations.some(v => v.type === 'RAW_DARK_BORDER')).toBe(true);

    // 合规 10% 与 6% 软灰必须放行
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
    // 3px 粗黑环违规
    const violations3px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 1px var(--bg-card), 0 0 0 3px var(--focus-visible-ring);
    `);
    expect(violations3px.length).toBeGreaterThan(0);
    expect(violations3px.some(v => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 3)).toBe(true);

    // 2px 粗黑环违规
    const violations2px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 2px #000;
    `);
    expect(violations2px.length).toBeGreaterThan(0);
    expect(violations2px.some(v => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 2)).toBe(true);

    // 合规 1.5px 与 1px 软微阴影必须放行
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
    // 常态声明非透明边框违规
    const borderViolation = analyzeFormFourMinimalist('.searchInput', `
      border: 1px solid var(--border-subtle);
      background: transparent;
    `);
    expect(borderViolation.length).toBeGreaterThan(0);
    expect(borderViolation.some(v => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER')).toBe(true);

    // 焦点态声明外框阴影违规
    const focusShadowViolation = analyzeFormFourMinimalist('.searchInput:focus', `
      box-shadow: 0 0 0 1.5px var(--focus-border-color);
    `);
    expect(focusShadowViolation.length).toBeGreaterThan(0);
    expect(focusShadowViolation.some(v => v.type === 'FORM_FOUR_FOCUS_SHADOW')).toBe(true);

    // 合规纯光标极简型（border: none, box-shadow: none）必须放行
    const cleanFormFour = analyzeFormFourMinimalist('.searchInput:focus', `
      border: none;
      box-shadow: none;
      outline: none;
    `);
    expect(cleanFormFour).toEqual([]);
  });

  it('AST 刚性拦截：按钮 active 激活态上的硬编码纯黑边框必须被 100% 阻断', () => {
    // 激活态硬编码 #000 边框违规
    const blackHexViolation = analyzeButtonActiveBorder(`
      border-color: #000;
    `);
    expect(blackHexViolation.length).toBeGreaterThan(0);

    // 激活态硬编码 black 边框违规
    const blackKeywordViolation = analyzeButtonActiveBorder(`
      border: 1px solid black;
    `);
    expect(blackKeywordViolation.length).toBeGreaterThan(0);

    // 激活态硬编码纯黑阴影环违规
    const blackRingViolation = analyzeButtonActiveBorder(`
      box-shadow: 0 0 0 1px #000;
    `);
    expect(blackRingViolation.length).toBeGreaterThan(0);

    // 激活态使用标准 Design Token 或无边框必须放行
    const cleanButtonActive = analyzeButtonActiveBorder(`
      background-color: var(--tint-hover);
      border-color: var(--border-subtle);
    `);
    expect(cleanButtonActive).toEqual([]);
  });

  it('容器联动防御：形态 ④ 容器严禁声明 border 与 box-shadow', () => {
    const borderViolation = analyzeFormFourContainer('.titleContainer', 'border: 1px solid var(--border-color);');
    expect(borderViolation.length).toBeGreaterThan(0);
    expect(borderViolation.some(v => v.type === 'FORM_FOUR_CONTAINER_BORDER')).toBe(true);

    const shadowViolation = analyzeFormFourContainer('.renameContainer', 'box-shadow: 0 4px 12px rgba(0,0,0,0.1);');
    expect(shadowViolation.length).toBeGreaterThan(0);
    expect(shadowViolation.some(v => v.type === 'FORM_FOUR_CONTAINER_SHADOW')).toBe(true);

    const clean = analyzeFormFourContainer('.titleContainer', 'padding: 4px; display: flex;');
    expect(clean).toEqual([]);
  });

  it('AST 刚性拦截：形态 ④ 基础规则缺失 4 项强制声明（border: none, background: transparent, box-shadow: none, outline: none）刚性报错', () => {
    const missing = analyzeFormFourMinimalist('.renameInput', 'background: transparent;');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some(v => v.type === 'FORM_FOUR_MISSING_BORDER_NONE')).toBe(true);
    expect(missing.some(v => v.type === 'FORM_FOUR_MISSING_BOX_SHADOW_NONE')).toBe(true);
    expect(missing.some(v => v.type === 'FORM_FOUR_MISSING_OUTLINE_NONE')).toBe(true);

    const full = analyzeFormFourMinimalist('.renameInput', 'border: none; background: transparent; box-shadow: none; outline: none;');
    expect(full).toEqual([]);
  });

  it('AST 刚性拦截：输入框默认边框未重置拦截分析器 analyzeMissingBorderReset', () => {
    const unreset = analyzeMissingBorderReset('.customInput', 'height: 32px; padding: 4px; background: #fff;');
    expect(unreset.length).toBeGreaterThan(0);
    expect(unreset.some(v => v.type === 'MISSING_BORDER_RESET')).toBe(true);

    const resetNone = analyzeMissingBorderReset('.customInput', 'height: 32px; padding: 4px; border: none;');
    expect(resetNone).toEqual([]);

    const resetBorder = analyzeMissingBorderReset('.customInput', 'height: 32px; padding: 4px; border: 1px solid var(--border-subtle);');
    expect(resetBorder).toEqual([]);
  });

  it('选择器判定契约：isInputSelector 与 isFormFourSelector 完备性', () => {
    expect(isInputSelector('.titleInput')).toBe(true);
    expect(isInputSelector('.renameInput')).toBe(true);
    expect(isInputSelector('.searchInput')).toBe(true);
    expect(isInputSelector('textarea.commitInput')).toBe(true);
    expect(isInputSelector('.inputWrapper')).toBe(false);
    expect(isInputSelector('.titleContainer')).toBe(false);

    expect(isFormFourSelector('.titleInput')).toBe(true);
    expect(isFormFourSelector('.renameInput')).toBe(true);
    expect(isFormFourSelector('.sessionRenameInput')).toBe(true);
    expect(isFormFourSelector('.searchInput')).toBe(true);
    expect(isFormFourSelector('.titleContainer')).toBe(false);

    expect(isFormFourContainerSelector('.titleContainer')).toBe(true);
    expect(isFormFourContainerSelector('.renameContainer')).toBe(true);
    expect(isFormFourContainerSelector('.titleInput')).toBe(false);
  });

  it('全仓刚性守护：自动化静态守门脚本 check-input-guardrails.mjs 必须 100% 通过（0 错误）', () => {
    const stdout = execSync('node scripts/check-input-guardrails.mjs', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(stdout).toContain('全仓输入框四态体系防倒退检查 100% 通过');
  });
});

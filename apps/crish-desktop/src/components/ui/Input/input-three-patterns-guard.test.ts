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
  extractCssRules,
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
    expect(sidebarNavCss).toMatch(
      /\.navItem\[role=['"]search['"]\]\s*\{[^}]*background:\s*transparent/
    );
    expect(sidebarNavCss).toMatch(
      /\.navItem\[role=['"]search['"]\]\s*\{[^}]*border:\s*none/
    );
    expect(sidebarNavCss).toMatch(
      /\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*border:\s*none/
    );
    expect(sidebarNavCss).toMatch(
      /\.navItem input\[type=['"]search['"]\][^{]*\{[^}]*box-shadow:\s*none/
    );
  });

  it('形态 ① 防御：设置侧边栏搜索框必须与主侧栏 100% 共享无边框纯透明形式', () => {
    const settingsPanelCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/settings/SettingsPanel.module.css'),
      'utf-8'
    );
    expect(settingsPanelCss).toMatch(
      /\.searchWrap\s*\{[^}]*background:\s*transparent/
    );
    expect(settingsPanelCss).toMatch(/\.searchWrap\s*\{[^}]*border:\s*none/);
    expect(settingsPanelCss).toMatch(/\.search[^{]*\{[^}]*border:\s*none/);
    expect(settingsPanelCss).toMatch(/\.search[^{]*\{[^}]*box-shadow:\s*none/);
  });

  it('形态 ④ 防御：下拉菜单与浮层搜索框必须是“纯光标极简型”（只有光标闪烁，其他全无变化）', () => {
    const pickerMenuCss = fs.readFileSync(
      path.resolve(
        desktopSrc,
        'components/provider/ModelBadgePickerMenu.module.css'
      ),
      'utf-8'
    );
    expect(pickerMenuCss).toContain('.searchInput:focus');
    expect(pickerMenuCss).toContain('.searchInput:focus-visible');
    expect(pickerMenuCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(pickerMenuCss).toMatch(
      /\.searchInput[^{]*\{[^}]*box-shadow:\s*none/
    );
    expect(pickerMenuCss).toMatch(/\.searchInput[^{]*\{[^}]*outline:\s*none/);

    const fontSelectCss = fs.readFileSync(
      path.resolve(
        desktopSrc,
        'components/settings/FontSelectField.module.css'
      ),
      'utf-8'
    );
    expect(fontSelectCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(fontSelectCss).toMatch(
      /\.searchInput[^{]*\{[^}]*box-shadow:\s*none/
    );
  });

  it('形态 ④ 防御：DiffCard 与 FilesCard 搜索/筛选框必须保持纯光标极简型（全态无框无阴影）', () => {
    const diffCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCard.module.css'),
      'utf-8'
    );
    expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/);
    expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(diffCardCss).not.toMatch(
      /\.searchInput:focus[^{]*\{[^}]*border-color:/
    );

    const filesCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/files/FilesCard.module.css'),
      'utf-8'
    );
    expect(filesCardCss).toMatch(/\.filesPathFilter[^{]*\{[^}]*border:\s*none/);
    expect(filesCardCss).toMatch(
      /\.filesPathFilter[^{]*\{[^}]*box-shadow:\s*none/
    );
  });

  it('全局防御：focus-visible.css 必须阻断全局焦点阴影对形态 ① 与形态 ④ 的穿透污染', () => {
    const focusVisibleCss = fs.readFileSync(
      path.resolve(desktopSrc, 'styles/focus-visible.css'),
      'utf-8'
    );
    expect(focusVisibleCss).toMatch(
      /role=['"]search['"][\s\S]*?role=['"]menu['"][\s\S]*?role=['"]listbox['"]/
    );
    expect(focusVisibleCss).toContain('box-shadow: none !important;');
    expect(focusVisibleCss).toMatch(
      /(?:\.searchInput|\[class\*=['"]searchInput['"]\]):is\(:focus,\s*:focus-visible\)/
    );
  });

  it('全局焦点软灰规范：focus-visible.css 混入文本色严格 <= 10%，阴影投影严格 <= 1.5px (AGENTS.md §13)', () => {
    const focusVisibleCss = fs.readFileSync(
      path.resolve(desktopSrc, 'styles/focus-visible.css'),
      'utf-8'
    );
    expect(focusVisibleCss).not.toContain('var(--text-primary) 60%');
    expect(focusVisibleCss).not.toContain('var(--border-color) 40%');
    expect(focusVisibleCss).not.toContain('0 0 0 3px');

    expect(focusVisibleCss).toMatch(
      /--focus-visible-ring:\s*color-mix\(\s*in srgb,\s*var\(--border-color\)\s*90%,\s*var\(--text-primary\)\s*10%\s*\)/
    );
    expect(focusVisibleCss).toMatch(/0 0 0 1\.5px var\(--focus-visible-ring\)/);
  });

  it('形态 ③ 防御：标准原子 Input 必须保持微圆角与 Design Token 色板，严禁原生硬黑框', () => {
    const inputCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/ui/Input/Input.module.css'),
      'utf-8'
    );
    expect(inputCss).toContain('border: 1px solid var(--border-subtle);');
    // 兜底清零（B6-T18 / 提交 45a9dce56）后：消费面零字面量兜底，真值单点在 tokens.css
    expect(inputCss).toContain('border-radius: var(--radius-md);');
    expect(inputCss).not.toMatch(/border-radius:\s*var\(--radius-md\s*,/);
    expect(inputCss).toMatch(/\.input:focus[^{]*\{[^}]*box-shadow:\s*none;/);
  });

  it('形态 ③ 防御：标准原子 Textarea 必须保持微圆角与 Design Token 细边框，严禁原生硬黑框', () => {
    const textareaCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/ui/Input/Textarea.module.css'),
      'utf-8'
    );
    expect(textareaCss).toContain('border: 1px solid var(--border-subtle);');
    expect(textareaCss).toContain('border-radius: var(--radius-md);');
    expect(textareaCss).not.toMatch(/border-radius:\s*var\(--radius-md\s*,/);
    expect(textareaCss).toMatch(
      /\.nativeTextarea:focus[^{]*\{[^}]*box-shadow:\s*none;/
    );
  });

  // --- AST 守卫刚性拦截单元测试 ---
  it('AST 刚性拦截：焦点态混入大于 10% 文本纯黑（如 40%、60% 文本色焦点环）必须被 100% 阻断', () => {
    const violations60 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);
    `);
    expect(violations60.length).toBeGreaterThan(0);
    expect(
      violations60.some(
        (v) => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 60
      )
    ).toBe(true);

    const violations40 = analyzeFocusDarkMix(`
      border-color: color-mix(in srgb, var(--border-color) 60%, var(--text-primary) 40%);
    `);
    expect(violations40.length).toBeGreaterThan(0);
    expect(
      violations40.some(
        (v) => v.type === 'COLOR_MIX_EXCEEDS_10' && v.percent === 40
      )
    ).toBe(true);

    const rawViolations = analyzeFocusDarkMix(`
      border: 1px solid var(--text-primary);
    `);
    expect(rawViolations.length).toBeGreaterThan(0);
    expect(rawViolations.some((v) => v.type === 'RAW_DARK_BORDER')).toBe(true);

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
    expect(
      violations3px.some(
        (v) => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 3
      )
    ).toBe(true);

    const violations2px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 2px #000;
    `);
    expect(violations2px.length).toBeGreaterThan(0);
    expect(
      violations2px.some(
        (v) => v.type === 'SHADOW_EXCEEDS_1_5PX' && v.spread === 2
      )
    ).toBe(true);

    const allowed1_5px = analyzeBoxShadowSpread(`
      box-shadow: 0 0 0 1px var(--bg-card), 0 0 0 1.5px var(--focus-visible-ring);
    `);
    expect(allowed1_5px).toEqual([]);

    const allowedNone = analyzeBoxShadowSpread(`
      box-shadow: none;
    `);
    expect(allowedNone).toEqual([]);
  });

  it('T22 阴影语义精确化：spread/同心光晕拦截，带偏移柔投影放行', () => {
    // 带偏移的柔和投影（offsetY=4, blur=8, 无 spread）：不是外扩环 → 放行
    const offsetSoft = analyzeBoxShadowSpread(`
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.12);
    `);
    expect(offsetSoft).toEqual([]);

    // 同心光晕（offset 均为 0 且 blur > 1.5px）：外扩光晕 → 拦截
    const concentricGlow = analyzeBoxShadowSpread(`
      box-shadow: 0 0 8px rgba(0, 0, 0, 0.25);
    `);
    expect(concentricGlow.length).toBeGreaterThan(0);
    expect(concentricGlow[0].spread).toBe(8);

    // 多段阴影：环段（第二段 spread=3）拦截，柔段不影响
    const mixed = analyzeBoxShadowSpread(`
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1), 0 0 0 3px var(--focus-visible-ring);
    `);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed[0].spread).toBe(3);

    // spread ≤ 1.5px 的偏移投影：放行
    const smallSpread = analyzeBoxShadowSpread(`
      box-shadow: 0 1px 2px 1px rgba(0, 0, 0, 0.08);
    `);
    expect(smallSpread).toEqual([]);

    // 负偏移（-2px 2px 6px）：有偏移即非同心，blur 不构成外扩 → 放行
    const negativeOffset = analyzeBoxShadowSpread(`
      box-shadow: -2px 2px 6px rgba(0, 0, 0, 0.15);
    `);
    expect(negativeOffset).toEqual([]);
  });

  it('AST 刚性拦截：强制形态 ④（搜索/筛选输入框）必须为无边框极简型，浅灰边框（如 border: 1px solid var(--border-color)）与深色焦点外框必须被刚性拦截报错', () => {
    // 1. 浅灰边框 (border: 1px solid var(--border-color)) 即使属于微弱 Design Token，在形态 ④ 中亦必须被 100% 刚性阻断
    const grayBorderViolation = analyzeFormFourMinimalist(
      '.searchInput',
      `
      border: 1px solid var(--border-color);
      background: transparent;
    `
    );
    expect(grayBorderViolation.length).toBeGreaterThan(0);
    expect(
      grayBorderViolation.some(
        (v) =>
          v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER' &&
          v.snippet.includes('var(--border-color)')
      )
    ).toBe(true);

    const titleGrayBorderViolation = analyzeFormFourMinimalist(
      '.titleInput',
      `
      border: 1px solid var(--border-color);
      background: transparent;
    `
    );
    expect(titleGrayBorderViolation.length).toBeGreaterThan(0);
    expect(
      titleGrayBorderViolation.some(
        (v) =>
          v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER' &&
          v.snippet.includes('var(--border-color)')
      )
    ).toBe(true);

    const focusGrayBorderViolation = analyzeFormFourMinimalist(
      '.searchInput:focus',
      `
      border: 1px solid var(--border-color);
    `
    );
    expect(focusGrayBorderViolation.length).toBeGreaterThan(0);
    expect(
      focusGrayBorderViolation.some(
        (v) => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER'
      )
    ).toBe(true);

    // 2. 独立 border-color: var(--border-color) 浅灰边框色声明必须被阻断
    const borderColorViolation = analyzeFormFourMinimalist(
      '.titleInput',
      `
      border-color: var(--border-color);
    `
    );
    expect(borderColorViolation.length).toBeGreaterThan(0);
    expect(
      borderColorViolation.some(
        (v) => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER_COLOR'
      )
    ).toBe(true);

    // 3. var(--border-subtle) 微弱细边框亦被刚性阻断
    const borderViolation = analyzeFormFourMinimalist(
      '.searchInput',
      `
      border: 1px solid var(--border-subtle);
      background: transparent;
    `
    );
    expect(borderViolation.length).toBeGreaterThan(0);
    expect(
      borderViolation.some((v) => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER')
    ).toBe(true);

    // 4. 可见 outline: 1px solid var(--border-color) 被刚性阻断
    const outlineViolation = analyzeFormFourMinimalist(
      '.searchInput',
      `
      outline: 1px solid var(--border-color);
    `
    );
    expect(outlineViolation.length).toBeGreaterThan(0);
    expect(
      outlineViolation.some((v) => v.type === 'FORM_FOUR_VISIBLE_OUTLINE')
    ).toBe(true);

    // 5. 焦点态外框阴影投影必须被刚性阻断
    const focusShadowViolation = analyzeFormFourMinimalist(
      '.searchInput:focus',
      `
      box-shadow: 0 0 0 1.5px var(--focus-border-color);
    `
    );
    expect(focusShadowViolation.length).toBeGreaterThan(0);
    expect(
      focusShadowViolation.some((v) => v.type === 'FORM_FOUR_FOCUS_SHADOW')
    ).toBe(true);

    const titleFocusShadowViolation = analyzeFormFourMinimalist(
      '.titleInput:focus',
      `
      box-shadow: 0 0 0 1px var(--border-color);
    `
    );
    expect(titleFocusShadowViolation.length).toBeGreaterThan(0);
    expect(
      titleFocusShadowViolation.some((v) => v.type === 'FORM_FOUR_FOCUS_SHADOW')
    ).toBe(true);

    // 6. 纯光标极简型（全态 border: none; box-shadow: none; outline: none; background: transparent;）100% 合规放行
    const cleanFormFour = analyzeFormFourMinimalist(
      '.searchInput:focus',
      `
      border: none;
      box-shadow: none;
      outline: none;
      background: transparent;
    `
    );
    expect(cleanFormFour).toEqual([]);

    const cleanTitleInput = analyzeFormFourMinimalist(
      '.titleInput',
      `
      background: transparent;
      border: none;
      outline: none;
      box-shadow: none;
    `
    );
    expect(cleanTitleInput).toEqual([]);
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
      background-color: var(--state-hover);
      border-color: var(--border-subtle);
    `);
    expect(cleanButtonActive).toEqual([]);
  });

  it('形态 ④ 防御：笔记纸面行内标题输入框全态（常态/聚焦态）无边框、无阴影、透明底色刚性契约 (NotePaperPanel.module.css 与 EditableTitle.tsx)', () => {
    const notePaperCss = fs.readFileSync(
      path.resolve(
        desktopSrc,
        'components/note-paper/NotePaperPanel.module.css'
      ),
      'utf-8'
    );

    // 1. 常态契约：必须显式声明透明底色、无边框、无阴影、无轮廓
    expect(notePaperCss).toMatch(
      /\.titleInput[^{]*\{[^}]*background:\s*transparent/
    );
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*border:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*outline:\s*none/);
    expect(notePaperCss).toMatch(/\.titleInput[^{]*\{[^}]*box-shadow:\s*none/);

    // 严禁常态声明非透明边框、边框色或阴影环
    expect(notePaperCss).not.toMatch(/\.titleInput[^{]*\{[^}]*border:\s*1px/);
    expect(notePaperCss).not.toMatch(/\.titleInput[^{]*\{[^}]*border-color:/);
    expect(notePaperCss).not.toMatch(
      /\.titleInput[^{]*\{[^}]*box-shadow:\s*0\s+0/
    );

    // 2. 聚焦全态契约：:focus 与 :focus-visible 显式声明，保持全态无框无阴影纯光标
    expect(notePaperCss).toContain('.titleInput:focus');
    expect(notePaperCss).toContain('.titleInput:focus-visible');
    expect(notePaperCss).toMatch(
      /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/
    );
    expect(notePaperCss).toMatch(
      /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*outline:\s*none/
    );
    expect(notePaperCss).toMatch(
      /\.titleInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/
    );

    // 严禁聚焦态产生焦点外框阴影、边框颜色或突变背景底色
    expect(notePaperCss).not.toMatch(
      /\.titleInput:focus[^{]*\{[^}]*border(?:-color)?:\s*(?:1px|\d|var\()/
    );
    expect(notePaperCss).not.toMatch(
      /\.titleInput:focus[^{]*\{[^}]*box-shadow:\s*(?:0|\d|var\()/
    );
    expect(notePaperCss).not.toMatch(
      /\.titleInput:focus[^{]*\{[^}]*background(?:-color)?:\s*(?:#|rgb|var\()/
    );

    // 3. AST 规则级全态解析：NotePaperPanel.module.css 中所有 .titleInput 规则必须 0 违规
    const rules = extractCssRules(notePaperCss);
    const titleRules = rules.filter((r) => r.selector.includes('.titleInput'));
    expect(titleRules.length).toBeGreaterThanOrEqual(2);

    for (const rule of titleRules) {
      const violations = analyzeFormFourMinimalist(rule.selector, rule.body);
      expect(violations).toEqual([]);

      const darkMixViolations = analyzeFocusDarkMix(rule.body);
      expect(darkMixViolations).toEqual([]);

      const shadowViolations = analyzeBoxShadowSpread(rule.body);
      expect(shadowViolations).toEqual([]);
    }

    // 4. AST 刚性拦截防线校验：若标题输入框被意外注入浅灰边框或阴影，必须被 100% 拦截
    const tamperedBorder = analyzeFormFourMinimalist(
      '.titleInput',
      'border: 1px solid var(--border-color); background: transparent;'
    );
    expect(tamperedBorder.length).toBeGreaterThan(0);
    expect(
      tamperedBorder.some((v) => v.type === 'FORM_FOUR_NON_TRANSPARENT_BORDER')
    ).toBe(true);

    const tamperedShadow = analyzeFormFourMinimalist(
      '.titleInput:focus',
      'box-shadow: 0 0 0 1.5px var(--focus-border-color);'
    );
    expect(tamperedShadow.length).toBeGreaterThan(0);
    expect(
      tamperedShadow.some((v) => v.type === 'FORM_FOUR_FOCUS_SHADOW')
    ).toBe(true);

    // 5. TSX 结构契约 (EditableTitle.tsx)
    const editableTitleTsx = fs.readFileSync(
      path.resolve(desktopSrc, 'components/note-paper/EditableTitle.tsx'),
      'utf-8'
    );
    expect(editableTitleTsx).toContain('className={styles.titleInput}');
    expect(editableTitleTsx).toMatch(
      /<(?:Input|input)[^>]*className=\{styles\.titleInput\}/
    );
    expect(editableTitleTsx).toContain(
      'data-testid="note-paper-strict-title-input"'
    );
    // 严禁 TSX 内联非透明边框、阴影或底色
    expect(editableTitleTsx).not.toMatch(
      /style=\{\{[^}]*border:\s*['"](?:1px|\d|#|rgb|var)/i
    );
    expect(editableTitleTsx).not.toMatch(
      /style=\{\{[^}]*boxShadow:\s*['"](?:0|\d|#|rgb|var)/i
    );
  });

  it('形态 ③ / 卡片提交输入框防御：DiffCard 提交输入框 (.commitInput 与 DiffCardGitActions) 必须保持微圆角与克制软灰焦点态', () => {
    const diffCardCss = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCard.module.css'),
      'utf-8'
    );
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*box-shadow:\s*none/);
    expect(diffCardCss).toMatch(/\.commitInput[^{]*\{[^}]*outline:\s*none/);
    expect(diffCardCss).toMatch(
      /\.commitInput[^{]*\{[^}]*border-radius:\s*var\(--radius-(?:sm|md)(?:\s*,\s*(?:4|6)px)?\)/
    ); // 兜底可选（P2-5 清退）
    expect(diffCardCss).toMatch(
      /\.commitInput[^{]*\{[^}]*border:\s*1px solid color-mix/
    );
    expect(diffCardCss).toContain('.commitInput:focus');
    expect(diffCardCss).toContain('.commitInput:focus-visible');
    expect(diffCardCss).toMatch(
      /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*box-shadow:\s*none/
    );
    expect(diffCardCss).toMatch(
      /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*outline:\s*none/
    );
    expect(diffCardCss).toMatch(
      /\.commitInput:(?:focus-visible|focus)[^{]*\{[^}]*border-color:\s*color-mix\([^}]*?var\(--text-primary\)\s*(?:[1-9]|10)%\s*\)/
    );

    const gitActionsTsx = fs.readFileSync(
      path.resolve(desktopSrc, 'components/diff/DiffCardGitActions.tsx'),
      'utf-8'
    );
    expect(gitActionsTsx).toContain('className={styles.commitInput}');
  });

  it('AST 刚性拦截与 isInputSelector 正则全覆盖：覆盖 input, textarea, :global(input), div > input, .titleInput, .customInput, [type="text"] 等全部正向用例，并反向排除容器与非文本控件', () => {
    // 1. 正向用例覆盖：原生标签 (input, textarea)、全局伪类 (:global(input))、组合选择器 (div > input)、驼峰类名 (.titleInput, .customInput) 与属性选择器 ([type="text"]) 等
    const validInputs = [
      'input',
      'textarea',
      ':global(input)',
      ':global(textarea)',
      'input:focus',
      'textarea:focus',
      ':global(input):focus',
      ':global(input):focus-visible',
      'div > input',
      'div > textarea',
      'section > input',
      'form > .titleInput',
      '.titleInput',
      '.titleInput:focus',
      '.customInput',
      '.commitInput',
      '.commitInput:focus-visible, .commitInput:focus',
      '.searchInput',
      '.tagInput',
      '.filterInput',
      '.textInput',
      '.searchField',
      '.inputField',
      '.cellInput',
      '.nativeTextarea',
      '.schedFieldInput',
      '.firstRunInput',
      '.chipsInput',
      '.comboboxInput',
      '.inputSearch',
      '[type="text"]',
      '[type="search"]',
      "[type='text']",
      '[type=search]',
      '[role="searchbox"]',
      'input[type="text"]',
      'input[type="search"]',
      'div > [type="text"]',
      '.card .commitInput:focus',
      "[type='search']:focus-visible",
      '[type=text]:focus',
      ':is(input, textarea)',
      ':is(.titleInput, .commitInput)',
      ':is([type="text"], [type="search"])',
      ".navItem input[type='search']",
      'textarea.commitInput',
      'input.titleInput',
    ];
    for (const sel of validInputs) {
      expect(isInputSelector(sel)).toBe(true);
    }

    // 2. 反向排除用例覆盖：容器外壳 (Wrapper/Container/Shell/Row/Group/Icon/Btn) 与非文本控件 (checkbox/radio/file/button/submit/range/color/hidden/image)
    const nonInputs = [
      // 容器与外壳类
      '.inputWrapper',
      '.inputContainer',
      '.inputShell',
      '.inputRow',
      '.inputGroup',
      '.inputHeader',
      '.searchRow',
      '.searchIcon',
      '.searchClearBtn',
      '.searchContainer',
      '.searchWrapper',
      '.searchBoxWrapper',
      '.searchHeader',
      // 非文本表单控件类 (带 input 标签或纯属性)
      'input[type="checkbox"]',
      'input[type="radio"]',
      'input[type="file"]',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="range"]',
      'input[type="color"]',
      'input[type="hidden"]',
      'input[type="image"]',
      '[type="checkbox"]',
      '[type="radio"]',
      '[type="file"]',
      '[type="button"]',
      '[type="submit"]',
      '[type="range"]',
      '[type="color"]',
      '[type="hidden"]',
      '[type="image"]',
      'div > [type="checkbox"]',
      '.formGroup > input[type="radio"]',
      // 常规按钮与操作元素
      'button',
      '.btn',
      '.actionBtn',
    ];
    for (const sel of nonInputs) {
      expect(isInputSelector(sel)).toBe(false);
    }

    // 3. 验证属性选择器与驼峰类名输入框中的深色投影与超标混入会被 AST 分析器严格拦截
    const shadowViolation = analyzeBoxShadowSpread(
      'box-shadow: 0 0 0 3px #000;'
    );
    expect(shadowViolation.length).toBeGreaterThan(0);

    const darkMixViolation = analyzeFocusDarkMix(
      'border-color: color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%);'
    );
    expect(darkMixViolation.length).toBeGreaterThan(0);

    const formFourShadow = analyzeFormFourMinimalist(
      '.titleInput:focus',
      'box-shadow: 0 0 0 1.5px var(--focus-border-color);'
    );
    expect(formFourShadow.length).toBeGreaterThan(0);
  });

  it('形态 ④ 防御：会话与侧边栏行内重命名输入框全态无边框、无阴影、透明底色刚性契约 (SessionInlineRename.module.css 与 SidebarSessionList.module.css)', () => {
    const sessionRenameCss = fs.readFileSync(
      path.resolve(
        desktopSrc,
        'components/chat-card/SessionInlineRename.module.css'
      ),
      'utf-8'
    );
    expect(sessionRenameCss).toMatch(
      /\.renameInput[^{]*\{[^}]*background:\s*transparent/
    );
    expect(sessionRenameCss).toMatch(/\.renameInput[^{]*\{[^}]*border:\s*none/);
    expect(sessionRenameCss).toMatch(
      /\.renameInput[^{]*\{[^}]*outline:\s*none/
    );
    expect(sessionRenameCss).toMatch(
      /\.renameInput[^{]*\{[^}]*box-shadow:\s*none/
    );
    expect(sessionRenameCss).toMatch(
      /\.renameInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/
    );
    expect(sessionRenameCss).toMatch(
      /\.renameInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/
    );

    const sidebarListCss = fs.readFileSync(
      path.resolve(
        desktopSrc,
        'components/sidebar/SidebarSessionList.module.css'
      ),
      'utf-8'
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput[^{]*\{[^}]*background:\s*transparent/
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput[^{]*\{[^}]*border:\s*none/
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput[^{]*\{[^}]*outline:\s*none/
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput[^{]*\{[^}]*box-shadow:\s*none/
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput:focus(?:-visible)?[^{]*\{[^}]*border:\s*none/
    );
    expect(sidebarListCss).toMatch(
      /\.sessionRenameInput:focus(?:-visible)?[^{]*\{[^}]*box-shadow:\s*none/
    );
  });

  it('容器联动防御：承载形态 ④ 的容器（如 .titleContainer, .renameContainer）严禁声明 border 与 box-shadow', () => {
    // 1. 容器声明 border 必须被拦截
    const borderViolation = analyzeFormFourContainer(
      '.renameContainer',
      'border: 1px solid var(--border-color);'
    );
    expect(borderViolation.length).toBeGreaterThan(0);
    expect(
      borderViolation.some((v) => v.type === 'FORM_FOUR_CONTAINER_BORDER')
    ).toBe(true);

    // 2. 容器声明 box-shadow 必须被拦截
    const shadowViolation = analyzeFormFourContainer(
      '.titleContainer',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.1);'
    );
    expect(shadowViolation.length).toBeGreaterThan(0);
    expect(
      shadowViolation.some((v) => v.type === 'FORM_FOUR_CONTAINER_SHADOW')
    ).toBe(true);

    // 3. 容器合规声明放行
    const cleanContainer = analyzeFormFourContainer(
      '.renameContainer',
      'display: flex; align-items: center; background: transparent;'
    );
    expect(cleanContainer).toEqual([]);

    // 4. 选择器判定断言
    expect(isFormFourContainerSelector('.titleContainer')).toBe(true);
    expect(isFormFourContainerSelector('.renameContainer')).toBe(true);
    expect(isFormFourContainerSelector('.titleWrapper')).toBe(true);
    expect(isFormFourContainerSelector('.inputField')).toBe(false);
  });

  it('AST 刚性拦截：形态 ④ 基础规则缺失 4 个强制声明（border: none, background: transparent, box-shadow: none, outline: none）时必须报错', () => {
    // 缺少 border: none
    const missingBorder = analyzeFormFourMinimalist(
      '.titleInput',
      'background: transparent; box-shadow: none; outline: none;'
    );
    expect(
      missingBorder.some((v) => v.type === 'FORM_FOUR_MISSING_BORDER_NONE')
    ).toBe(true);

    // 缺少 background: transparent
    const missingBg = analyzeFormFourMinimalist(
      '.titleInput',
      'border: none; box-shadow: none; outline: none;'
    );
    expect(
      missingBg.some((v) => v.type === 'FORM_FOUR_MISSING_TRANSPARENT_BG')
    ).toBe(true);

    // 缺少 box-shadow: none
    const missingShadow = analyzeFormFourMinimalist(
      '.titleInput',
      'border: none; background: transparent; outline: none;'
    );
    expect(
      missingShadow.some((v) => v.type === 'FORM_FOUR_MISSING_BOX_SHADOW_NONE')
    ).toBe(true);

    // 缺少 outline: none
    const missingOutline = analyzeFormFourMinimalist(
      '.titleInput',
      'border: none; background: transparent; box-shadow: none;'
    );
    expect(
      missingOutline.some((v) => v.type === 'FORM_FOUR_MISSING_OUTLINE_NONE')
    ).toBe(true);

    // 4项齐全放行
    const complete = analyzeFormFourMinimalist(
      '.titleInput',
      'border: none; background: transparent; box-shadow: none; outline: none;'
    );
    expect(complete).toEqual([]);
  });

  it('AST 刚性拦截：默认边框未重置拦截分析器 (analyzeMissingBorderReset) 拦截漏写 border 的视觉样式规则', () => {
    // 定义了视觉外观但漏写 border 声明 -> 报错
    const violation = analyzeMissingBorderReset(
      '.customInput',
      'height: 32px; padding: 0 8px; background: var(--bg-card);'
    );
    expect(violation.length).toBeGreaterThan(0);
    expect(violation.some((v) => v.type === 'MISSING_BORDER_RESET')).toBe(true);

    // 声明了 border: none -> 放行
    const cleanNone = analyzeMissingBorderReset(
      '.customInput',
      'height: 32px; padding: 0 8px; border: none;'
    );
    expect(cleanNone).toEqual([]);

    // 声明了规范边框 -> 放行
    const cleanBorder = analyzeMissingBorderReset(
      '.customInput',
      'height: 32px; padding: 0 8px; border: 1px solid var(--border-subtle);'
    );
    expect(cleanBorder).toEqual([]);

    // 伪类状态忽略
    const focusState = analyzeMissingBorderReset(
      '.customInput:focus',
      'color: var(--text-primary);'
    );
    expect(focusState).toEqual([]);
  });

  it('选择器判定契约：isFormFourSelector 全覆盖搜索/筛选/行内重命名输入框', () => {
    const formFourSelectors = [
      '.searchInput',
      '.searchField',
      '.titleInput',
      '.renameInput',
      '.sessionRenameInput',
      '.inlineRename',
      '.diffSearch',
      '.filesPathFilter',
      '.pathFilter',
      '.fileFilter',
      '#searchbox',
    ];
    for (const sel of formFourSelectors) {
      expect(isFormFourSelector(sel)).toBe(true);
    }

    // 排除容器与按钮
    const nonFormFour = [
      '.searchIcon',
      '.searchClearBtn',
      '.searchWrapper',
      '.searchContainer',
      '.searchHeader',
      '.titleContainer',
      '.renameContainer',
    ];
    for (const sel of nonFormFour) {
      expect(isFormFourSelector(sel)).toBe(false);
    }
  });

  it('全仓刚性守护：自动化静态守门脚本 check-input-guardrails.mjs 必须 100% 通过（0 错误）', () => {
    const stdout = execSync('node scripts/check-input-guardrails.mjs', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(stdout).toContain('全仓输入框四态体系防倒退检查 100% 通过');
  });
});

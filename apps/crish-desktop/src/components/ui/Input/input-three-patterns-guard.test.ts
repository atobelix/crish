import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * 输入框四态体系守门防御契约 (Input Four-Patterns Guard Contract)
 *
 * 用户刚性裁决：全系统严格仅允许四种输入框形态，永久封死，严禁出现第五种：
 * 1. 形态 ①【侧边栏无边框纯净型】（图 1 标号 ①）：常态 background: transparent, border: none, box-shadow: none
 * 2. 形态 ②【主对话底栏胶囊型】（图 1 标号 ②）：ChatComposer 消息发送输入条
 * 3. 形态 ③【标准卡片表单原子型】（图 2 标号 ③）：基于 ui/Input 的标准卡片输入框 (Base URL, API Key, 模型列表等)
 * 4. 形态 ④【内联浮层/下拉菜单搜索框（纯光标极简型）】（图 3 标号 ④）：ModelBadgePickerMenu 等，只有光标闪烁，其他什么变化也没有！
 */
describe('输入框四态体系刚性防御契约', () => {
  const desktopSrc = path.resolve(__dirname, '../../..');

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
  });

  it('全局防御：focus-visible.css 必须阻断全局焦点阴影对形态 ① 与形态 ④ 的穿透污染', () => {
    const focusVisibleCss = fs.readFileSync(
      path.resolve(desktopSrc, 'styles/focus-visible.css'),
      'utf-8'
    );
    expect(focusVisibleCss).toMatch(/role=['"]search['"][\s\S]*?role=['"]menu['"][\s\S]*?role=['"]listbox['"]/);
    expect(focusVisibleCss).toContain('box-shadow: none !important;');
    expect(focusVisibleCss).toContain('.searchInput:is(:focus, :focus-visible)');
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
});

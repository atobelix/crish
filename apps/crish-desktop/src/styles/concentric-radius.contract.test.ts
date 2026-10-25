// @vitest-environment jsdom
/**
 * 契约测试：全仓同心圆角与微圆双形态自动化防回归测试 (CONCENTRIC-RADIUS-UNIFICATION)
 *
 * 规范依据：
 * - 00-全仓同心圆角与微圆双形态统一改造总方案.md
 * - 06-master-plan-review-and-guardrails.md §5.3
 * - 01-token-architecture-and-concentric-math-plan.md
 * - 同心公理：R_outer = R_inner + Padding <=> R_inner = max(0, R_outer - Padding)
 * - 双形态：
 *     圆角形态（Rounded Mode）：20px 顶级枢纽（Dialog / Settings / ProjectManageModal / ChatComposer）
 *     微圆形态（Compact Mode）：14px 浮层 / 16px 卡片 / 8px 控件 / 6px 小项 / 7px 独立按钮
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '..');

function readDesktopFile(...segments: string[]): string {
  const fullPath = resolve(srcDir, ...segments);
  if (!existsSync(fullPath)) {
    throw new Error(`[concentric-contract] Target file not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf8');
}

describe('CONCENTRIC-RADIUS-UNIFICATION 同心契约自动化防回归测试', () => {
  // 1. Token 完备性与 --radius-2xl 断言
  it('契约 1：Token 完备性与 --radius-2xl 平反断言', () => {
    const tokens = readDesktopFile('styles', 'tokens.css');

    // 1.1 断言 --radius-2xl 必须定义为 20px（严禁为 12px 或 var(--radius-l)）
    expect(tokens, 'tokens.css 必须显式声明 --radius-2xl: 20px;').toMatch(
      /--radius-2xl:\s*20px;/
    );
    expect(
      tokens,
      'tokens.css 严禁将 --radius-2xl 映射为 var(--radius-l)'
    ).not.toMatch(/--radius-2xl:\s*var\(--radius-l\);/);
    expect(
      tokens,
      'tokens.css 严禁将 --radius-2xl 定义为 12px 坍塌值'
    ).not.toMatch(/--radius-2xl:\s*12px;/);

    // 1.2 断言 --sep-radius-outer 必须为 14px
    expect(tokens, 'tokens.css 必须显式声明 --sep-radius-outer: 14px;').toMatch(
      /--sep-radius-outer:\s*14px;/
    );

    // 1.3 断言 --radius-sm 必须为 6px，--radius-xl 必须为 16px
    expect(
      tokens,
      'tokens.css 必须定义 --radius-sm: 6px; 补齐偶数闭包'
    ).toMatch(/--radius-sm:\s*6px;/);
    expect(
      tokens,
      'tokens.css 必须定义 --radius-xl: 16px; 补齐卡片外壳阶梯'
    ).toMatch(/--radius-xl:\s*16px;/);
  });

  // 2. 全仓 9996px 荒谬算式清零断言
  it('契约 2：全仓 9996px 荒谬算式清零断言（禁止 pill 变量参与数学减法）', () => {
    const tokens = readDesktopFile('styles', 'tokens.css');

    // 拦截任何使用 calc(var(--radius-pill) - 3px) 或类似将 pill 扣减成 9996px 的代码
    expect(
      tokens,
      'tokens.css 严禁出现 calc(var(--radius-pill) - ...) 扣减算式'
    ).not.toMatch(/calc\(\s*var\(--radius-pill\)\s*-\s*[^)]+\)/);

    expect(
      tokens,
      'tokens.css 严禁出现 calc(var(--usage-capsule-outer-radius) - ...) 扣减算式'
    ).not.toMatch(/calc\(\s*var\(--usage-capsule-outer-radius\)\s*-\s*[^)]+\)/);

    // 剥离注释后断言绝不存在 9996px 声明代码
    const codeWithoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(
      codeWithoutComments,
      'tokens.css 代码中严禁出现 9996px 荒谬声明'
    ).not.toMatch(/9996px/);
  });

  // 3. 模型凭据卡防倒挂断言
  it('契约 3：模型凭据卡防倒挂断言（.credentialsContainer 严禁消费 7px 按钮圆角，必须为 14px 或以上）', () => {
    const modelsCss = readDesktopFile(
      'components',
      'settings-models',
      'ModelsSettingsTab.module.css'
    );

    const match = modelsCss.match(/\.credentialsContainer\s*\{[^}]+\}/);
    expect(
      match,
      'ModelsSettingsTab.module.css 中必须包含 .credentialsContainer 规则块'
    ).toBeTruthy();
    const block = match![0];

    // 断言严禁消费 --button-radius（7px）
    expect(
      block,
      '.credentialsContainer 严禁消费 var(--button-radius)'
    ).not.toContain('var(--button-radius)');
    expect(block, '.credentialsContainer 严禁直接定义为 7px').not.toMatch(
      /border-radius:\s*7px/
    );

    // 断言必须为 14px 或以上（如 var(--radius-xl, 14px)）
    const radiusDecl = block.match(/border-radius:\s*([^;]+);/);
    expect(
      radiusDecl,
      '.credentialsContainer 必须声明 border-radius'
    ).toBeTruthy();
    expect(
      /(?:1[4-9]|[2-9][0-9])px|var\(--radius-xl/.test(radiusDecl![1]),
      `.credentialsContainer 的 border-radius 必须为 14px 或以上（当前声明: ${radiusDecl![1]}）`
    ).toBe(true);
  });

  // 4. ProjectManageModal 同心断言
  it('契约 4：ProjectManageModal 同心断言（.modalPanel 必须为 20px，.folderPickerDropzone 必须为 10px）', () => {
    const modalCss = readDesktopFile(
      'components',
      'sidebar',
      'session-list',
      'ProjectManageModal.module.css'
    );

    // 断言 .modalPanel 必须为 var(--radius-2xl, 20px)
    const panelMatch = modalCss.match(/\.modalPanel\s*\{[^}]+\}/);
    expect(
      panelMatch,
      'ProjectManageModal.module.css 中必须包含 .modalPanel 规则块'
    ).toBeTruthy();
    expect(
      panelMatch![0],
      '.modalPanel 的 border-radius 必须绑定为 var(--radius-2xl, 20px)'
    ).toMatch(/border-radius:\s*var\(--radius-2xl,\s*20px\)/);

    // 断言 .folderPickerDropzone 必须为 10px
    const dropzoneMatch = modalCss.match(/\.folderPickerDropzone\s*\{[^}]+\}/);
    expect(
      dropzoneMatch,
      'ProjectManageModal.module.css 中必须包含 .folderPickerDropzone 规则块'
    ).toBeTruthy();
    expect(
      dropzoneMatch![0],
      '.folderPickerDropzone 的 border-radius 必须为 10px，与 10px 内衬达成 20px 同心'
    ).toMatch(/border-radius:\s*10px/);
  });

  // 5. 通用 Dialog 外壳断言
  it('契约 5：通用 Dialog 外壳断言（.dialog 必须包含 var(--radius-2xl）', () => {
    const dialogCss = readDesktopFile(
      'components',
      'ui',
      'Dialog',
      'Dialog.module.css'
    );

    const dialogMatch = dialogCss.match(/\.dialog\s*\{[^}]+\}/);
    expect(
      dialogMatch,
      'Dialog.module.css 中必须包含 .dialog 规则块'
    ).toBeTruthy();
    expect(
      dialogMatch![0],
      '.dialog 的 border-radius 必须包含 var(--radius-2xl'
    ).toMatch(/border-radius:\s*var\(--radius-2xl/);
  });

  // 6. ChatComposer 多行与单行零位移契约断言
  it('契约 6：ChatComposer 多行与单行零位移契约断言（.composerCard.isMultiline 绑定 20px 圆角）', () => {
    const composerCss = readDesktopFile(
      'components',
      'chat-composer',
      'ChatComposer.module.css'
    );

    const multilineMatch = composerCss.match(
      /\.composerCard\.isMultiline\s*\{[^}]+\}/
    );
    expect(
      multilineMatch,
      'ChatComposer.module.css 中必须包含 .composerCard.isMultiline 规则块'
    ).toBeTruthy();
    const multilineBlock = multilineMatch![0];

    // 断言多行形态外圆角必须为 20px
    expect(
      multilineBlock,
      '.composerCard.isMultiline 必须绑定 20px 圆角'
    ).toMatch(/border-radius:\s*var\(--composer-radius-multi,\s*20px\)/);
  });
});

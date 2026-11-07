/**
 * 视觉红线断言（40 方案 §4 token 映射表 / §4.2 红线 1-6 / P6 T6-7）：
 * 以源码文本直检 chat-composer 域 CSS，防止硬编码色值 / 阴影 / z-index /
 * 位移动效 / 高对比度 mix 回流。
 * - 零阴影：box-shadow 仅允许 none（!important 可附）；
 * - 无硬编码色：hex / rgb() / rgba() 零命中；
 * - z-index 只走 var(--z-popover)，无字面量 200；
 * - 焦点混色 ≤10%（border-color mix ≥90%），session-empty 落地面 ≤5%（border-color mix ≥95%）特例存在；
 * - 占位符走 text-tertiary token；无 transform 位移入场；无 will-change 滥用。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const STRICT_CSS = [
  'TiptapEditorField.module.css',
  'TiptapSlashMenu.module.css',
].map((f) => ({
  name: f,
  css: readFileSync(join(here, f), 'utf8'),
}));

const HOST_CSS_FILES = [
  'ChatComposer.module.css',
  'ComposerPlanProgressBar.module.css',
  'ComposerAttachmentBar.module.css',
  'AnnotationChipItem.module.css',
  'ComposerSendControls.module.css',
  'ComposerEmbeddedNotice.module.css',
  'ComposerFusedTrigger.module.css',
  'ComposerDirTree.module.css',
].map((name) => ({
  name,
  css: readFileSync(join(here, name), 'utf8'),
}));

const HOST_CSS = HOST_CSS_FILES[0]!;

describe('chat-composer 视觉红线（T10 & P6）', () => {
  for (const { name, css } of STRICT_CSS) {
    it(`${name}：零阴影（box-shadow 仅 none）`, () => {
      for (const line of css.split('\n')) {
        const m = line.match(/box-shadow:\s*([^;]+);/);
        if (m) {
          expect(m[1].trim(), `非 none 阴影：${line.trim()}`).toMatch(
            /^none(?:\s+!important)?$/
          );
        }
      }
    });

    it(`${name}：无硬编码色值（hex/rgb/rgba）`, () => {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css).not.toMatch(/rgba?\(/);
    });

    it(`${name}：z-index 无字面量（token 化）`, () => {
      expect(css).not.toMatch(/z-index:\s*\d/);
    });

    it(`${name}：克制动效（编辑器无位移；斜杠菜单走微位移与 token 缓动）`, () => {
      if (name === 'TiptapSlashMenu.module.css') {
        // AN2 / A6 归队后：斜杠菜单不再自备 keyframes 与缓动，进出场统一走全域
        // 浮层配方（共享 crish-popover-* keyframes + popover token，缓动/时长在 token 内）
        // 【G² 第一波丙 · 槽 D】4 份本地副本已删：进/退场改走全局工具类
        // .crish-popover-anim（composes），token 与关键帧改由全局类本体承载，
        // 本文件只钉 composes 接线 + 全局类本体的 token/关键帧。
        expect(css).toContain('composes: crish-popover-anim from global');
        // 本地 keyframes 定义不得回潮；注意模块注释正文提及“@keyframes”
        // 一词（解释 composes 防悬空的缘由），故只钉“@keyframes <名> {”
        // 定义形态，不钉字面出现。
        expect(css).not.toMatch(/@keyframes\s+[A-Za-z0-9_-]+\s*\{/);
        expect(css).not.toMatch(/translateY\([1-9]\d+px\)/);
        const dsCss = readFileSync(
          join(here, '..', '..', 'styles', 'design-system.css'),
          'utf8'
        );
        expect(dsCss).toMatch(
          /\.crish-popover-anim\[data-state='open'\]\[data-positioned='true'\][\s\S]*?var\(--transition-popover-enter\)/
        );
        expect(dsCss).toMatch(
          /\.crish-popover-anim\[data-state='closed'\][\s\S]*?var\(--transition-popover-exit\)/
        );
        expect(dsCss).toMatch(/@keyframes\s+crish-popover-enter/);
      } else {
        expect(css).not.toMatch(/transform:/);
        expect(css).not.toMatch(/will-change/);
      }
    });
  }

  it('弹层 z-index 走 var(--z-popover)（TiptapSlashMenu.module.css）', () => {
    const popover = STRICT_CSS.find(
      (x) => x.name === 'TiptapSlashMenu.module.css'
    )!.css;
    expect(popover).toMatch(/var\(--z-popover\)/);
    expect(popover).not.toMatch(/z-index:\s*200\b/);
  });

  it('焦点混色 ≤10%（border-color mix ≥90%），跨域全检', () => {
    for (const { name, css } of [...STRICT_CSS, ...HOST_CSS_FILES]) {
      const mixes = css.match(/var\(--border-color\)\s+(\d+)%/g) ?? [];
      for (const mix of mixes) {
        const pct = Number(mix.match(/(\d+)%/)?.[1]);
        expect(pct, `${name} 混色 ${mix}`).toBeGreaterThanOrEqual(90);
      }
    }
  });

  it('占位符走 text-tertiary token（Placeholder 扩展伪元素）', () => {
    const editor = STRICT_CSS.find(
      (x) => x.name === 'TiptapEditorField.module.css'
    )!.css;
    const rule = editor.match(
      /\.proseMirrorField[^{]*is-editor-empty[^{]*\{[^}]*\}/
    )?.[0];
    expect(rule).toBeTruthy();
    expect(rule).toContain('var(--text-tertiary)');
  });

  it('落地面特例：session-empty 聚焦零变化（用户裁决 2026-11-07 覆盖 AGENTS.md §13 & T6-7 柔焦混色）', () => {
    // 旧特例（session-empty 焦点经 --edge-focus-empty 混色 3%）已被
    // 裁决取代：输入框全态静态，聚焦仅光标——宿主 CSS（注释剥离后）
    // 不得再有 --edge-focus 族变量，也不得有 session-empty 的
    // focus-within 油漆规则。
    const code = HOST_CSS.css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/--edge-focus/);
    expect(code).not.toMatch(
      /data-empty-kind=['"]session-empty['"][^{]*:focus/
    );
  });

  it('宿主域同样零硬编码色与 z-index 字面量（全 9 个模块）', () => {
    for (const { name, css } of HOST_CSS_FILES) {
      expect(css, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, name).not.toMatch(/z-index:\s*\d/);
    }
  });
});

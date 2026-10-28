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
        expect(css).toMatch(/var\(--ease-emphasized\)/);
        expect(css).toMatch(/scale\(0\.985\)/);
        expect(css).not.toMatch(/translateY\([1-9]\d+px\)/);
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

  it('落地面特例：session-empty 焦点混色 ≤5%（--edge-focus-empty 或 var(--border-color) ≥95%，AGENTS.md §13 & T6-7）', () => {
    expect(HOST_CSS.css).toMatch(
      /data-empty-kind=['"]session-empty['"][^{]*focus-within[^{]*\{[\s\S]*?(?:--edge-focus-empty|var\(--border-subtle\))/
    );
  });

  it('宿主域同样零硬编码色与 z-index 字面量（全 9 个模块）', () => {
    for (const { name, css } of HOST_CSS_FILES) {
      expect(css, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, name).not.toMatch(/z-index:\s*\d/);
    }
  });
});

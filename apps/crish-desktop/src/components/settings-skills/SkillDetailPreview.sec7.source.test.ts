/**
 * §7.4 技能预览：只走 MarkdownDocumentView；禁 previewHtml 死轨 / dangerouslySetInnerHTML 回潮。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname);

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}

describe('§7.4 skill preview no previewHtml dead track', () => {
  it('source: settings-skills has no previewHtml / parseMarkdownToHtml preview chain', () => {
    for (const f of [
      'useSkillEditor.ts',
      'useSkillsSettingsState.ts',
      'SkillsSettingsTab.tsx',
      'SkillDetailPreview.tsx',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/previewHtml/);
      expect(src, f).not.toMatch(/parseMarkdownToHtml/);
    }
  });

  it('source: SkillDetailPreview uses MarkdownDocumentView; no dangerouslySetInnerHTML', () => {
    const src = read('SkillDetailPreview.tsx');
    expect(src).toMatch(/MarkdownDocumentView/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

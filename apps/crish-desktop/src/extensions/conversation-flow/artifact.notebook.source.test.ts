/**
 * S7 源码钉：文档 chip → 叶内阅读面；代码仍 onOpenPath。
 * 无 document.body 阅读根；无 docId 不 persist；关插件无 Notebook。
 * ≠ 9222 真壳绿。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const DESKTOP_SRC = join(DIR, '../..');

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    const ext = extname(name);
    if (ext === '.ts' || ext === '.tsx' || ext === '.css') out.push(full);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(DIR, rel), 'utf8');
}

describe('S7 · Artifact Notebook 源码钉', () => {
  it('阅读面用 StreamingMarkdownView，不引入 markdown-editor / conex-mdx view', () => {
    const surface = read('ArtifactNotebookSurface.tsx');
    const chip = read('ArtifactChip.tsx');
    expect(surface).toMatch(/from\s+['"][^'"]*StreamingMarkdownView['"]/);
    expect(surface).toMatch(/data-artifact-md=["']async-markdown-block["']/);
    expect(surface).toMatch(/data-notebook-host=["']leaf-body["']/);
    expect(chip).not.toMatch(/onOpenPath\s*[=:(]/);
    for (const src of [surface, chip, read('ActionRow.tsx')]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/markdown-editor/);
      expect(code).not.toMatch(/MarkdownEditor\.mount/);
      expect(code).not.toMatch(/conex-mdx/);
      expect(code).not.toMatch(/js\/markdown-editor/);
      expect(code).not.toMatch(/registerView\s*\(/);
    }
  });

  it('无 document.body 阅读根 / 无 createPortal / 无 92vh', () => {
    const files = collect(DIR).filter(
      (p) => !p.endsWith('.test.ts') && !p.endsWith('.test.tsx')
    );
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/document\.body\.appendChild/);
      expect(src, file).not.toMatch(/createPortal\s*\(/);
      expect(src, file).not.toMatch(/position:\s*fixed[\s\S]{0,80}inset:\s*0/);
      expect(src, file).not.toMatch(/\b92vh\b/);
    }
  });

  it('无 docId 不 persist；不走 sendToNoteMount 静默新 doc', () => {
    const openSrc = read('artifactNoteOpen.ts');
    const chip = read('ArtifactChip.tsx');
    const surface = read('ArtifactNotebookSurface.tsx');
    const renderers = read('narrativeRenderers.tsx');
    const blob = [openSrc, chip, surface, renderers].join('\n');
    expect(openSrc).toMatch(/openTool\(sessionId,\s*['"]note['"]\)/);
    expect(openSrc).toMatch(/missing-docId/);
    expect(blob).not.toMatch(/from\s+['"][^'"]*sendToNoteMount['"]/);
    expect(blob).not.toMatch(/DEFAULT_CHAT_NOTE_DOC_ID/);
    expect(blob).not.toMatch(/applyAndCommit|apply\+commit/);
    expect(blob).not.toMatch(/persistDocument|createNoteDocument|note_document_create/);
  });

  it('代码路径仍 onOpenPath；文档 chip 不调 onOpenPath', () => {
    const row = read('ActionRow.tsx');
    expect(row).toMatch(/data-flow-path=["']code["']/);
    expect(row).toMatch(/onOpenPath\(path\)/);
    expect(row).toMatch(/deriveArtifactFromTool/);
    expect(row).toMatch(/<ArtifactChip/);
    expect(row).not.toMatch(/onOpenPath=\{onOpenPath\}/);
  });

  it('关插件默认：activate 仍 false；线性列表不挂 Notebook', () => {
    const activate = read('activate.ts');
    expect(activate).toMatch(/return officialOverride \?\? false/);
    const list = readFileSync(
      join(DESKTOP_SRC, 'components/chat-message-list/ChatMessageList.tsx'),
      'utf8'
    );
    const tool = readFileSync(
      join(DESKTOP_SRC, 'components/chat-tool-call/ChatToolCallBlock.tsx'),
      'utf8'
    );
    expect(list).not.toMatch(/ArtifactChip|ArtifactNotebook|data-flow-artifact-notebook/);
    expect(tool).not.toMatch(/ArtifactChip|ArtifactNotebook|data-flow-artifact-notebook/);
  });

  it('不改 registerBuiltInViews 11 名单', () => {
    const src = readFileSync(
      join(DESKTOP_SRC, 'services/view-registry/registerBuiltInViews.tsx'),
      'utf8'
    );
    const ids = [...src.matchAll(/^\s*id:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(11);
    expect(ids).not.toContain('note');
    expect(ids).not.toContain('conversation-flow');
    expect(ids).not.toContain('artifact-notebook');
  });
});

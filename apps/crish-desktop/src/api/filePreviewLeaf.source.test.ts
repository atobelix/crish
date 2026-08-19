/**
 * S6 源码钉：预览只进叶。≠ 9222 真壳绿。
 * 产品 src（不含 reference/）无 fp-root / body 预览根 / 92vh 第二视口。
 * onOpenPath 仍开 files 或 file-viewer，不挂 Notebook，无 docId 不 persist。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const SRC_ROOT = join(DIR, '..');
const EXT = /\.(ts|tsx|css)$/;
const SKIP = /\.(test|spec)\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !SKIP.test(name)) out.push(full);
  }
  return out;
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

const PRODUCT_FILES = walk(SRC_ROOT);

const OPENER = join(DIR, 'filePanelOpener.ts');
const SESSION = join(DIR, '../components/chat-card/useChatSessionActions.ts');
const AGENT = join(DIR, '../components/agent-card/useAgentCardPanelNav.ts');
const CHAT_CARD = join(DIR, '../components/chat-card/ChatCard.tsx');
const OPEN_TOOL = join(DIR, '../store/workspace-shell/openTool.ts');
const FILE_PREVIEW = join(DIR, '../components/files/FilePreview.tsx');
const FILE_VIEWER = join(DIR, '../components/files/FileViewerCard.tsx');
const FILE_ACTIONS = join(DIR, '../components/files/FileActions.tsx');
const COMPOSER = join(DIR, '../components/chat-composer/ChatComposer.tsx');
const ATTACH_BAR = join(
  DIR,
  '../components/chat-composer/ComposerAttachmentBar.tsx'
);

describe('S6 · 预览进叶源码钉（≠ 真壳到达绿）', () => {
  it('产品 src 无 fp-root 整屏 / FilePreview.open 调用 / 92vh', () => {
    const hits: string[] = [];
    const banned =
      /class(Name)?\s*=\s*['"`][^'"`]*fp-root|\.fp-root\b|#fpRoot\b|id=["']fpRoot["']|FilePreview\.open\s*\(|window\.openPreview\s*\(|max-height:\s*92vh|\b92vh\b/;
    for (const file of PRODUCT_FILES) {
      const src = readUtf8(file);
      if (banned.test(src)) {
        hits.push(relative(SRC_ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(hits).toEqual([]);
  });

  it('FilePreview / FileViewerCard / opener 不往 document.body 挂预览根', () => {
    const previewSrc = [
      readUtf8(FILE_PREVIEW),
      readUtf8(FILE_VIEWER),
      readUtf8(OPENER),
      readUtf8(OPEN_TOOL),
    ].join('\n');
    expect(previewSrc).not.toMatch(/document\.body\.appendChild/);
    expect(previewSrc).not.toMatch(/createPortal\s*\(/);
    expect(previewSrc).not.toMatch(/position:\s*fixed[\s\S]{0,80}inset:\s*0/);
    expect(readUtf8(FILE_PREVIEW)).toMatch(/禁止挂 document\.body 或整屏覆盖层/);
    expect(readUtf8(FILE_VIEWER)).toMatch(/data-file-preview-host="file-viewer"/);
  });

  it('onOpenPath 只调 openFileInPanel，不叠开 files、不挂 note/Notebook', () => {
    const sessionSrc = readUtf8(SESSION);
    const agentSrc = readUtf8(AGENT);
    const cardSrc = readUtf8(CHAT_CARD);
    const openerSrc = readUtf8(OPENER);

    expect(cardSrc).toMatch(/onOpenPath:\s*state\.openPathInFilesPanel/);
    expect(cardSrc).toMatch(/onOpenPath=\{state\.openPathInFilesPanel\}/);
    expect(sessionSrc).toMatch(/openFileInPanel\(filePath\)/);
    expect(sessionSrc).not.toMatch(/openSidePanel\(\s*['"]files['"]\s*\)/);
    expect(sessionSrc).not.toMatch(/openToolInSession\([^)]*['"]note['"]/);
    expect(agentSrc).toMatch(/openFileInPanel\(filePath\)/);
    expect(agentSrc).not.toMatch(/focusOrOpenPanel\([^)]*['"]files['"]/);
    expect(agentSrc).not.toMatch(/openToolInSession\([^)]*['"]note['"]/);

    expect(openerSrc).toMatch(/FilePreviewLeafHost = 'files' \| 'file-viewer'/);
    expect(openerSrc).not.toMatch(/openToolInSession\([^)]*['"]note['"]/);
    expect(openerSrc).not.toMatch(/host === ['"]note['"]/);
    expect(openerSrc).not.toMatch(/applyAndCommit|persistDocument|note_document/);
  });

  it('file-viewer 打开器拒 note，URI 仍是 file-viewer:，不 persist', () => {
    const src = readUtf8(OPEN_TOOL);
    expect(src).toMatch(/file-viewer:\$\{trimmed\}/);
    expect(src).toMatch(/\/\^\(note\|notebook\)\(:\|\$\)\/i/);
    expect(src).not.toMatch(/apply\+commit|applyAndCommit|persistDocument|note_document/);
    expect(src).not.toMatch(/openToolInSession\([^)]*['"]note['"]/);
  });

  it('md 源码硬切只留 files 叶', () => {
    const actions = readUtf8(FILE_ACTIONS);
    const viewer = readUtf8(FILE_VIEWER);
    expect(actions).toMatch(/data-md-source-toggle="files-leaf-only"/);
    expect(actions).toMatch(/onMdModeChange\('source'\)/);
    expect(viewer).not.toMatch(/mdMode/);
    expect(viewer).not.toMatch(/源码硬切|onMdModeChange/);
  });

  it('附件 / ChatCard 只接线 onOpenPath，不重做附件皮', () => {
    const composer = readUtf8(COMPOSER);
    const bar = readUtf8(ATTACH_BAR);
    expect(composer).toMatch(/onOpenPath\?: \(filePath: string\) => void/);
    expect(composer).toMatch(/data-file-open-path/);
    expect(bar).toMatch(/data-file-open-path=\{a\.name\}/);
    expect(bar).not.toMatch(/fp-root|createPortal|document\.body\.appendChild/);
  });

  it('无 docId 打开路径不创建 persist', () => {
    const src = [
      readUtf8(OPENER),
      readUtf8(OPEN_TOOL),
      readUtf8(FILE_PREVIEW),
      readUtf8(FILE_VIEWER),
      readUtf8(SESSION),
    ].join('\n');
    expect(src).not.toMatch(/applyAndCommit|apply\+commit/);
    expect(src).not.toMatch(/persistDocument|createNoteDocument|note_document_create/);
    expect(src).not.toMatch(/DEFAULT_CHAT_NOTE_DOC_ID/);
  });
});

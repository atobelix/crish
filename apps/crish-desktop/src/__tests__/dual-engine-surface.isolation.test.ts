/**
 * W5-C · 双引擎架构隔离静态扫描（Strict 方向子集）
 *
 * 覆盖：
 * - **A-SURF-02**（保持/加深）：note-paper（含 Strict 轨文件）禁行级 EditorStore / markdown-editor
 * - **A-SURF-03**（真扫方向）：chat / agent / 行级热路径 **禁** DocSession 写 / note apply 直连
 *   —— 仅 `src/bridges/*` 为跨界白名单例外
 *
 * 会计钉死（plans/07 §0 / §3 / §6；dual-engine-surface §7.2；20 L3–L4）：
 * - **≠ EL-08 关闭**（最低集 02+03+04+05+06+08+11 + A-INV-03 须全绿）
 * - **≠ W5-B / W5-B-S 挂载完成** 即可关 EL
 * - **禁止**用「只扫 editor-kit 源码」冒充 A-SURF-03（editor-kit 包级测 = A-SURF-09）
 * - 本包绿 **不得** 把 EL-dashboard EL-08 标关
 *
 * 对齐：`plans/specs/dual-engine-surface.md` §3 NS-01 / §6 / §7；`plans/07` §6 纠偏
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径根
// ---------------------------------------------------------------------------

const SRC_ROOT =
  typeof import.meta.dirname === 'string'
    ? resolve(import.meta.dirname, '..')
    : import.meta.url.startsWith('file:')
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
      : resolve(process.cwd(), 'src');

const SOURCE_EXTS = new Set(['.ts', '.tsx']);

// ---------------------------------------------------------------------------
// 文件系统
// ---------------------------------------------------------------------------

function walkProductSources(
  dir: string,
  opts?: { includeTests?: boolean }
): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // 跳过明显非产品树
      if (name === 'node_modules' || name === 'dist' || name === 'coverage') {
        continue;
      }
      out.push(...walkProductSources(full, opts));
      continue;
    }
    if (!SOURCE_EXTS.has(extname(name))) continue;
    if (!opts?.includeTests) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(name)) continue;
    }
    out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, '/');
}

function isExemptLine(line: string): boolean {
  const t = line.trim();
  if (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('*/') ||
    t === ''
  ) {
    return true;
  }
  // 行尾纪律注释：代码侧无禁词则豁免
  if (t.includes('// A-SURF') || t.includes('// W5-C') || t.includes('禁止')) {
    const codePart = t.split('//')[0] ?? '';
    if (
      !/\bDocSession\b|\bEditorStore\b|noteApi|document_apply|note_document_apply|doc_apply_ops|createNoteTransport|createMemoryNoteTransport|resolveNoteTransport/.test(
        codePart
      )
    ) {
      return true;
    }
  }
  return false;
}

type Hit = { file: string; line: number; text: string; rule: string };

// ---------------------------------------------------------------------------
// A-SURF-02：note-paper 禁行级 EditorStore
// ---------------------------------------------------------------------------

/** note-paper 目录（含 Strict / Skeleton 文件） */
const NOTE_PAPER_DIR = join(SRC_ROOT, 'components', 'note-paper');

const SURF02_RULES: Array<{ id: string; re: RegExp }> = [
  {
    id: 'EditorStore-ident',
    re: /\b(?:EditorStore|useEditorStore|createEditorStore)\b/,
  },
  {
    id: 'markdown-editor-import',
    re: /from\s+['"][^'"]*markdown-editor[^'"]*['"]|require\s*\(\s*['"][^'"]*markdown-editor/,
  },
  {
    id: 'reference-markdown-editor',
    re: /reference[/\\]markdown-editor/,
  },
  {
    id: 'lines-authority-store',
    re: /\b(?:createLinesStore|useLinesStore|authorityLines|linesAuthority)\b/,
  },
];

function scanSurf02(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isExemptLine(line)) continue;
      // 仅扫 import / 标识符使用行；纯字符串文档不计入（仍拦 import）
      for (const rule of SURF02_RULES) {
        if (rule.re.test(line)) {
          hits.push({
            file: rel(file),
            line: i + 1,
            text: line.trim().slice(0, 160),
            rule: rule.id,
          });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// A-SURF-03：chat / agent 真扫 —— 禁 DocSession 写 / note apply 直连
// ---------------------------------------------------------------------------

/**
 * 真扫根：chat surface + agent 消息面 + 流式热路径。
 * **明确列出**（plans/07 §6）：apps/crish-desktop chat* / 会话消息面；
 * bridges/* 白名单不在此表。
 */
const SURF03_SCAN_DIRS: string[] = [
  'components/chat-card',
  'components/chat-composer',
  'components/chat-message-list',
  'components/chat-message-row',
  'components/chat-message',
  'components/chat-tool-call',
  'components/agent-card',
  'hooks/chat-stream',
  'api/chat-bridge',
];

/** 单文件热路径（行级流式 / 会话消息） */
const SURF03_SCAN_FILES: string[] = [
  'hooks/useChatStream.ts',
  'hooks/useAgentStream.ts',
  'hooks/useChatAutoScroll.ts',
  'hooks/useChatPanelSync.ts',
  'hooks/useAgentToolApproval.ts',
  'api/chatApi.ts',
  'api/chatBridge.ts',
  'api/chatEmptyState.ts',
  'api/chatApprovalUi.ts',
  'api/sessionStreamManager.ts',
  'api/StreamRenderBuffer.ts',
  'api/streamTextBatcher.ts',
  'api/streamStop.ts',
  'api/silentComplete.ts',
  'api/messageUserProjection.ts',
  'api/messageWindow.ts',
];

/**
 * 白名单路径前缀（相对 SRC_ROOT，posix）。
 * 仅 bridges 知两边；**禁止**把 note-paper / noteApi 自身塞进 03 扫根冒充绿。
 */
function isSurf03Whitelist(fileRel: string): boolean {
  if (fileRel.startsWith('bridges/')) return true;
  // isolation / surf 测自身可讨论禁词
  if (fileRel.includes('.isolation.test.')) return true;
  if (fileRel.includes('.surf.test.')) return true;
  if (fileRel.includes('.boundary.test.')) return true;
  return false;
}

/**
 * 笔记写 API / DocSession 直连禁词（非注释）。
 * 类型-only import 的 noteApi 也禁——chat 面应只经 bridges 触达写路径。
 */
const SURF03_RULES: Array<{ id: string; re: RegExp }> = [
  {
    id: 'DocSession',
    re: /\bDocSession\b/,
  },
  {
    id: 'doc_apply_ops',
    re: /\bdoc_apply_ops\b|\bdocApplyOps\b/,
  },
  {
    id: 'note-write-cmd',
    re: /\bnote_document_apply_md\b|\bnote_send_to_note\b|\bdocument_apply_md\b/,
  },
  {
    id: 'note-transport-write',
    re: /\b(?:createNoteTransport|createMemoryNoteTransport|createTauriNoteTransport|createDefaultNoteTransport|resolveNoteTransport|setDefaultNoteTransport)\b/,
  },
  {
    id: 'noteApi-module-import',
    re: /from\s+['"][^'"]*\/noteApi(?:\.[a-z]+)?['"]|from\s+['"][^'"]*api\/noteApi['"]|require\s*\(\s*['"][^'"]*noteApi/,
  },
  {
    id: 'NOTE_CMD-write',
    re: /\bNOTE_CMD_DOCUMENT_APPLY_MD\b|\bNOTE_CMD_SEND_TO_NOTE\b|\bNOTE_TOOL_DOCUMENT_APPLY_MD\b|\bNOTE_TOOL_SEND_TO_NOTE\b/,
  },
  {
    id: 'Transaction-apply-note',
    // 笔记权威 Transaction.apply（非任意 JS apply）；保守扫 DocSession 相关已覆盖
    re: /\bTransaction\s*\.\s*apply\b|\bnoteApplyMd\b|\.applyMd\s*\(/,
  },
];

function collectSurf03Files(): string[] {
  const files: string[] = [];
  for (const d of SURF03_SCAN_DIRS) {
    const abs = join(SRC_ROOT, ...d.split('/'));
    files.push(...walkProductSources(abs));
  }
  for (const f of SURF03_SCAN_FILES) {
    const abs = join(SRC_ROOT, ...f.split('/'));
    try {
      if (statSync(abs).isFile()) files.push(abs);
    } catch {
      // 路径演进时跳过缺失；测内会 assert 扫到的文件数 > 0
    }
  }
  // 去重
  return [...new Set(files)];
}

function scanSurf03(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const fileRel = rel(file);
    if (isSurf03Whitelist(fileRel)) continue;
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isExemptLine(line)) continue;
      for (const rule of SURF03_RULES) {
        if (rule.re.test(line)) {
          hits.push({
            file: fileRel,
            line: i + 1,
            text: line.trim().slice(0, 160),
            rule: rule.id,
          });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// A-SURF-02
// ---------------------------------------------------------------------------

describe('A-SURF-02 note-paper 禁行级 EditorStore（W5-C 加深 / 含 Strict）', () => {
  const notePaperFiles = walkProductSources(NOTE_PAPER_DIR);

  it('note-paper 目录可扫到产品源码（含 Strict 轨文件）', () => {
    expect(notePaperFiles.length).toBeGreaterThan(0);
    const rels = notePaperFiles.map(rel);
    // Strict 轨必须在扫范围内（加深：不可只扫 Skeleton 壳）
    expect(
      rels.some((r) => r.includes('NotePaperStrictPanel')),
      '须扫到 NotePaperStrictPanel（W5-B Strict）'
    ).toBe(true);
    expect(
      rels.some((r) => r.includes('w5bStrict')),
      '须扫到 w5bStrict 包标识'
    ).toBe(true);
    expect(
      rels.some((r) => r.includes('hydrateProjection')),
      '须扫到 hydrateProjection'
    ).toBe(true);
  });

  it('note-paper 产品源码无 EditorStore / markdown-editor / lines 权威 store', () => {
    const hits = scanSurf02(notePaperFiles);
    expect(
      hits,
      hits.map((h) => `${h.rule} @ ${h.file}:${h.line}: ${h.text}`).join('\n')
    ).toEqual([]);
  });

  it('本测 ≠ EL-08 关闭会计（钉死注释可检索）', () => {
    const self = readFileSync(
      join(SRC_ROOT, '__tests__', 'dual-engine-surface.isolation.test.ts'),
      'utf8'
    );
    expect(self).toMatch(/≠ EL-08 关闭/);
    expect(self).toMatch(/≠ W5-B/);
    expect(self).toMatch(/禁止.*editor-kit.*冒充.*A-SURF-03|只扫 editor-kit/);
  });
});

// ---------------------------------------------------------------------------
// A-SURF-03（真扫 chat/agent —— 非 editor-kit）
// ---------------------------------------------------------------------------

describe('A-SURF-03 chat/agent 真扫：禁 DocSession 写 / note apply 直连', () => {
  const chatFiles = collectSurf03Files();

  it('扫根覆盖 chat 组件 + 流式 hooks + chat-bridge（非 editor-kit）', () => {
    expect(chatFiles.length).toBeGreaterThan(10);
    const rels = chatFiles.map(rel);
    // 关键路径必须命中
    expect(rels.some((r) => r.startsWith('components/chat-card/'))).toBe(true);
    expect(rels.some((r) => r.startsWith('components/chat-message-row/'))).toBe(
      true
    );
    expect(rels.some((r) => r.startsWith('hooks/chat-stream/'))).toBe(true);
    expect(rels.some((r) => r.includes('sessionStreamManager'))).toBe(true);
    // **禁止**把 editor-kit 或仅 bridges 当扫根
    expect(rels.every((r) => !r.includes('editor-kit'))).toBe(true);
    expect(rels.every((r) => !r.startsWith('bridges/'))).toBe(true);
  });

  it('chat/agent 产品源码无 DocSession / note 写 API / noteApi 直连', () => {
    const hits = scanSurf03(chatFiles);
    expect(
      hits,
      [
        'A-SURF-03 违规（bridges/* 已白名单；业务面不得直连笔记写）：',
        ...hits.map((h) => `  ${h.rule} @ ${h.file}:${h.line}: ${h.text}`),
      ].join('\n')
    ).toEqual([]);
  });

  it('bridges/send-to-note 允许知两边（白名单例外仍存在且可 import noteApi）', () => {
    const bridge = join(SRC_ROOT, 'bridges', 'send-to-note.ts');
    const src = readFileSync(bridge, 'utf8');
    // 薄桥必须是唯一跨界：应 import noteApi
    expect(src).toMatch(/noteApi/);
    expect(src).toMatch(/send_to_note|SendToNote/);
    // 白名单路径判定
    expect(isSurf03Whitelist('bridges/send-to-note.ts')).toBe(true);
    expect(isSurf03Whitelist('components/chat-card/ChatCard.tsx')).toBe(false);
  });

  it('会计：本 describe 为 A-SURF-03 真扫，≠ editor-kit 包级 A-SURF-09', () => {
    const self = readFileSync(
      join(SRC_ROOT, '__tests__', 'dual-engine-surface.isolation.test.ts'),
      'utf8'
    );
    expect(self).toMatch(/A-SURF-03 chat\/agent 真扫/);
    expect(self).toMatch(/editor-kit 包级测 = A-SURF-09/);
  });
});

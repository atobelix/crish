/**
 * 前端笔记 API 契约 · Memory transport（noteApi 拆分后子模块 ③）
 *
 * 进程内笔记通路：apply → query 可测闭环（单测 / 无 Tauri 环境默认）。
 * 语义对齐 `crates/agent-tools` MemoryNoteBackend（极简 MD / intent 幂等）。
 *
 * 类型契约见 `noteApiContracts.ts`；主 barrel 与 Tauri 通路见 `noteApi.ts`。
 */

import type {
  NoteApplyMdOutcome,
  NoteApplyMdRequest,
  NoteApplyMdResult,
  NoteApplyMode,
  NoteAttrValue,
  NoteQueryBlockHit,
  NoteQueryBlocksOutcome,
  NoteQueryBlocksParams,
  NoteSendToNoteRequest,
  NoteTransport,
} from './noteApiContracts';

type MemBlock = {
  id: string;
  kind: string;
  text: string;
  attrs: Record<string, NoteAttrValue>;
  level: number;
};

type MemDoc = { blocks: MemBlock[] };

export type MemoryNoteTransport = NoteTransport & {
  /** 预置文档块（测试夹具）：(id, kind, text) */
  seedDoc(docId: string, blocks: Array<[string, string, string]>): void;
  /** 清空所有文档与幂等缓存 */
  clear(): void;
  /** 当前文档块数（测试） */
  blockCount(docId: string): number;
};

function parseAtxHeading(line: string): number | null {
  let i = 0;
  while (i < line.length && line[i] === '#') i += 1;
  if (i === 0 || i > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  return i;
}

/** 极简 MD 行 → 块草案（kind, text, level） */
function parseMdLines(
  markdown: string
): Array<{ kind: string; text: string; level: number }> {
  const out: Array<{ kind: string; text: string; level: number }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.trim().length === 0) continue;
    const level = parseAtxHeading(trimmed);
    if (level !== null) {
      const title = trimmed.replace(/^#+\s*/, '').trim();
      out.push({ kind: 'heading', text: title, level });
    } else {
      out.push({ kind: 'paragraph', text: trimmed, level: 0 });
    }
  }
  return out;
}

/**
 * 进程内笔记通路：apply → query 可测闭环。
 * 语义对齐 `crates/agent-tools` MemoryNoteBackend（极简 MD / intent 幂等）。
 */
export function createMemoryNoteTransport(): MemoryNoteTransport {
  const docs = new Map<string, MemDoc>();
  const intents = new Map<string, NoteApplyMdResult>();
  let idSeq = 1;

  const nextId = (): string => {
    const id = `mem-block-${idSeq}`;
    idSeq += 1;
    return id;
  };

  const ensureDoc = (docId: string): MemDoc => {
    let doc = docs.get(docId);
    if (!doc) {
      doc = { blocks: [] };
      docs.set(docId, doc);
    }
    return doc;
  };

  const applyMd = async (
    req: NoteApplyMdRequest
  ): Promise<NoteApplyMdOutcome> => {
    if (typeof req.docId !== 'string' || req.docId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      };
    }
    if (typeof req.markdown !== 'string') {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'markdown must be a string snapshot',
      };
    }

    if (req.intentId !== undefined) {
      if (req.intentId.trim().length === 0) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'intent_id must be non-empty when provided',
        };
      }
      const prev = intents.get(req.intentId);
      if (prev) {
        return {
          ok: true,
          blockIds: [...prev.blockIds],
          inserted: 0,
          idempotent: true,
        };
      }
    }

    const mode: NoteApplyMode = req.mode ?? 'apply_md_fragment';
    const doc = ensureDoc(req.docId);

    if (mode === 'append_to_block') {
      const tid =
        req.afterBlockId ??
        (doc.blocks.length > 0
          ? doc.blocks[doc.blocks.length - 1]!.id
          : undefined);
      if (!tid) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: 'append_to_block: no target block',
        };
      }
      const block = doc.blocks.find((b) => b.id === tid);
      if (!block) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `block not found: ${tid}`,
        };
      }
      if (block.text.length > 0 && req.markdown.length > 0) {
        block.text += '\n';
      }
      block.text += req.markdown.replace(/\s+$/, '');
      const result: NoteApplyMdResult = {
        ok: true,
        blockIds: [tid],
        inserted: 0,
        idempotent: false,
      };
      if (req.intentId) {
        intents.set(req.intentId, {
          ok: true,
          blockIds: [...result.blockIds],
          inserted: result.inserted,
          idempotent: false,
        });
      }
      return result;
    }

    let insertAt = doc.blocks.length;
    if (req.afterBlockId) {
      const idx = doc.blocks.findIndex((b) => b.id === req.afterBlockId);
      if (idx < 0) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `after_block_id not found: ${req.afterBlockId}`,
        };
      }
      insertAt = idx + 1;
    }

    if (req.parentId && doc.blocks.length > 0) {
      if (!doc.blocks.some((b) => b.id === req.parentId)) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `parent_id not found: ${req.parentId}`,
        };
      }
    }

    const drafts = parseMdLines(req.markdown);
    const newBlocks: MemBlock[] = [];
    const blockIds: string[] = [];
    for (const d of drafts) {
      const id = nextId();
      blockIds.push(id);
      newBlocks.push({
        id,
        kind: d.kind,
        text: d.text,
        attrs: {},
        level: d.level,
      });
    }

    for (let i = 0; i < newBlocks.length; i += 1) {
      doc.blocks.splice(insertAt + i, 0, newBlocks[i]!);
    }

    const result: NoteApplyMdResult = {
      ok: true,
      blockIds,
      inserted: newBlocks.length,
      idempotent: false,
    };
    if (req.intentId) {
      intents.set(req.intentId, {
        ok: true,
        blockIds: [...result.blockIds],
        inserted: result.inserted,
        idempotent: false,
      });
    }
    return result;
  };

  const queryBlocks = async (
    params: NoteQueryBlocksParams
  ): Promise<NoteQueryBlocksOutcome> => {
    if (typeof params.docId !== 'string' || params.docId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      };
    }
    const limitRaw = params.limit ?? 50;
    const limit = Math.min(200, Math.max(1, limitRaw));
    const doc = docs.get(params.docId);
    if (!doc) {
      return { ok: true, blocks: [], truncated: false };
    }

    const kindSet =
      params.kindIn && params.kindIn.length > 0 ? new Set(params.kindIn) : null;

    const hits: NoteQueryBlockHit[] = [];
    for (const b of doc.blocks) {
      if (kindSet && !kindSet.has(b.kind)) continue;
      if (
        params.textMatch &&
        params.textMatch.length > 0 &&
        !b.text.includes(params.textMatch)
      ) {
        continue;
      }
      if (params.attrsEq) {
        let ok = true;
        for (const [k, v] of Object.entries(params.attrsEq)) {
          if (b.attrs[k] !== v) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      hits.push({
        id: b.id,
        kind: b.kind,
        snippet: b.text.slice(0, 200),
        attrs: { ...b.attrs },
      });
    }

    const truncated = hits.length > limit;
    return {
      ok: true,
      blocks: truncated ? hits.slice(0, limit) : hits,
      truncated,
    };
  };

  const sendToNote = async (
    req: NoteSendToNoteRequest
  ): Promise<NoteApplyMdOutcome> => {
    if (typeof req.intentId !== 'string' || req.intentId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'intent_id must be non-empty',
      };
    }
    return applyMd({
      docId: req.docId,
      markdown: req.markdown,
      parentId: req.parentId,
      afterBlockId: req.afterBlockId,
      mode: req.mode ?? 'apply_md_fragment',
      intentId: req.intentId,
      batchId: req.batchId,
      messageId: req.messageId,
      origin: req.origin ?? 'user',
    });
  };

  return {
    applyMd,
    queryBlocks,
    sendToNote,
    seedDoc(docId, blocks) {
      const doc = ensureDoc(docId);
      for (const [id, kind, text] of blocks) {
        doc.blocks.push({
          id,
          kind,
          text,
          attrs: {},
          level: kind === 'heading' ? 1 : 0,
        });
      }
    },
    clear() {
      docs.clear();
      intents.clear();
      idSeq = 1;
    },
    blockCount(docId) {
      return docs.get(docId)?.blocks.length ?? 0;
    },
  };
}

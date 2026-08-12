/**
 * hydrate 投影适配（SD-24 切开 · adapt）
 *
 * - `adaptNoteTransportAsHydrate` → `source: 'note-transport'`（query 派生）
 * - `adaptNoteHydrateIpcAsTransport` → `source: 'tauri-ipc'`；`hydratePath` 透传
 * - **≠** 打开完成；**≠ EL-01/04/08**；query 派生禁止抬成 doc-session / full hydrate
 */

import type {
  NoteHydrateIpc,
  NoteHydrateIpcSuccess,
} from '../../api/noteHydrateIpc';
import type { NoteQueryBlockHit, NoteTransport } from '../../api/noteApi';
import type {
  DocHydrateProjection,
  HydratedBlockProjection,
  NoteHydrateTransport,
} from './hydrateProjection.types';

/**
 * 将 `NoteQueryBlockHit` 映射为 hydrate 后块投影。
 * query 摘要 ≠ 全文权威；仅作 Strict 读路径演示形状。
 */
export function mapQueryHitToProjection(
  hit: NoteQueryBlockHit,
  index: number
): HydratedBlockProjection {
  const level =
    typeof hit.attrs.level === 'number' ? hit.attrs.level : undefined;
  return {
    id: hit.id,
    flavour: hit.kind || 'paragraph',
    index,
    props: {
      ...hit.attrs,
      ...(level !== undefined ? { level } : {}),
    },
    text: hit.snippet,
  };
}

/**
 * 适配已有 NoteTransport.queryBlocks → NoteHydrateTransport。
 *
 * 诚实边界：
 * - 这是 **query 投影适配**，不是 `DocSession::hydrate` 产品命令本身
 * - source 固定 `note-transport`（即使底层是 Tauri note_query_blocks）
 * - **不**宣称「打开文档完成」/ W1-H 关闭
 */
export function adaptNoteTransportAsHydrate(
  transport: NoteTransport,
  options: { rev?: number } = {}
): NoteHydrateTransport {
  const baseRev = options.rev ?? 1;
  return {
    async hydrate(docId) {
      const res = await transport.queryBlocks({ docId, limit: 200 });
      if (!res.ok) {
        return {
          ok: false,
          code: res.code,
          reason: res.reason,
        };
      }
      return {
        ok: true,
        projection: {
          docId,
          rev: baseRev,
          blocks: res.blocks.map((b, i) => mapQueryHitToProjection(b, i)),
          source: 'note-transport',
        },
      };
    },
  };
}

/**
 * 适配专用 hydrate IPC → NoteHydrateTransport。
 *
 * 诚实边界：
 * - 成功投影 source 固定 `tauri-ipc`（与 query 适配的 `note-transport` 分轨）
 * - `hydratePath` 透传后端分轨（默认 `doc-session`；对照 `query-blocks`）
 * - 产品默认经 `createProductStrictHydrateTransport` 在 Tauri 环境选用本 adapter
 * - **不**宣称「打开文档完成」/ G-HYD 全条件 / EL-04·01 关闭
 */
export function adaptNoteHydrateIpcAsTransport(
  ipc: NoteHydrateIpc
): NoteHydrateTransport {
  return {
    async hydrate(docId) {
      const out = await ipc.hydrateDocument({ docId });
      if (!out.ok) {
        return { ok: false, code: out.code, reason: out.reason };
      }
      return {
        ok: true,
        projection: mapHydrateIpcSuccessToProjection(out),
      };
    },
  };
}

/** IPC 成功载荷 → DocHydrateProjection（source 钉死 tauri-ipc；hydratePath 透传） */
export function mapHydrateIpcSuccessToProjection(
  ok: NoteHydrateIpcSuccess
): DocHydrateProjection {
  return {
    docId: ok.docId,
    rev: ok.rev,
    blocks: ok.blocks.map((b, i) => ({
      id: b.id,
      flavour: b.flavour || 'paragraph',
      parentId: b.parentId,
      index: typeof b.index === 'number' ? b.index : i,
      props: b.props,
      text: b.text,
    })),
    source: 'tauri-ipc',
    ...(ok.hydratePath ? { hydratePath: ok.hydratePath } : {}),
  };
}

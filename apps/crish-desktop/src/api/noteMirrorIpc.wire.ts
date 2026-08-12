/**
 * 笔记镜像 detect / import 请求 → snake_case 线格式（SD-33 · wire）
 *
 * **≠ EL-03**；**≠ inotify 产品满关**。
 */
import type {
  NoteDetectMirrorRequest,
  NoteImportMirrorRequest,
} from './noteMirrorIpc.types';

export function detectMirrorReqToWire(
  req: NoteDetectMirrorRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = { doc_id: req.docId };
  if (req.authorityRev !== undefined) wire.authority_rev = req.authorityRev;
  return wire;
}

export function wrapDetectMirrorInvokeArgs(
  req: NoteDetectMirrorRequest
): Record<string, unknown> {
  return { req: detectMirrorReqToWire(req) };
}

export function importMirrorReqToWire(
  req: NoteImportMirrorRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    doc_id: req.docId,
    strategy: req.strategy,
  };
  if (req.unpushedOpCount !== undefined) {
    wire.unpushed_op_count = req.unpushedOpCount;
  }
  if (req.authorityRev !== undefined) wire.authority_rev = req.authorityRev;
  if (req.useSessionTree !== undefined) {
    wire.use_session_tree = req.useSessionTree;
  }
  return wire;
}

export function wrapImportMirrorInvokeArgs(
  req: NoteImportMirrorRequest
): Record<string, unknown> {
  return { req: importMirrorReqToWire(req) };
}

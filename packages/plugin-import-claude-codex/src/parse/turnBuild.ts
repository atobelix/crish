/**
 * 外部会话轮次的有序片段。
 * 思考、正文按原文出现顺序追加，宿主时间线按此渲染，不再打成纯文本。
 * 彻底不导入外部命令工具调用，纯粹只保留用户提问、AI 思考链与 AI 回复正文。
 */
import type {
  ImportImageDraft,
  ImportTurnSegment,
  NormalizedImportTurn,
} from '../types';

/** data URL 超过此长度则不嵌入预览，避免单条会话把内存撑满。 */
const MAX_IMAGE_URL_CHARS = 1_500_000;

export function ensureSegments(
  turn: NormalizedImportTurn
): ImportTurnSegment[] {
  if (!turn.segments) turn.segments = [];
  return turn.segments;
}

export function pushThinking(turn: NormalizedImportTurn, text: string): void {
  const t = text.trim();
  if (!t) return;
  const segs = ensureSegments(turn);
  if (segs.some((s) => s.kind === 'thinking' && s.text === t)) return;
  segs.push({ kind: 'thinking', text: t });
  turn.thinking = turn.thinking ? `${turn.thinking}\n${t}` : t;
}

export function pushText(turn: NormalizedImportTurn, text: string): void {
  const t = text.trim();
  if (!t) return;
  const segs = ensureSegments(turn);
  if (segs.some((s) => s.kind === 'text' && s.text === t)) return;
  segs.push({ kind: 'text', text: t });
  turn.text = turn.text ? `${turn.text}\n${t}` : t;
}

export function pushTool(_turn: NormalizedImportTurn, _id: string): void {
  // 裁决：导入上下文时彻底不导入外部工具调用，杜绝外部软件的私有命令污染 Crish 内部 Agent 的上下文
}

export function pushImage(
  turn: NormalizedImportTurn,
  image: ImportImageDraft
): void {
  if (!image.url) return;
  if (!turn.images) turn.images = [];
  if (turn.images.some((img) => img.url === image.url)) return;
  turn.images.push(image);
}

export function turnHasContent(turn: NormalizedImportTurn): boolean {
  if (turn.role === 'user') {
    return Boolean(
      turn.text?.trim() || (turn.images && turn.images.length > 0)
    );
  }
  return Boolean(
    turn.text?.trim() ||
    turn.thinking?.trim() ||
    (turn.images && turn.images.length > 0)
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 从 Claude image 块或 Codex input_image 取出可展示的 URL。
 * 过大的 data URL 返回 omitted，调用方改写一句说明，不把正文丢掉。
 */
export function takeImage(
  block: Record<string, unknown>,
  id: string
): { image: ImportImageDraft } | { omitted: true } | null {
  const source = asRecord(block.source);
  let url = '';
  let mime: string | undefined;

  if (source && source.type === 'base64' && typeof source.data === 'string') {
    mime =
      typeof source.media_type === 'string' ? source.media_type : 'image/png';
    url = `data:${mime};base64,${source.data}`;
  } else if (
    source &&
    source.type === 'url' &&
    typeof source.url === 'string'
  ) {
    url = source.url;
    if (typeof source.media_type === 'string') mime = source.media_type;
  } else if (typeof block.image_url === 'string') {
    url = block.image_url;
  } else {
    const nested = asRecord(block.image_url);
    if (nested && typeof nested.url === 'string') url = nested.url;
  }

  if (!url) return null;
  if (url.length > MAX_IMAGE_URL_CHARS) return { omitted: true };
  const image: ImportImageDraft = { id, url };
  if (mime) image.mime = mime;
  else if (url.startsWith('data:image/')) {
    const found = /^data:(image\/[a-zA-Z0-9.+-]+)/.exec(url);
    if (found?.[1]) image.mime = found[1];
  } else {
    image.mime = 'image/png';
  }
  return { image };
}

/** 把字符串数组或 `{text}` 数组收成一段可见文字。加密长串（无空白）丢弃。 */
export function stringsFrom(value: unknown): string {
  const parts: string[] = [];
  const push = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (t.length > 500 && !/\s/.test(t)) return;
    parts.push(t);
  };
  if (typeof value === 'string') {
    push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') push(item);
      else {
        const rec = asRecord(item);
        if (rec && typeof rec.text === 'string') push(rec.text);
      }
    }
  }
  return parts.join('\n');
}

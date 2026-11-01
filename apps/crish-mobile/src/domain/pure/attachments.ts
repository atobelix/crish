// G5b · 附件组装与发送前预检（纯函数，桌面 multimodal.ts 同构口径）
//
// 范本：apps/crish-desktop/src/hooks/chat-stream/multimodal.ts 的
// buildMultimodalFromAttachments —— parts 结构 / prompt 附件块文案 /
// 文本文件截断 / 非视觉降级注记逐字对齐，本文件是移动端镜像，改口径
// 必须两端同步评估。
//
// 宿主契约（G5a）：runTask params 可带 content（OpenAI 形 parts）+
// hasImages；网关 validate_remote_content 做服务端钳制，超限回
// cmd.invalid——本模块的预检必须在发送前拦截，不许送达网关才失败。
// 上限常量与 crates/conex-device-protocol/src/version.rs 同源：
//   RUN_CONTENT_MAX_BYTES = 720_896（帧 1MiB − prompt 256KiB − 信封余量 64KiB）
//   ATTACHMENT_DATA_URL_MAX_BYTES = 716_800（单 dataUrl 700KiB）
//   PROMPT_MAX_BYTES = 262_144

/** 单个 dataUrl 字符串总长上限（字节；dataUrl 为 ASCII，长度即字节数）。 */
export const ATTACHMENT_DATA_URL_MAX_BYTES = 716_800;
/** content 序列化总量上限（UTF-8 字节）。 */
export const RUN_CONTENT_MAX_BYTES = 720_896;
/** prompt 上限（UTF-8 字节）。 */
export const PROMPT_MAX_BYTES = 262_144;
/** 文本文件正文截断字符数（与桌面 multimodal.ts 同值）。 */
export const TEXT_BODY_MAX_CHARS = 80_000;
/** 选图压缩目标：原始字节 ≤ 500KB（dataUrl ≈ 683KB，距单图上限留余量）。 */
export const IMAGE_TARGET_RAW_BYTES = 500_000;

export type ComposerAttachmentKind = 'image' | 'text' | 'file';

/** 已选附件（已选区与组装共用同一形态；图片在入选时已完成压缩）。 */
export interface ComposerAttachment {
  id: string;
  name: string;
  kind: ComposerAttachmentKind;
  /** 图片：压缩后的 dataUrl（入选即达标，见 attachmentIntake）。 */
  dataUrl?: string;
  /** 字节数（图片为解码后原始字节估算；文件为源文件大小，可缺省）。 */
  sizeBytes?: number;
  mime?: string;
  /** 文本文件：读取到的全文（截断在组装时按桌面同口径执行）。 */
  text?: string;
  /** 文本文件正文超过截断上限（已选区据此标注「已截断」）。 */
  textTruncated?: boolean;
  /** 图片缩略图源（本地文件 uri，优先于 dataUrl 渲染）。 */
  previewUri?: string;
}

/** OpenAI 形 content part（与桌面 multimodal.ts 输出同构）。 */
export interface RunContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail: 'auto' };
  name?: string;
  mime?: string;
}

export interface BuiltRunPayload {
  /** 含附件块的最终 prompt（必非空：纯附件时取附件块正文）。 */
  prompt: string;
  content: RunContentPart[];
  hasImages: boolean;
}

/** UTF-8 字节长度（与网关 serde_json 序列化后的字节计量对齐）。 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      // 代理对 = 4 字节
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 与桌面 formatBytes 同口径（非视觉降级注记的「大小」行）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function guessMimeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match?.[1] ?? null;
}

/** 非视觉降级注记（与桌面 redactNonVisionImageNote 逐字同口径）。 */
function nonVisionImageNote(
  attachment: ComposerAttachment,
  dataUrl: string
): string {
  const mime = attachment.mime ?? guessMimeFromDataUrl(dataUrl) ?? 'image/png';
  const size = attachment.sizeBytes ?? Math.floor((dataUrl.length * 3) / 4);
  return [
    `[图片附件元数据: ${attachment.name}]`,
    `格式: ${mime}`,
    `大小: ${formatBytes(size)}`,
    '（当前模型为纯文本非视觉模型：不接收结构化图像，亦不下发 dataUrl / 本机绝对路径）',
  ].join('\n');
}

/**
 * 按桌面同构口径组装 content + prompt 附件块。
 * 无附件返回 null（调用方走既有纯文本路径，零行为变化）。
 * visionSupported=false 时图片降级为元数据 text part 且 hasImages=false
 * （引擎对非视觉模型带图硬拒而非降级，移动端必须先行判定，见 G5b 查实）。
 */
export function buildRunPayload(
  rawText: string,
  attachments: readonly ComposerAttachment[],
  visionSupported: boolean
): BuiltRunPayload | null {
  if (attachments.length === 0) return null;
  const baseText = (rawText ?? '').trim();
  const parts: RunContentPart[] = [];
  const promptChunks: string[] = [];
  let hasImages = false;
  if (baseText) {
    parts.push({ type: 'text', text: baseText });
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      const dataUrl = attachment.dataUrl;
      const mime =
        attachment.mime ?? guessMimeFromDataUrl(dataUrl) ?? 'image/png';
      if (visionSupported) {
        parts.push({
          type: 'image_url',
          image_url: { url: dataUrl, detail: 'auto' },
          name: attachment.name,
          mime,
        });
        hasImages = true;
        promptChunks.push(
          `[图片附件: ${attachment.name}]\n用户上传了图片 ${attachment.name}，请结合 OCR/视觉理解分析（图片已通过结构化 image_url 部分下发）`
        );
      } else {
        const note = nonVisionImageNote(attachment, dataUrl);
        parts.push({ type: 'text', text: note });
        promptChunks.push(note);
      }
    } else if (
      attachment.kind === 'text' &&
      typeof attachment.text === 'string'
    ) {
      const body =
        attachment.text.slice(0, TEXT_BODY_MAX_CHARS) +
        (attachment.text.length > TEXT_BODY_MAX_CHARS ? '\n…(截断)' : '');
      const chunk = `--- ${attachment.name} ---\n${body}`;
      parts.push({ type: 'text', text: chunk });
      promptChunks.push(chunk);
    } else {
      const row = `- ${attachment.name}`;
      parts.push({ type: 'text', text: row });
      promptChunks.push(row);
    }
  }
  const blockBody = `[附件]\n${promptChunks.join('\n\n')}`;
  // prompt 必须非空：纯附件发送时取附件块正文（G5a 对接约束）。
  const prompt = baseText ? `${baseText}\n\n${blockBody}` : blockBody;
  return { prompt, content: parts, hasImages };
}

export type PayloadSizeCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'dataUrl' | 'content' | 'prompt';
      /** 面向用户的明确提示（阻止发送时经反馈面呈现）。 */
      message: string;
    };

/**
 * 发送前总量预检：与网关钳制同口径（单 dataUrl / content 序列化总量 /
 * prompt 字节）。超限返回明确原因，调用方阻止发送且不调仓储。
 */
export function checkRunPayloadSizes(
  payload: BuiltRunPayload
): PayloadSizeCheck {
  for (const part of payload.content) {
    if (part.type === 'image_url' && part.image_url) {
      if (part.image_url.url.length > ATTACHMENT_DATA_URL_MAX_BYTES) {
        return {
          ok: false,
          reason: 'dataUrl',
          message: `附件「${part.name ?? '图片'}」数据过大，超过单张图片上限，请移除后重试`,
        };
      }
    }
  }
  const contentBytes = utf8ByteLength(JSON.stringify(payload.content));
  if (contentBytes > RUN_CONTENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'content',
      message: '附件总大小超过单次发送上限，请减少附件后重试',
    };
  }
  if (utf8ByteLength(payload.prompt) > PROMPT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'prompt',
      message: '消息内容过长，超过单次发送上限，请删减后重试',
    };
  }
  return { ok: true };
}

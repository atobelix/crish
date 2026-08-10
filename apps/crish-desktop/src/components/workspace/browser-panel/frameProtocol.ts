/**
 * 帧二进制协议（P1-B1：12 字节小端定长头 + JPEG 负载，对齐 12 文档 §2.2）。
 *
 * 双端契约（改动需同步 Rust 侧 browser/frame_stream.rs `encode_frame`）：
 * ```text
 * 偏移 0-3   seq: u32     帧序号（丢帧统计/诊断用）
 * 偏移 4-7   width: u32   帧图宽度 px
 * 偏移 8-11  height: u32  帧图高度 px
 * 偏移 12+   JPEG 原始字节
 * ```
 * 纯函数层：零副作用，可独立单测。
 */

/** 定长头字节数。 */
export const FRAME_HEADER_BYTES = 12;

/** 解析后的帧消息（payload 为 JPEG 字节的 ArrayBuffer 切片）。 */
export interface ParsedFrame {
  seq: number;
  width: number;
  height: number;
  payload: ArrayBuffer;
}

/**
 * 解析帧消息：长度不足 12 字节 / 负载为空 → null（防御非法载荷）。
 * 前端收到 channel 消息（ArrayBuffer，Uint8Array 语义）后调用。
 */
export function parseFrameMessage(buffer: ArrayBuffer): ParsedFrame | null {
  if (!(buffer instanceof ArrayBuffer)) return null;
  if (buffer.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const seq = view.getUint32(0, true);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const payload = buffer.slice(FRAME_HEADER_BYTES);
  if (payload.byteLength === 0) return null;
  return { seq, width, height, payload };
}

/** JPEG 帧 → Blob（供 createImageBitmap 异步解码，不阻塞主线程）。 */
export function framePayloadToBlob(payload: ArrayBuffer): Blob {
  return new Blob([payload], { type: 'image/jpeg' });
}

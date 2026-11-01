// 纯 TS base64 / 采样编解码（不依赖 Hermes 是否提供 atob/btoa）。
// 原生桥数据通道约定：音频与采样一律以 base64 字节串过桥——
// 麦克风帧为 Int16 LE，VAD / 解码采样为 Float32 LE（JS 与 Android 均为小端）。

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 逆查表（ASCII 128 项，未登记字符为 -1） */
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charCodeAt(i)] = i;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b0 = bytes[i] ?? 0;
    const b1 = has1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = has2 ? (bytes[i + 2] ?? 0) : 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += has1 ? ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    out += has2 ? ALPHABET.charAt(b2 & 0x3f) : '=';
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\r\n\s]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - padding);
  let o = 0;
  const valueAt = (index: number): number => {
    const code = clean.charCodeAt(index);
    if (Number.isNaN(code) || code >= 128) return 0;
    const value = LOOKUP[code] ?? -1;
    return value < 0 ? 0 : value;
  };
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = valueAt(i);
    const c1 = valueAt(i + 1);
    const c2 = valueAt(i + 2);
    const c3 = valueAt(i + 3);
    if (o < out.length) out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}

/** Float32 采样 → base64（小端字节直通） */
export function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength
  );
  return bytesToBase64(bytes);
}

/** base64 → Float32 采样（拷贝到对齐缓冲，避免奇偏移视图） */
export function base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Float32Array(buffer);
}

/** base64 → Int16 采样（麦克风原始帧） */
export function base64ToInt16(base64: string): Int16Array {
  const bytes = base64ToBytes(base64);
  const buffer = new ArrayBuffer(bytes.byteLength - (bytes.byteLength % 2));
  new Uint8Array(buffer).set(bytes.subarray(0, buffer.byteLength));
  return new Int16Array(buffer);
}

/** Int16 PCM → Float32[-1,1]（规范采集格式换算） */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = (samples[i] ?? 0) / 32768.0;
  }
  return out;
}

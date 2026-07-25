import { TextDecoder, TextEncoder } from "node:util";

export type TextFileEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "gb18030" | "binary";
export type WritableTextFileEncoding = Exclude<TextFileEncoding, "gb18030" | "binary">;

export interface DecodedTextBuffer {
  text: string;
  encoding: TextFileEncoding;
  hasBom: boolean;
  bytes: number;
  writable: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

// 静态单例复用以减少 GC 压力
const sharedEncoder = new TextEncoder();
const sharedDecoders = new Map<string, TextDecoder>();

function getSharedDecoder(label: string, fatal = false): TextDecoder {
  const cacheKey = `${label}:${fatal}`;
  let decoder = sharedDecoders.get(cacheKey);
  if (!decoder) {
    decoder = new TextDecoder(label, fatal ? { fatal: true } : undefined);
    sharedDecoders.set(cacheKey, decoder);
  }
  return decoder;
}

export function decodeTextBuffer(bytes: Buffer): DecodedTextBuffer {
  if (startsWith(bytes, UTF8_BOM)) {
    return decodeWith("utf-8", bytes.subarray(UTF8_BOM.length), "utf-8-bom", true);
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return decodeWith("utf-16le", bytes.subarray(UTF16LE_BOM.length), "utf-16le", true);
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return decodeUtf16be(bytes.subarray(UTF16BE_BOM.length), true);
  }

  const inferredUtf16 = inferUtf16WithoutBom(bytes);
  if (inferredUtf16 === "utf-16le") return decodeWith("utf-16le", bytes, "utf-16le", false);
  if (inferredUtf16 === "utf-16be") return decodeUtf16be(bytes, false);

  if (looksBinary(bytes)) {
    return { text: "", encoding: "binary", hasBom: false, bytes: bytes.byteLength, writable: false };
  }

  try {
    return decodeWith("utf-8", bytes, "utf-8", false, true);
  } catch {
    // silent: utf-8 解码失败时降级为 gb18030 解码
    return decodeWith("gb18030", bytes, "gb18030", false);
  }
}

export function encodeTextBuffer(text: string, encoding: WritableTextFileEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(sharedEncoder.encode(text));
  }
  if (encoding === "utf-8-bom") {
    return Buffer.concat([UTF8_BOM, Buffer.from(sharedEncoder.encode(text))]);
  }
  if (encoding === "utf-16le") {
    return Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]);
  }
  return Buffer.concat([UTF16BE_BOM, swapUtf16Bytes(Buffer.from(text, "utf16le"))]);
}

export function isWritableTextEncoding(encoding: TextFileEncoding): encoding is WritableTextFileEncoding {
  return encoding === "utf-8" || encoding === "utf-8-bom" || encoding === "utf-16le" || encoding === "utf-16be";
}

function decodeWith(
  label: string,
  bytes: Buffer,
  encoding: TextFileEncoding,
  hasBom: boolean,
  fatal = false
): DecodedTextBuffer {
  const decoder = getSharedDecoder(label, fatal);
  return {
    text: decoder.decode(bytes),
    encoding,
    hasBom,
    bytes: bytes.byteLength + (hasBom ? bomLength(encoding) : 0),
    writable: isWritableTextEncoding(encoding)
  };
}

function decodeUtf16be(bytes: Buffer, hasBom: boolean): DecodedTextBuffer {
  const leBytes = swapUtf16Bytes(bytes);
  return {
    text: getSharedDecoder("utf-16le").decode(leBytes),
    encoding: "utf-16be",
    hasBom,
    bytes: bytes.byteLength + (hasBom ? UTF16BE_BOM.length : 0),
    writable: true
  };
}

function inferUtf16WithoutBom(bytes: Buffer): "utf-16le" | "utf-16be" | undefined {
  if (bytes.byteLength < 16) return undefined;
  const sampleLength = Math.min(bytes.byteLength, 512);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sampleLength; index++) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  const threshold = Math.floor(sampleLength / 8);
  if (oddNulls > threshold && evenNulls <= Math.max(1, Math.floor(oddNulls / 4))) return "utf-16le";
  if (evenNulls > threshold && oddNulls <= Math.max(1, Math.floor(evenNulls / 4))) return "utf-16be";
  return undefined;
}

// 采用更高效的字符分类方法
function looksBinary(bytes: Buffer): boolean {
  if (bytes.byteLength === 0) return false;
  const sampleLength = Math.min(bytes.byteLength, 1024);
  let controlBytes = 0;
  for (let index = 0; index < sampleLength; index++) {
    const byte = bytes[index]!;
    if (byte === 0) return true;
    if (byte < 8 || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  return controlBytes / sampleLength > 0.08;
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.byteLength >= prefix.byteLength && prefix.every((byte, index) => bytes[index] === byte);
}

function swapUtf16Bytes(bytes: Buffer): Buffer {
  const swapped = Buffer.from(bytes);
  // 用 Node.js Buffer 原生 swap16 替代 JS 手写循环，获得显著的速度提升
  swapped.swap16();
  return swapped;
}

function bomLength(encoding: TextFileEncoding): number {
  if (encoding === "utf-8-bom") return UTF8_BOM.length;
  if (encoding === "utf-16le") return UTF16LE_BOM.length;
  if (encoding === "utf-16be") return UTF16BE_BOM.length;
  return 0;
}


// 配对二维码载荷解析（Rust 真源：apps/agent-workbench/src-tauri/src/server/
// pairing.rs qr_data_for / PairStartResult.qr——格式 `crish-pair://<code>@<host>:<port>`，
// code 为 CXN-XXXX-XXXX-XXXX 人读回显形态；pair.rs:166 生成侧同源）。
//
// 说明：D3 §4.1 文档早期给出过 `conex-pair://...?v=1&s=...` 表述，桌面端
// 实际落地的二维码格式（R1-11 pairing.rs 实现）为 `crish-pair://` 形态；
// 本解析器以 Rust 实现为唯一真源（移动端必须与桌面端实际产出对齐才能配对）。
// 解析结果为领域组合类型：code 返回标准化 12 位（直接可入 pair.hello.code，
// Rust PairCode 序列化形态），host/port 供建立 WS 连接。

import { normalizePairCode, formatPairCode } from '@/domain/pure/cxnCode';
import { parseErr, parseOk } from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

/** 二维码载荷 scheme（与 Rust 生成侧字面量一致） */
export const QR_SCHEME = 'crish-pair://';

/** 端口合法范围（TCP 端口 1-65535） */
export const QR_MIN_PORT = 1;
export const QR_MAX_PORT = 65535;

/** 解析后的配对二维码载荷（领域组合类型，非 wire 形状） */
export interface QrPayload {
  /** 标准化 12 位配对码（无前缀无分隔符，可直接入 pair.hello.code） */
  code: string;
  /** 主机地址（IPv4 / 主机名；桌面生成侧仅下发可直连 IPv4） */
  host: string;
  /** 端口（1-65535） */
  port: number;
}

/** 构造二维码载荷的入参（code 容错：接受 12 位裸码或 CXN- 展示形态） */
export interface QrPayloadInput {
  code: string;
  host: string;
  port: number;
}

/**
 * 解析二维码载荷：`crish-pair://<code>@<host>:<port>` → { code, host, port }。
 * scheme 必须为 `crish-pair://`；code 段走 normalizePairCode 容错（大小写/
 * 分隔符/前缀均可忽略）；host 非空；port 为 1-65535 整数。任何不满足 → 错误。
 */
export function parseQrPayload(raw: string): ParseResult<QrPayload> {
  if (!raw.startsWith(QR_SCHEME)) {
    return parseErr(`二维码载荷必须以 ${QR_SCHEME} 开头`);
  }
  const rest = raw.slice(QR_SCHEME.length);
  if (rest.length === 0) {
    return parseErr('二维码载荷缺少 code@host:port 段');
  }
  const at = rest.lastIndexOf('@');
  if (at <= 0) {
    return parseErr('二维码载荷缺少 @ 分隔（应为 code@host:port）');
  }
  const codePart = rest.slice(0, at);
  const authority = rest.slice(at + 1);
  const colon = authority.lastIndexOf(':');
  if (colon <= 0 || colon === authority.length - 1) {
    return parseErr('二维码载荷缺少 host:port 段');
  }
  const host = authority.slice(0, colon);
  const portRaw = authority.slice(colon + 1);
  const codeCheck = normalizePairCode(codePart);
  if (!codeCheck.ok) {
    return parseErr(`配对码段非法：${codeCheck.error}`);
  }
  if (!/^\d+$/.test(portRaw)) {
    return parseErr(`端口必须为数字：${portRaw}`);
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < QR_MIN_PORT || port > QR_MAX_PORT) {
    return parseErr(`端口越界（${QR_MIN_PORT}-${QR_MAX_PORT}）：${portRaw}`);
  }
  return parseOk({ code: codeCheck.data, host, port });
}

/**
 * 构造二维码载荷串（对称面：与 Rust qr_data_for 逐字节同构，供测试对拍与
 * 未来反向场景）。code 容错输入，输出恒为 CXN-XXXX-XXXX-XXXX 展示形态。
 */
export function formatQrPayload(input: QrPayloadInput): ParseResult<string> {
  const display = formatPairCode(input.code);
  if (!display.ok) {
    return display;
  }
  if (input.host.length === 0) {
    return parseErr('主机地址不能为空');
  }
  if (
    !Number.isInteger(input.port) ||
    input.port < QR_MIN_PORT ||
    input.port > QR_MAX_PORT
  ) {
    return parseErr(`端口越界（${QR_MIN_PORT}-${QR_MAX_PORT}）：${input.port}`);
  }
  return parseOk(`${QR_SCHEME}${display.data}@${input.host}:${input.port}`);
}

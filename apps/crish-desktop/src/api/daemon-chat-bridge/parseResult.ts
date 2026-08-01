/**
 * 轻量解析结果判别联合（原 daemonEventSchema 的 ParseResult 部分）。
 *
 * C3.2：zod 协议校验层已删，协议契约以 shared-types 类型为准（Rust 侧事件桥测试锚定）。
 * 此处仅保留消费点做最小防御解析时共用的结果类型与收窄守卫，不承载任何协议校验。
 */

/** 成功支路：调用方经 isParseOk 收窄后可读 data */
export type ParseOk<T> = { readonly ok: true; readonly data: T };
/** 失败支路：调用方经 isParseErr 收窄后可读 error */
export type ParseErr = { readonly ok: false; readonly error: string };
/** 解析结果判别联合（ok 字面量区分支路） */
export type ParseResult<T> = ParseOk<T> | ParseErr;

/** 类型守卫：成功路径安全读 result.data */
export function isParseOk<T>(result: ParseResult<T>): result is ParseOk<T> {
  return result.ok === true;
}

/** 类型守卫：失败路径安全读 result.error */
export function isParseErr<T>(result: ParseResult<T>): result is ParseErr {
  return result.ok === false;
}

/** 构造成功结果（ok 恒为 true 字面量，利于收窄） */
export function parseOk<T>(data: T): ParseOk<T> {
  return { ok: true, data };
}

/** 构造失败结果（error 归一为非空字符串） */
export function parseErr(error: string): ParseErr {
  const msg = typeof error === 'string' ? error.trim() : '';
  return { ok: false, error: msg || 'parse failed' };
}

// 配对握手占位（D4 §5.1 / Z0 R2-03）：verify → token 两步 HTTP 交换
// 骨架实现恒返回未实现；R2-03 实现：/v1/pair/verify → /v1/pair/token →
// secure-store 持久化（token.access / token.refresh / pair.host_fingerprint）
export interface PairInput {
  host: string;
  /** CXN-XXXX-XXXX-XXXX 一次性配对码（D3 §4.1，10 分钟过期 / 5 次失败上限） */
  pin: string;
}

export interface PairResult {
  ok: boolean;
  /** 失败时的人类可读文案（错误码翻译由 R2-03 接 shared-types errors 面） */
  message?: string;
}

export async function pairWithHost(_input: PairInput): Promise<PairResult> {
  return { ok: false, message: '配对流程未实现（R2-03 落地）' };
}

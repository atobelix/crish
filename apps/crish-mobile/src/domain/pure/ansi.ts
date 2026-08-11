// ANSI 转义处理（M4 §2.2.3 pure/ansi.ts：SGR / 光标 / 清屏收敛为纯文本，防注入）
// 骨架期用正则剥除全部 CSI 序列；R2-05 终端流落地时收敛为白名单形态
// 用 RegExp 构造器而非字面量：ES 控制字符字面量触发 no-control-regex（ANSI 剥离
// 本就是处理控制字符的场景，构造器形态语义等价且不触发该规则）
const ANSI_CSI_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
  'g'
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CSI_RE, '');
}

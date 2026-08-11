// 二维码载荷解析占位（D3 §4.1 conex-pair:// 载荷 / Z0 R2-03）：扫码 P2 先行，
// 本骨架仅定义载荷形态；解析实现随 R2-03 落地
export interface QrPayload {
  scheme: 'conex-pair';
  /** 一次性配对码 */
  pin: string;
  /** 主机证书指纹（证书固定用，D4 §6.1.5） */
  hostFingerprint: string;
}

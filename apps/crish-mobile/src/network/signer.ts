// HMAC 签名器占位（M5 §4.2 / D3 §5.1）：R2-02 接 expo-crypto 实现 HMAC-SHA256
// canon 输入 = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v（定长字段拼接防重排）
export interface SignContext {
  deviceId: string;
  /** 会话令牌派生密钥（secure-store 存储，D3 §4.4） */
  tokenKey: string;
}

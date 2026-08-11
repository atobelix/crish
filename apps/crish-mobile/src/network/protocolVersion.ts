// 协议版本常量（D3 §10.2 版本协商）：与桌面 commandManifest 契约版本对齐
// 不匹配 → 拒绝连接并提示升级（D4 §6.4），不尝试兼容旧协议
export const PROTOCOL_VERSION = '0.1.0';
export const MIN_SUPPORTED_PROTOCOL_VERSION = '0.1.0';

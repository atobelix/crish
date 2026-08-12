// 跨端协议版本（D3 §10.1 三轨版本之一：DeviceEnvelope.v + hello.protocolVersion）
// 真源 = crates/conex-types/src/device/version.rs（PROTOCOL_VERSION = 1，
// MIN_PROTOCOL_VERSION = 1）；不匹配 → version_mismatch 拒绝连接并提示升级
// （D4 §6.4），不尝试兼容旧协议。
// 注：命令清单 contractVersion（manifest，semver）与 app 版本（semver）是
// 另外两个正交版本面（D3 §10.1 表），不在此混淆。
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

//! 多端互通模块族（multi-device）。
//!
//! 承载跨端网络能力的桌面侧实现。R1 阶段：
//! - `tls`：传输安全层——自签 CA / 叶子证书生命周期 / rustls 装配 / 指纹固定
//!   （任务包 R1-06，安全基线 D5 §2 的 TLS-01~10）。
//!
//! 与 `server` 模块（R1-02 服务骨架：路由/鉴权/配对状态机）相互独立：
//! server 负责协议与请求分发，本模块只负责 TLS 材料生成与装配，
//! 由 server 在启动 wss 监听时消费 [`tls::load_or_generate`]。
//!
//! 接线说明：本模块当前仅被 main.rs 挂载声明，实际消费方是并行开发的
//! R1-02（server 骨架）；在接线完成前模块整体属"未消费"库代码，按
//! buffer.rs / core_commands.rs 先例以 cfg_attr 豁免 dead_code（测试构建
//! 不豁免，R1-02 接线后应删除本属性）。
#![cfg_attr(not(test), allow(dead_code))]

pub mod tls;

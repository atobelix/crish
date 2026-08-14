//! C1 checkpoint 提示词内容模块（M5A；04 §2 C1 提示词协议层）
//!
//! 内容模块 = 纯文本产出，不持有业务逻辑（对齐 M1 约定：注入点挂载
//! 不持有业务逻辑；C1 只经 M1 注入点挂载）。M1 注入通道就绪后由
//! 壳层（engine.rs build_context）把本段拼接进 system 段；当前先
//! 实现内容本身，供快照断言与后续接线复用。
//!
//! 协议声明要点（对齐 C1 行为 1 与 M5 任务卡内容 3）：
//! - 周期性输出结构化检查点行标记（[CHECKPOINT_MARKER] / 别名
//!   [CONEX_CHECKPOINT_MARKER]，载荷形状见
//!   [conex_types::checkpoint::CheckpointPayload]）；
//! - 存在 checkpoint 时优先恢复：恢复时优先消费检查点再继续；
//! - checkpoint 由引擎采集、只读不写；system 消息永不进入检查点内容。

/// 系统提示词检查点协议声明段（固定内容，可作快照断言）
pub fn checkpoint_prompt_section() -> &'static str {
    r#"## 检查点协议
- 周期性输出一行结构化检查点：`CHECKPOINT: {"target":"当前目标","summary":"已完成摘要","timestamp":"2026-08-03T10:00:00.000Z","completed":["已完成步骤"],"files":["涉及文件"],"next":["下一步"]}`（前缀 `CONEX_CHECKPOINT` 同样识别）；
- 存在 checkpoint 时优先恢复：中断后的续跑先消费检查点摘要与目标剩余部分，再继续行动，不重跑已完成步骤；
- checkpoint 由引擎采集、只读不写（你不写入 checkpoint，引擎在安全点采集）；system 消息永不进入检查点内容。"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::checkpoint::{CHECKPOINT_MARKER, CONEX_CHECKPOINT_MARKER};

    /// 提示词内容含协议要素：行标记前缀、优先恢复语义、采集只读边界
    #[test]
    fn prompt_section_declares_checkpoint_protocol() {
        let section = checkpoint_prompt_section();
        assert!(section.contains(CHECKPOINT_MARKER), "声明主前缀");
        assert!(section.contains(CONEX_CHECKPOINT_MARKER), "声明别名前缀");
        assert!(
            section.contains("存在 checkpoint 时优先恢复"),
            "优先恢复语义"
        );
        assert!(
            section.contains("先消费检查点摘要与目标剩余部分"),
            "恢复输入语义"
        );
        assert!(section.contains("由引擎采集"), "采集只读边界");
        assert!(
            section.contains("system 消息永不进入检查点内容"),
            "system 永不参与"
        );
        assert!(section.contains("\"target\""), "载荷形状含目标字段");
        assert!(section.contains("\"next\""), "载荷形状含下一步字段");
    }

    /// 内容稳定：两次调用字节一致（快照断言面）
    #[test]
    fn prompt_section_is_stable() {
        assert_eq!(checkpoint_prompt_section(), checkpoint_prompt_section());
    }
}

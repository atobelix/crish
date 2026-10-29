use conex_types::message::AgentMessageBlock;

/// 拼接 text 块正文
pub(crate) fn joined_text(blocks: &[AgentMessageBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

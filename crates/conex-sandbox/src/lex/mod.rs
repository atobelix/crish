//! 命令行词法。全仓只保留这一套拆段与拆参。

mod quote;
mod tokenize;

pub(crate) use quote::extract_wrapped_content;
pub use tokenize::{
    normalize_token, split_command_args_normalized, split_segments, tokenize_segment,
};

/// 唯一拆段入口。返回去空白后的原始段，不含分类。
pub fn split(command_line: &str) -> Vec<String> {
    split_segments(command_line)
}

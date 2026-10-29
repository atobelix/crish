//! 命令行词法。全仓只保留这一套拆段与拆参。

mod quote;
mod tokenize;

pub(crate) use quote::extract_wrapped_content;
pub(crate) use tokenize::{
    normalize_token, split_command_args_normalized, split_segments,
};

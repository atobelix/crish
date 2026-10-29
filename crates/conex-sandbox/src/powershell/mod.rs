//! PowerShell 参数识别与编码载荷解码。

mod encoded;
mod flags;

pub use encoded::extract_and_decode_ps_payload;
pub use flags::{is_ps_encoded_command_flag, is_ps_working_directory_flag};

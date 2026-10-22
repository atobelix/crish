//! 命令语义分析层（I1-S1）：拆段 / 间接执行识别 / 字段级规范化 / 七类分类。
//!
//! 设计目标：静态正则必然被等价变形绕过（`rm -rf -- ./`、`&&` 链、PowerShell 变体），
//! 本模块先建"拆段 + 间接执行递归 + 规范化"底座，再产出七类分类，
//! 供 S2（极端危险拦截）、S4（删除形态重定向）、S6（git 回退面积）、
//! T-AB-05（禁 cd 语义层）消费。
//! lib.rs 的 gatekeeper 接入在 S2 完成，本模块保持纯函数、无 I/O。

/// 命令分类（七类：S1 规格六类 + T-AB-05 新增 cd 形态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    /// 普通命令（git status / npm test / ls 等）
    Normal,
    /// 确定性毁灭目标（rm -rf /、mkfs 等），100% 拦截层
    Redline,
    /// 常规危险形态（dd 写设备、curl|bash 等），需审批层
    Dangerous,
    /// 删除形态（rm / del / Remove-Item / git rm），走删除接管接口
    DeleteShape,
    /// git 回退形态（reset --hard / checkout 旧 ref 等），走回退护栏
    GitRevertShape,
    /// 间接执行（bash -c / eval / sudo 包裹），递归分析内层
    Indirect,
    /// cd 形态（cd / Set-Location / sl / pushd / popd，T-AB-05 禁 cd 语义层），
    /// 依赖进程内目录状态，命令面据此引导改用 Cwd 参数
    CdShape,
}

/// 单个命令段（拆段结果）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSegment {
    /// 段命令名（小写规范化）
    pub command: String,
    /// 段参数（引号剥离、转义还原后）
    pub args: Vec<String>,
    /// 段分类（递归分析后）
    pub class: CommandClass,
    /// 段内解析出的目标路径（删除形态用）
    pub targets: Vec<String>,
}

/// 整条命令行的语义分析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticAnalysis {
    /// 拆段列表
    pub segments: Vec<CommandSegment>,
    /// 整体分类（任一段 Redline 则 Redline；否则按优先级
    /// Dangerous > GitRevertShape > DeleteShape > CdShape > Indirect > Normal；
    /// T-AB-05：cd 形态与删除形态独立判定，链内同时命中时删除优先）
    pub overall_class: CommandClass,
    /// 聚合的删除目标（去重保序）
    pub delete_targets: Vec<String>,
    /// 聚合的 git 回退形态描述
    pub git_revert_forms: Vec<String>,
    /// 间接执行内层含删除形态（`bash -c 'rm x'` / `xargs rm` 等包裹，
    /// I2-S4：外层无法安全解析内层目标，命令面据此整链拦截 + 引导）
    pub has_indirect_delete: bool,
    /// 解码后的明文（若命令中包含 Base64 编码命令载荷，则为还原出的明文，用于审批与日志展示）
    pub decoded_payload: Option<String>,
}

/// 间接执行命令名（小写）
const INDIRECT_COMMANDS: &[&str] = &[
    "&",
    "eval",
    "source",
    ".",
    "bash",
    "sh",
    "zsh",
    "cmd",
    "cmd.exe",
    "pwsh",
    "powershell",
    "sudo",
    "xargs",
    "node",
    "nodejs",
    "bun",
    "deno",
    "python",
    "python3",
    "py",
    "pythonw",
    "ruby",
    "perl",
    "php",
    "find",
    "foreach-object",
    "iex",
    "invoke-expression",
    "start-process",
    "invoke-command",
    "icm",
];

/// 删除形态命令名（小写）
const DELETE_COMMANDS: &[&str] = &["rm", "rmdir", "del", "erase", "rd", "remove-item", "git"];

/// cd 形态命令名（小写，T-AB-05 禁 cd 语义层）：
/// Windows cmd 的 cd（含 cd /d、cd ..）、chdir、PowerShell 的 Set-Location 及其别名
/// cd / sl，以及 pushd / popd、Push-Location / Pop-Location 原生 Cmdlet
const CD_COMMANDS: &[&str] = &[
    "cd",
    "chdir",
    "set-location",
    "sl",
    "pushd",
    "popd",
    "push-location",
    "pop-location",
];

/// 危险形态命令名（小写，红线段对象）
const DANGEROUS_COMMANDS: &[&str] = &[
    "mkfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.xfs",
    "mkfs.btrfs",
    "format-volume",
    "clear-disk",
    "format",
    "dd",
    "stop-computer",
    "restart-computer",
];

/// 红线命令名（小写，确定性毁灭目标——S2 红线清单：mkfs/设备写入/盘符格式化/系统关机，
/// 与 01 方案 S2 红线清单及 workbench `*_blocks_eleven_red_line_targets` 测试对齐）
const REDLINE_COMMANDS: &[&str] = &[
    "mkfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.xfs",
    "mkfs.btrfs",
    "format-volume",
    "clear-disk",
    "format",
    "dd",
    "stop-computer",
    "restart-computer",
];

/// 解析命令行：拆分复合命令，逐段分析。
pub fn analyze(command_line: &str) -> SemanticAnalysis {
    analyze_depth(command_line, 0)
}

/// 包裹内容与间接递归分析的深度上限熔断（AST-04 / 加固项 10）：
/// 深度 >= 5 层 → 直接将命令判定为 Dangerous 熔断，杜绝 ReDoS / 栈溢出与深层穿透。
pub const MAX_RECURSION_DEPTH: usize = 5;
const MAX_WRAP_DEPTH: usize = 16;

/// 超限兜底分析结果：整体 Redline、无段（R2：深度 >16 → Redline）。
fn redline_only_analysis() -> SemanticAnalysis {
    SemanticAnalysis {
        segments: Vec::new(),
        overall_class: CommandClass::Redline,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

/// 递归超限熔断结果：整体 Dangerous（AST-04 / 加固项 10）。
fn dangerous_fallback_analysis() -> SemanticAnalysis {
    SemanticAnalysis {
        segments: Vec::new(),
        overall_class: CommandClass::Dangerous,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

/// 工作目录篡改分析结果：整体 CdShape（BC10-3：拦截 -WorkingDirectory / -wd 逃逸）。
fn cd_shape_analysis() -> SemanticAnalysis {
    SemanticAnalysis {
        segments: Vec::new(),
        overall_class: CommandClass::CdShape,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

pub(crate) fn analyze_depth_pub(command_line: &str, depth: usize) -> SemanticAnalysis {
    analyze_depth(command_line, depth)
}

/// 带包裹深度的分析入口（PS-01 T1.2 / AST-04）：根调用 depth=0，
/// 命令替换/反引号/scriptblock 包裹内容递归时 depth 逐层递增，
/// 超过 MAX_WRAP_DEPTH 即整体 Redline 阻断。
fn analyze_depth(command_line: &str, depth: usize) -> SemanticAnalysis {
    if depth > MAX_WRAP_DEPTH {
        return redline_only_analysis();
    }
    let raw_segments = split_segments(command_line);
    let mut segments = Vec::new();
    let mut delete_targets = Vec::new();
    let mut git_revert_forms = Vec::new();
    let mut has_indirect_delete = false;
    let mut decoded_payload = None;

    for seg in raw_segments {
        let (command, args) = split_command_args(&seg);
        let normalized = normalize_command(&command);
        let mut segment = CommandSegment {
            command: normalized.clone(),
            args: args.clone(),
            class: classify_depth(&normalized, &args, &seg, depth),
            targets: Vec::new(),
        };

        // 间接执行内层递归与删除形态标记（bash -c 'rm x' / & cmd /c rmdir / xargs rm 等——
        // 外层命令无法安全解析内层目标，命令面据此拦截 + 引导，防包裹绕过）
        if INDIRECT_COMMANDS.contains(&normalized.as_str())
            || segment.class == CommandClass::Indirect
        {
            let inner = analyze_indirect_depth(&seg, depth + 1);
            if inner.decoded_payload.is_some() && decoded_payload.is_none() {
                decoded_payload = inner.decoded_payload.clone();
            }
            if inner.overall_class == CommandClass::DeleteShape || inner.has_indirect_delete {
                has_indirect_delete = true;
            }
            if inner.overall_class == CommandClass::Redline {
                segment.class = CommandClass::Redline;
            }
            if inner.overall_class == CommandClass::Dangerous
                && segment.class != CommandClass::Redline
            {
                segment.class = CommandClass::Dangerous;
            }
            // BC10-3：若内层分析结果包含 CdShape，整链分类必须判定为 CdShape 或向上传播
            if (inner.overall_class == CommandClass::CdShape
                || inner
                    .segments
                    .iter()
                    .any(|s| s.class == CommandClass::CdShape))
                && segment.class != CommandClass::Redline
                && segment.class != CommandClass::Dangerous
            {
                segment.class = CommandClass::CdShape;
            }
            for t in inner.delete_targets {
                if !delete_targets.contains(&t) {
                    delete_targets.push(t);
                }
            }
        }

        if is_delete_command(&normalized) {
            segment.targets = extract_delete_targets(&normalized, &args);
            for t in &segment.targets {
                if !delete_targets.contains(t) {
                    delete_targets.push(t.clone());
                }
            }
        }
        if normalized == "git" {
            if let Some(form) = classify_git_revert(&args) {
                segment.class = CommandClass::GitRevertShape;
                if !git_revert_forms.contains(&form) {
                    git_revert_forms.push(form);
                }
            }
        }

        segments.push(segment);
    }

    let overall_class = overall(&segments);
    SemanticAnalysis {
        segments,
        overall_class,
        delete_targets,
        git_revert_forms,
        has_indirect_delete,
        decoded_payload,
    }
}

/// 复合命令拆段：`&&` / `;` / `||` / `|` / `|&` / 换行（`\n` / `\r\n`）拆分；
/// 引号内与转义符不拆。
fn split_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            current.push(c);
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                current.push(c);
            }
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        segments.push(trimmed.to_string());
                    }
                    current = String::new();
                } else if current.trim().is_empty() {
                    // Leading & is PowerShell call operator, not a command separator
                    current.push('&');
                } else {
                    // Trailing & is backgrounding / separator
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        segments.push(trimmed.to_string());
                    }
                    current = String::new();
                }
            }
            ';' | '|' => {
                // 处理 || / |& 双字符操作符
                if c == '|' && (chars.peek() == Some(&'|') || chars.peek() == Some(&'&')) {
                    chars.next();
                }
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    segments.push(trimmed.to_string());
                }
                current = String::new();
            }
            '\n' | '\r' => {
                // PS-01 T1.1（R1 ① 盲区）：换行是命令分隔符——模型输出
                // 以换行分隔两条命令（`printf x\n/bin/rm -rf -- /`）时
                // 必须拆为两段。\r\n 连续出现只拆一次：\r 后 peek 到 \n
                // 时吞掉，不产生空段；引号内（quote 状态）与转义后
                // （escaped 状态）不拆由上方两个状态分支天然覆盖。
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    segments.push(trimmed.to_string());
                }
                current = String::new();
            }
            _ => current.push(c),
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(trimmed.to_string());
    }
    segments
}

/// 提取包裹内容（PS-01 T1.2，R1 ② 盲区）：命令替换 `$()`、反引号、
/// scriptblock `{…}` 的包裹内容整体提取，供 classify 递归分析。
///
/// - `$(`…`)`：括号配对提取（可嵌套、支持转义 `\)`）；双引号内也提取
///   （bash 语义——`echo "$(rm -rf -- /)"` 正是 R1 形态 1）；
///   单引号内不提取（字面量）。
/// - 成对反引号 `` ` ``…`` ` ``：支持 `` \` `` 转义；双引号内反引号也
///   提取，单引号内不提取。
/// - `{`…`}` scriptblock：第一层花括号即整体边界（对齐
///   strip_scriptblock_braces 先例 :554-560）。
///
/// 嵌套深度不在此限制（配对计数只保证括号配平），递归深度由
/// analyze_depth / MAX_WRAP_DEPTH 兜底。
fn extract_wrapped_content(segment_raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = segment_raw.chars().peekable();
    let mut in_single = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_single {
            // 单引号内为字面量：$() / 反引号 / {…} 均不提取
            // （bash 语义，单引号内无转义）
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => {
                // 转义下一字符（覆盖 `\)`、`` \` ``、`\\(` 等形态）
                escaped = true;
            }
            '\'' => {
                in_single = true;
            }
            // 双引号不设状态：$() 与反引号在双引号内仍生效（bash 语义）
            '$' => {
                if chars.peek() == Some(&'(') {
                    chars.next();
                    if let Some(inner) = take_balanced(&mut chars, '(', ')') {
                        out.push(inner);
                    }
                }
            }
            '`' => {
                if let Some(inner) = take_until_backtick(&mut chars) {
                    out.push(inner);
                }
            }
            '{' => {
                if let Some(inner) = take_balanced(&mut chars, '{', '}') {
                    out.push(inner);
                }
            }
            _ => {}
        }
    }
    out
}

/// 取配对括号内容（不含首括号）：嵌套计数、支持转义（`\` 吞下一字符
/// 不计数）；括号不配平时返回 None。
fn take_balanced<I>(chars: &mut std::iter::Peekable<I>, open: char, close: char) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let mut depth = 1usize;
    let mut inner = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // 转义下一字符按字面量保留（不参与配对计数）
            if let Some(next) = chars.next() {
                inner.push(next);
            }
            continue;
        }
        if c == open {
            depth += 1;
            inner.push(c);
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(inner);
            }
            inner.push(c);
        } else {
            inner.push(c);
        }
    }
    None
}

/// 取成对反引号内容（不含反引号）：支持 `` \` `` 转义；
/// 遇行尾未闭合返回 None。
fn take_until_backtick<I>(chars: &mut std::iter::Peekable<I>) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let mut inner = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                inner.push(next);
            }
            continue;
        }
        if c == '`' {
            return Some(inner);
        }
        inner.push(c);
    }
    None
}

/// 转义需求字符判定（12-T-PD-03 Windows 路径语义）：
/// `\` 仅在紧跟这些字符时按转义处理（吞反斜杠、保后字符）；
/// 后跟普通路径字符（字母/数字/`.`/分隔符等）时反斜杠原样保留，
/// 使 `rm C:\temp\a.txt` 拆参后不被损坏成 `C:tempa.txt`。
/// 集合覆盖 shell 元字符与空白（Unix 形态安全网：`\` 后跟空白/引号仍按转义处理）；
/// 单引号内反斜杠恒为字面量（Unix 语义），不在此判定。
fn is_escape_requiring(c: char) -> bool {
    c.is_whitespace()
        || c == '\''
        || c == '"'
        || c == '\\'
        || c == '$'
        || c == '`'
        || c == ';'
        || c == '&'
        || c == '|'
        || c == '('
        || c == ')'
        || c == '<'
        || c == '>'
}

/// 规范化拆分命令行 Token，彻底剥离反引号与非单引号转义符
pub fn split_command_args_normalized(segment: &str) -> (String, Vec<String>) {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = segment.chars().peekable();

    while let Some(c) = chars.next() {
        // 1. 单引号上下文：内部字符严格原样保留，绝对不转义
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            } else {
                current.push(c);
            }
            started = true;
            continue;
        }

        // 2. 双引号上下文：反引号 ` 作为转义符，转义下一个字符（如 `"r`i"` -> `"ri"`）
        if quote == Some('"') {
            if c == '"' {
                quote = None;
            } else if c == '`' {
                if let Some(next_c) = chars.next() {
                    current.push(next_c);
                }
            } else {
                current.push(c);
            }
            started = true;
            continue;
        }

        // 3. 无引号上下文：处理 PowerShell 反引号 ` 与 Windows 路径反斜杠 \
        if c == '`' {
            if let Some(next_c) = chars.next() {
                current.push(next_c);
                started = true;
            }
            continue;
        }

        if c == '\\' {
            // 盘符上下文（PS-01 T1.4）：current 形如 `X:`（字母+冒号）时，
            // 本 `\` 是 Windows 盘符根路径分隔符（`C:\ -Recurse` 形态——
            // R1 形态 4 的 `ri C:\ -Recurse -Force`），后跟空白/元字符
            // 不按 Unix 转义处理（否则 `C:\` 被损坏成 `C:`，盘符根红线
            // 判定落空）。非盘符上下文（`echo a\ b` 等 Unix 转义形态）
            // 保持既有行为不变。
            let after_drive = current.len() >= 2
                && current.as_bytes()[current.len() - 2].is_ascii_alphabetic()
                && current.as_bytes()[current.len() - 1] == b':';
            if let Some(&next_c) = chars.peek() {
                if is_escape_requiring(next_c) && !after_drive {
                    chars.next();
                    current.push(next_c);
                    started = true;
                    continue;
                }
            }
            current.push(c);
            started = true;
            continue;
        }

        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            c if c.is_whitespace() => {
                if started && !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                started = false;
            }
            _ => {
                current.push(c);
                started = true;
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.is_empty() {
        (String::new(), Vec::new())
    } else {
        let command = tokens.remove(0);
        (command, tokens)
    }
}

/// 拆分段为（命令, 参数）：委托 split_command_args_normalized（反混淆状态机）
fn split_command_args(segment: &str) -> (String, Vec<String>) {
    split_command_args_normalized(segment)
}

/// 语法完备的 PowerShell Base64 开关识别器
/// 支持所有官方合法前缀与短名（-ec, -eco, -ecom, -en, -enc, -enco, /ec, -ec:, -EncodedCommand= 等），排除 -ex 开头
pub fn is_ps_encoded_command_flag(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    let stripped = if let Some(s) = lower.strip_prefix("--") {
        s
    } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
        s
    } else {
        return false;
    };
    let flag_name = stripped.split(['=', ':']).next().unwrap_or(stripped);
    if flag_name.is_empty() {
        return false;
    }
    // 排除 -ex 开头（唯一指向 ExecutionPolicy，如 -executionpolicy, -ex, -exec 等）
    if flag_name.starts_with("ex") {
        return false;
    }
    // 1. 驼峰前缀缩写表（PowerShell 参数绑定 Acronym matching）：
    // -ec, -eco, -ecom, -ecomm, -ecomma, -ecomman, -ecommand
    if flag_name.starts_with("ec") {
        return true;
    }
    // 2. 连续前缀唯一匹配（-e* 系列中唯一非 -ExecutionPolicy 的分支）：
    // -e, -en, -enc, -enco, -encod, -encode, -encoded, -encodedc...
    if "encodedcommand".starts_with(flag_name) {
        return true;
    }
    false
}

/// 识别 PowerShell 的 -WorkingDirectory (-wd) 启动参数（BC10-3：拦截启动参数工作目录逃逸）
pub fn is_ps_working_directory_flag(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    let stripped = if let Some(s) = lower.strip_prefix("--") {
        s
    } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
        s
    } else {
        return false;
    };
    let flag_name = stripped.split(['=', ':']).next().unwrap_or(stripped);
    if flag_name.is_empty() {
        return false;
    }
    if flag_name == "wd" {
        return true;
    }
    if "workingdirectory".starts_with(flag_name) && flag_name.starts_with("work") {
        return true;
    }
    false
}

/// 基础 Base64 解码器（支持标准模式与 URL-safe 模式，忽略空白字符）
fn decode_base64_payload(input: &str) -> Option<Vec<u8>> {
    let clean = input.trim().trim_matches(['"', '\'']);
    let mut buf = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;

    for byte in clean.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            break;
        }
        let val: u32 = match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a' + 26) as u32,
            b'0'..=b'9' => (byte - b'0' + 52) as u32,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push(((accumulator >> bits) & 0xFF) as u8);
        }
    }
    if buf.is_empty() {
        None
    } else {
        Some(buf)
    }
}

/// 提取 PowerShell Base64 载荷并执行 UTF-16LE / UTF-8 双模安全解码
pub fn extract_and_decode_ps_payload(args: &[String]) -> Option<String> {
    for (idx, arg) in args.iter().enumerate() {
        if is_ps_encoded_command_flag(arg) {
            let lower = arg.to_lowercase();
            let stripped = if let Some(s) = lower.strip_prefix("--") {
                s
            } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
                s
            } else {
                continue;
            };

            let raw_payload = if let Some(pos) = stripped.find([':', '=']) {
                let prefix_len = if arg.starts_with("--") {
                    2
                } else if arg.starts_with('-') || arg.starts_with('/') {
                    1
                } else {
                    0
                };
                arg[prefix_len + pos + 1..].trim()
            } else {
                args.get(idx + 1).map(|s| s.as_str()).unwrap_or("").trim()
            };

            let clean_payload = raw_payload.trim_matches(['"', '\'']);
            if clean_payload.is_empty() {
                continue;
            }

            if let Some(bytes) = decode_base64_payload(clean_payload) {
                // 1. 若含 null 字节且长度为偶数，优先按 PowerShell 原生 UTF-16LE 解码
                let has_null = bytes.contains(&0);
                if has_null && bytes.len() % 2 == 0 {
                    let u16_chars: Vec<u16> = bytes
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    if let Ok(utf16_str) = String::from_utf16(&u16_chars) {
                        return Some(utf16_str);
                    }
                }

                // 2. 尝试 UTF-8 解码
                if let Ok(utf8_str) = String::from_utf8(bytes.clone()) {
                    if !utf8_str.is_empty() {
                        return Some(utf8_str);
                    }
                }

                // 3. 兜底尝试 UTF-16LE
                if bytes.len() % 2 == 0 {
                    let u16_chars: Vec<u16> = bytes
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    if let Ok(utf16_str) = String::from_utf16(&u16_chars) {
                        return Some(utf16_str);
                    }
                }
            }
        }
    }
    None
}

/// 识别单 Token 的危险特征（.NET 动态反射、进程启动与环境变量求值）
pub fn analyze_token_danger(token: &str) -> Option<CommandClass> {
    let lower = token.to_lowercase();

    // 1. 拦截 .NET 动态进程启动与反射代码生成 -> 直接 Redline 阻断
    if lower.starts_with("[system.diagnostics.process]")
        || lower.contains("::start")
        || lower.starts_with("[scriptblock]")
        || lower.contains("::create")
        || lower.starts_with("[powershell]")
        || lower.starts_with("[system.appdomain]")
        || lower.starts_with("[system.reflection.")
    {
        return Some(CommandClass::Redline);
    }

    // 2. 拦截环境变量动态拼接与非常规求值 -> 提升为 Dangerous 触发人工确认
    if lower.contains("$env:comspec") || lower.contains("$env:systemroot") {
        return Some(CommandClass::Dangerous);
    }

    None
}

/// 分析段内语法特征与间接/反射执行（AST 门禁）
pub fn analyze_segment_ast(command: &str, args: &[String], depth: usize) -> CommandClass {
    if depth >= MAX_RECURSION_DEPTH {
        return CommandClass::Dangerous; // 深度防爆熔断
    }

    // 1. 检查首 Token 与所有参数的危险反射特征
    if let Some(danger) = analyze_token_danger(command) {
        return danger;
    }
    for arg in args {
        if let Some(danger) = analyze_token_danger(arg) {
            return danger;
        }
    }

    // 2. 检查呼叫操作符 & $var / &(...) / &{...} / $(...)
    if command == "&" && !args.is_empty() {
        let target = &args[0];
        if target.starts_with('$') || target.starts_with('(') || target.starts_with('{') {
            return CommandClass::Dangerous;
        }
    }
    if command.starts_with("$(") || command.starts_with("&(") || command.starts_with("&{") {
        return CommandClass::Dangerous;
    }
    if command.starts_with('$')
        && !args.first().map(|a| a == "=").unwrap_or(false)
        && !PRINT_WHITELIST.contains(&command)
    {
        return CommandClass::Dangerous;
    }

    // 3. 检查 WorkingDirectory 启动参数与 Base64 编码开关变形 (powershell / pwsh)
    let lower_cmd = command.to_lowercase();
    if lower_cmd == "powershell" || lower_cmd == "pwsh" {
        if args.iter().any(|a| is_ps_working_directory_flag(a)) {
            return CommandClass::CdShape;
        }
        for arg in args {
            if is_ps_encoded_command_flag(arg) {
                if let Some(decoded) = extract_and_decode_ps_payload(args) {
                    let inner = analyze_depth(&decoded, depth + 1);
                    return inner.overall_class;
                } else {
                    return CommandClass::Redline;
                }
            }
        }
    }

    // 4. 检查 % (ForEach-Object) 管道与花括号内 ScriptBlock 递归提取
    if lower_cmd == "%" || lower_cmd == "foreach-object" {
        for arg in args {
            if arg.starts_with('{') && arg.ends_with('}') && arg.len() >= 2 {
                let inner = &arg[1..arg.len() - 1];
                let (sub_cmd, sub_args) = split_command_args_normalized(inner);
                if !sub_cmd.is_empty() {
                    let sub_norm = normalize_command(&sub_cmd);
                    if is_delete_command(&sub_norm) {
                        return CommandClass::Dangerous;
                    }
                    let sub_class = analyze_segment_ast(&sub_norm, &sub_args, depth + 1);
                    if sub_class == CommandClass::Redline || sub_class == CommandClass::Dangerous {
                        return sub_class;
                    }
                }
            }
        }
    }

    CommandClass::Normal
}

/// 命令名规范化：小写、去路径前缀（/bin/rm -> rm）、去 .exe 扩展名
/// （powershell.exe -> powershell，12-T-PD-04 ML5 顺带：
/// cmd.exe / del.exe 等 Windows 可执行文件形态一并命中既有清单）。
fn normalize_command(command: &str) -> String {
    let trimmed = command.trim();
    let name = if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    // 去路径前缀（支持 / 与 \）
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    // 去 .exe 扩展名（大小写不敏感）：扩展名剥除后再小写归一，
    // 使 powershell.exe / cmd.exe / del.exe 与 INDIRECT_COMMANDS / DELETE_COMMANDS 对齐
    let stem = {
        let bytes = base.as_bytes();
        let n = bytes.len();
        if n >= 4 && bytes[n - 4..].eq_ignore_ascii_case(b".exe") {
            &base[..n - 4]
        } else {
            base
        }
    };
    let lower = stem.to_lowercase();
    // PS-01 T1.4（R1 ④ 修复建议 6）：PowerShell 删除别名归一
    // `ri` → `remove-item`（Remove-Item 别名）——对齐 `sl`/`pushd`
    // 直列 CD_COMMANDS 的做法：采用归一而非清单膨胀，使
    // `ri C:\ -Recurse -Force` 命中既有盘符根红线判定。
    if lower == "ri" {
        return "remove-item".to_string();
    }
    // % → foreach-object（ForEach-Object 管道别名）
    if lower == "%" {
        return "foreach-object".to_string();
    }
    if lower == "icm" {
        return "invoke-command".to_string();
    }
    lower
}

fn is_delete_command(cmd: &str) -> bool {
    DELETE_COMMANDS.contains(&cmd)
}

/// 删除命令分类判定（PS-01 T1.4 提炼，供 classify_depth 段首分支与
/// token 级扫描共用）：提取目标 + 盘符根红线判定（rd /s /q C:\、
/// remove-item -Recurse -Force 盘符根 → Redline，其余 → DeleteShape）；
/// 非删除命令（含 git——git 只走回退形态分支）返回 None。
fn classify_delete_command(command: &str, args: &[String]) -> Option<CommandClass> {
    if !is_delete_command(command) || command == "git" {
        return None;
    }
    let targets = extract_delete_targets(command, args);
    if command == "rm"
        || command == "rmdir"
        || command == "del"
        || command == "erase"
        || command == "rd"
        || command == "remove-item"
    {
        // Windows 风格参数（rd /s /q、del /f /q）与 Unix 风格（-r -f）都算
        let win_recursive = args
            .iter()
            .any(|a| a.eq_ignore_ascii_case("/s") || a.eq_ignore_ascii_case("/S"));
        let win_force = args
            .iter()
            .any(|a| a.eq_ignore_ascii_case("/q") || a.eq_ignore_ascii_case("/f"));
        let recursive = has_recursive(args) || win_recursive;
        let force = has_force(args) || win_force;
        if targets.iter().any(|t| is_root_target(t)) && (recursive || force) {
            return Some(CommandClass::Redline);
        }
    }
    Some(CommandClass::DeleteShape)
}

/// PS-01 T1.4（F3-01 修复建议 2）：token 级「疑似命令名」扫描。
/// 触发条件（D5）：
/// ① 段首命令为赋值形态（首 token `$var` 后跟 `=`）——`$x = Remove-Item
///    C:\ -Recurse -Force` 形态的段首命令名不是删除命令，删除命令藏在
///    参数里；
/// ② 段首命令不在任何已知清单且不在打印白名单（echo / write-output /
///    printf / cat / grep / type）——白名单负例防 `echo rm -rf /` 误拦。
/// 对后续参数 token 逐个做疑似命令名判定（normalize 归一小写、剥引号/
/// 路径前缀），命中 REDLINE / DELETE / INDIRECT 清单即按该命令的既有
/// 分类逻辑判定本段（删除命令复用 classify_delete_command）。
const PRINT_WHITELIST: &[&str] = &["echo", "write-output", "printf", "cat", "grep", "type"];

fn scan_ps_command_tokens(command: &str, args: &[String]) -> Option<CommandClass> {
    let is_assignment = command.starts_with('$') && args.first().map(|a| a == "=").unwrap_or(false);
    let is_known = INDIRECT_COMMANDS.contains(&command)
        || DELETE_COMMANDS.contains(&command)
        || CD_COMMANDS.contains(&command)
        || REDLINE_COMMANDS.contains(&command)
        || DANGEROUS_COMMANDS.contains(&command)
        || PRINT_WHITELIST.contains(&command);
    if !is_assignment && is_known {
        return None;
    }
    // 赋值形态跳过 $var 与 `=` 两个 token，从命令名开始扫描
    let start = if is_assignment { 1 } else { 0 };
    for (i, t) in args[start..].iter().enumerate() {
        let cand = normalize_command(t);
        if REDLINE_COMMANDS.contains(&cand.as_str()) {
            return Some(CommandClass::Redline);
        }
        if DELETE_COMMANDS.contains(&cand.as_str()) {
            // 命中删除命令：该 token 之后的内容作为其参数，按既有
            // 删除分类逻辑判定（盘符根 + 递归/强制 → Redline）
            let rest: Vec<String> = args[start + i + 1..].to_vec();
            return classify_delete_command(&cand, &rest);
        }
        if INDIRECT_COMMANDS.contains(&cand.as_str()) {
            let sub_line = args[start + i..].join(" ");
            let inner_analysis = analyze_depth(&sub_line, 1);
            if inner_analysis.overall_class == CommandClass::Redline {
                return Some(CommandClass::Redline);
            }
            if inner_analysis.overall_class == CommandClass::Dangerous {
                return Some(CommandClass::Dangerous);
            }
            if inner_analysis.overall_class == CommandClass::DeleteShape
                || inner_analysis.has_indirect_delete
            {
                return Some(CommandClass::Indirect);
            }
            return Some(CommandClass::Indirect);
        }
    }
    None
}

/// 归一化参数：剥离 --，返回有效参数列表（-- 之后的作为位置参数保留语义但标记）。
fn strip_double_dash(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut effective = Vec::new();
    let mut positional = Vec::new();
    let mut after_dd = false;
    for a in args {
        if after_dd {
            positional.push(a.clone());
        } else if a == "--" {
            after_dd = true;
        } else {
            effective.push(a.clone());
        }
    }
    (effective, positional)
}

/// 删除目标的参数解析（rm 的路径参数）。
fn extract_delete_targets(command: &str, args: &[String]) -> Vec<String> {
    if command == "git" {
        // git rm <path...>
        let mut targets = Vec::new();
        let mut after_rm = false;
        let mut skip_next = false;
        for a in args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if !after_rm {
                if a == "rm" {
                    after_rm = true;
                }
                continue;
            }
            if a == "--" || a == "-r" || a == "-f" || a == "-rf" || a == "-fr" || a == "--cached" {
                continue;
            }
            if a.starts_with('-') {
                // 可能是 -r -f 组合或 --cached，跳过；若带值的选项（--ignore-unmatch 无值）忽略
                continue;
            }
            targets.push(a.clone());
        }
        return targets;
    }

    let (effective, positional) = strip_double_dash(args);
    let mut targets = Vec::new();
    // rm 的短选项：-r -f -R -rf -fr -v -d 等；长选项：--recursive --force --dir 等
    for a in effective.iter().chain(positional.iter()) {
        if a.starts_with('-') {
            continue;
        }
        // ML3 闭环：Windows 风格开关（rd /s /q、del /f /q 等）不入 targets；
        // 判定口径：归一小写后精确匹配 /s /q /f，其余 `/` 开头（Unix 绝对路径 /tmp/x）
        // 保持现状入 targets；单字符 Unix 目录名（如 rm /s）被一并跳过为可接受边界——
        // Windows 风格开关优先，删除目标失真风险远大于该极端目录名形态
        let lower = a.to_lowercase();
        if lower == "/s" || lower == "/q" || lower == "/f" {
            continue;
        }
        if a.starts_with("C:") || a.starts_with('C') && a.len() >= 2 && a.as_bytes()[1] == b':' {
            // Windows 盘符路径
            targets.push(a.clone());
        } else if a.starts_with('/')
            || a.starts_with("./")
            || a.starts_with("../")
            || a == "."
            || a == ".."
            || a == "~"
        {
            targets.push(a.clone());
        } else if command == "rm"
            || command == "rmdir"
            || command == "del"
            || command == "erase"
            || command == "rd"
            || command == "remove-item"
        {
            // 无前缀的普通路径（rm foo.txt）
            targets.push(a.clone());
        }
    }
    targets
}

/// 判定路径是否解析为根/盘符根（rm -rf / 归一后 Redline）。
fn is_root_target(target: &str) -> bool {
    let normalized = target.trim();
    if normalized == "/" || normalized == "*" || normalized == "/*" {
        return true;
    }
    // Windows 盘符根：恰好 "C:\" / "C:/" / "C:"（后面不能再有路径成分）
    let lower = normalized.to_lowercase();
    if lower.len() >= 2 && lower.as_bytes()[0].is_ascii_alphabetic() && lower.as_bytes()[1] == b':'
    {
        if lower.len() == 2 {
            return true;
        }
        if lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/' {
            // 仅当盘符根后直接结束（C:\ 或 C:/），或仅跟通配根（C:\*）
            let rest = &lower[3..];
            return rest.is_empty() || rest == "*" || rest == "\\*" || rest == "/*";
        }
    }
    false
}

/// 短选项归一：-r/-R 与 --recursive 等价；-f 与 --force 等价。
fn has_recursive(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "-r"
            || a == "-R"
            || a == "--recursive"
            || a == "-rf"
            || a == "-fr"
            || a == "-rF"
            || (a.starts_with('-') && a.len() > 1 && a[1..].chars().any(|c| c == 'r' || c == 'R'))
    })
}

fn has_force(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "-f"
            || a == "--force"
            || a == "-rf"
            || a == "-fr"
            || a == "-fR"
            || a == "-rF"
            || (a.starts_with('-') && a.len() > 1 && a[1..].chars().any(|c| c == 'f'))
    })
}

/// 递归分析间接执行的内层命令内容。
pub fn analyze_indirect(segment_raw: &str) -> SemanticAnalysis {
    analyze_indirect_depth(segment_raw, 0)
}

pub fn analyze_indirect_depth(segment_raw: &str, depth: usize) -> SemanticAnalysis {
    if depth >= MAX_RECURSION_DEPTH {
        return dangerous_fallback_analysis();
    }
    // 提取 -c 之后的字符串参数作为内层命令
    let (command, args) = split_command_args(segment_raw);
    let normalized = normalize_command(&command);

    // BC10-2: 多语言解释器内联脚本深度审计引擎优先审查
    if let Some(kind) = crate::polyglot::PolyglotCodeInspector::detect_interpreter(&normalized) {
        // PowerShell 专有 base64 编码隐藏形态与 WorkingDirectory 启动参数目录逃逸（BC10-1 & BC10-3）
        if kind == crate::polyglot::InterpreterKind::PowerShell {
            let has_wd = args.iter().any(|a| is_ps_working_directory_flag(a));
            let has_enc = args.iter().any(|a| is_ps_encoded_command_flag(a));
            if has_enc {
                if let Some(decoded_str) = extract_and_decode_ps_payload(&args) {
                    let mut decoded = analyze_depth(&decoded_str, depth + 1);
                    decoded.decoded_payload = Some(decoded_str);
                    if has_wd && decoded.overall_class == CommandClass::Normal {
                        decoded.overall_class = CommandClass::CdShape;
                    }
                    return decoded;
                } else {
                    return redline_only_analysis();
                }
            }
            if has_wd {
                return cd_shape_analysis();
            }
        }
        if let Some(script) =
            crate::polyglot::PolyglotCodeInspector::extract_inline_script(kind, &args)
        {
            return match crate::polyglot::PolyglotCodeInspector::inspect_script(
                kind, &script, depth,
            ) {
                Ok(analysis) => analysis,
                Err(err) => {
                    // 规则引擎不可用属安全边界故障：fail-closed 阻断（物理红线），绝不放行内联脚本
                    eprintln!(
                        "[conex-sandbox] 内联脚本审查规则不可用，按物理红线阻断（fail-closed）：{err}"
                    );
                    redline_only_analysis()
                }
            };
        }
    }

    let inner = match normalized.as_str() {
        "&" => {
            if args.is_empty() {
                None
            } else {
                let inner_line = args.join(" ");
                Some(inner_line)
            }
        }
        "invoke-command" | "icm" => {
            let mut inner: Option<String> = None;
            let mut iter = args.iter();
            while let Some(a) = iter.next() {
                if a.eq_ignore_ascii_case("-ScriptBlock") || a.eq_ignore_ascii_case("-Command") {
                    let rest: Vec<&String> = iter.by_ref().collect();
                    if !rest.is_empty() {
                        let joined = rest
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(" ");
                        inner = Some(strip_scriptblock_braces(&joined));
                    }
                    break;
                }
            }
            if inner.is_none() && !args.is_empty() {
                let joined = args.join(" ");
                inner = Some(strip_scriptblock_braces(&joined));
            }
            inner
        }
        "bash" | "sh" | "zsh" | "cmd" | "cmd.exe" | "pwsh" | "powershell" | "node" | "nodejs"
        | "bun" | "deno" | "python" | "python3" | "py" | "pythonw" | "ruby" | "perl" | "php" => {
            if normalized == "pwsh" || normalized == "powershell" {
                let has_wd = args.iter().any(|a| is_ps_working_directory_flag(a));
                let has_enc = args.iter().any(|a| is_ps_encoded_command_flag(a));
                if has_enc {
                    if let Some(decoded_str) = extract_and_decode_ps_payload(&args) {
                        let mut decoded = analyze_depth(&decoded_str, depth + 1);
                        decoded.decoded_payload = Some(decoded_str);
                        if has_wd && decoded.overall_class == CommandClass::Normal {
                            decoded.overall_class = CommandClass::CdShape;
                        }
                        return decoded;
                    } else {
                        return redline_only_analysis();
                    }
                }
                if has_wd {
                    return cd_shape_analysis();
                }
            }
            // 找 -c / -Command / /c 后的所有剩余参数（join 保留空格，恢复内层命令全文）；
            // -e / -E 已移出此分支（见上）
            let mut inner: Option<String> = None;
            let mut iter = args.iter();
            while let Some(a) = iter.next() {
                if a.eq_ignore_ascii_case("-c")
                    || a.eq_ignore_ascii_case("-command")
                    || a.eq_ignore_ascii_case("/c")
                {
                    let rest: Vec<&String> = iter.by_ref().collect();
                    if !rest.is_empty() {
                        inner = Some(
                            rest.iter()
                                .map(|s| s.as_str())
                                .collect::<Vec<_>>()
                                .join(" "),
                        );
                    }
                    break;
                }
                if a.to_lowercase().starts_with("-command") && a.len() > 8 {
                    inner = Some(a[8..].trim_start_matches(['=', ':']).trim().to_string());
                    break;
                }
                if a.to_lowercase().starts_with("/c") && a.len() > 2 {
                    inner = Some(a[2..].trim_start().to_string());
                    break;
                }
            }
            inner
        }
        "eval" | "source" | "." => {
            // 剩余参数拼接为内层命令
            Some(args.join(" "))
        }
        "sudo" | "xargs" => {
            // 剩余参数为内层命令（sudo bash -c '...' 时 bash 会再被递归）
            Some(args.join(" "))
        }
        "iex" | "invoke-expression" => {
            // PS-01 T1.3（R3 修订）：iex / Invoke-Expression 的剩余参数
            // 即被解析执行的内层命令（`iex 'rm -rf -- /'` → 提取引号剥离
            // 后的参数串），join 后递归 analyze（对齐 eval/sudo 先例）
            Some(args.join(" "))
        }
        "start-process" => {
            // PS-01 T1.3（R3 修订）：Start-Process 启动新进程执行指定命令，
            // 内层命令藏在 -ArgumentList / -Argument / -Args 参数后
            // （`Start-Process cmd -ArgumentList '/c rm -rf -- /'`）。
            // 只提取该参数后的内容——普通形态（Start-Process notepad.exe，
            // 无参数列表）不提取，避免整段误升级。
            // 内层首 token 为 cmd 风格 /c（Start-Process cmd -ArgumentList
            // '/c …'）时剥除：不剥则 analyze 把 /c 当命令名（路径前缀
            // 剥离归一到 c）→ 落空 Normal → 放行。
            let mut inner: Option<String> = None;
            let mut iter = args.iter();
            while let Some(a) = iter.next() {
                if a.eq_ignore_ascii_case("-ArgumentList")
                    || a.eq_ignore_ascii_case("-Argument")
                    || a.eq_ignore_ascii_case("-Args")
                {
                    let rest: Vec<&String> = iter.by_ref().collect();
                    if !rest.is_empty() {
                        let joined = rest
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(" ");
                        let stripped = joined.trim_start();
                        inner = Some(
                            stripped
                                .strip_prefix("/c")
                                .map(|s| s.trim_start().to_string())
                                .unwrap_or_else(|| joined.clone()),
                        );
                    }
                    break;
                }
            }
            inner
        }
        "find" => {
            // find ... -exec cmd {} \; 提取 cmd
            let mut inner: Option<String> = None;
            let mut iter = args.iter().peekable();
            while let Some(a) = iter.next() {
                if a == "-exec" || a == "-execdir" {
                    let mut cmd_parts = Vec::new();
                    for nxt in iter.by_ref() {
                        if nxt == ";" || nxt == "{}" || nxt == "+" {
                            break;
                        }
                        cmd_parts.push(nxt.clone());
                    }
                    if !cmd_parts.is_empty() {
                        inner = Some(cmd_parts.join(" "));
                    }
                    break;
                }
            }
            inner
        }
        "foreach-object" => {
            // 12-T-PD-04（A2-M2）：scriptblock 删除形态识别。
            // 形态 A：遇 -Process 取其后的剩余全部参数 join（对齐 bash -c rest 拼接先例）；
            // 形态 B：首 token 以 { 开头时，自该 token 起至 } 终止的序列剥花括号后 join
            // （$_ / $_.FullName 等管道变量按普通 token 保留）——两形态结果统一
            // 剥首尾花括号后递归 analyze()（对齐 find -exec 拼接先例）。
            // 边界（任务卡文档化）：嵌套花括号与字符串字面量内的花括号不做配对处理，
            // 第一层花括号即 scriptblock 整体边界；内层复合命令由 analyze 自然拆段。
            let mut inner: Option<String> = None;
            let mut iter = args.iter();
            while let Some(a) = iter.next() {
                if a == "-Process" {
                    let rest: Vec<&String> = iter.by_ref().collect();
                    if !rest.is_empty() {
                        let joined = rest
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(" ");
                        inner = Some(strip_scriptblock_braces(&joined));
                    }
                    break;
                }
                if a.starts_with('{') {
                    let mut parts = vec![a.clone()];
                    for nxt in iter.by_ref() {
                        parts.push(nxt.clone());
                        if nxt.contains('}') {
                            break;
                        }
                    }
                    inner = Some(strip_scriptblock_braces(&parts.join(" ")));
                    break;
                }
            }
            inner
        }
        _ => None,
    };

    match inner {
        Some(inner_cmd) if !inner_cmd.trim().is_empty() => analyze_depth(&inner_cmd, depth + 1),
        _ => SemanticAnalysis {
            segments: Vec::new(),
            overall_class: CommandClass::Normal,
            delete_targets: Vec::new(),
            git_revert_forms: Vec::new(),
            has_indirect_delete: false,
            decoded_payload: None,
        },
    }
}

/// 花括号剥离（12-T-PD-04）：拼接串 trim 后去首 `{`、去尾 `}`，
/// 得到 scriptblock 内层命令文本；无花括号包裹时原样返回。
/// 首 `{` 恒剥除（foreach-object 两形态收集点均以 `{` 开头确认 scriptblock 形态）；
/// 尾 `}` 可能因 `;` / `|` 等外层拆段先行被切走（scriptblock 内复合命令），仅在存在时剥除。
/// 嵌套/字符串内花括号超范围（任务卡文档化边界，
/// 见 analyze_indirect foreach-object 分支的说明）。
fn strip_scriptblock_braces(joined: &str) -> String {
    let trimmed = joined.trim();
    // `{` / `}` 均为单字节 ASCII，剥除后切片必然落在字符边界上
    let without_open = trimmed.strip_prefix('{').unwrap_or(trimmed);
    let without_close = without_open.strip_suffix('}').unwrap_or(without_open);
    without_close.trim().to_string()
}

/// 单段分类（含间接执行递归升级）。PS-01 T1.2 起委托 classify_depth
/// （根深度 0）。
fn classify(command: &str, args: &[String], segment_raw: &str) -> CommandClass {
    classify_depth(command, args, segment_raw, 0)
}

/// 带包裹深度的单段分类（PS-01 T1.2，R1 ② 盲区）：
/// 包裹提取分支在删除形态分支之前插入，按 D6 升级规则判定。
fn classify_depth(command: &str, args: &[String], segment_raw: &str, depth: usize) -> CommandClass {
    // 0. 命令替换/scriptblock 包裹内容递归（PS-01 T1.2）：
    //    `echo "$(rm -rf -- /)"` / 反引号 / `{ … }` 提取内容逐个递归分析，
    //    内层升级规则（D6）：Redline → 段 Redline；DeleteShape → 段
    //    DeleteShape（删除接管语义保持）；Dangerous → 段 Dangerous。
    //    不引入新 CommandClass。深度超限（>=5）由 analyze_depth 入口
    //    统一拦截，本层只判断是否继续提取。
    //    间接命令（INDIRECT_COMMANDS）跳过本分支：其 scriptblock 包裹
    //    已由 analyze_indirect 既有路径递归（12-T-PD-04 契约——ForEach-
    //    Object { Remove-Item $_ } 保持 Indirect + has_indirect_delete，
    //    不被升级为 DeleteShape，防止既有断言与命令面语义回归）。
    if depth <= MAX_WRAP_DEPTH && !INDIRECT_COMMANDS.contains(&command) {
        for inner in extract_wrapped_content(segment_raw) {
            let inner_class = analyze_depth(&inner, depth + 1).overall_class;
            match inner_class {
                CommandClass::Redline => return CommandClass::Redline,
                CommandClass::DeleteShape => return CommandClass::DeleteShape,
                CommandClass::Dangerous => return CommandClass::Dangerous,
                _ => {}
            }
        }
    }

    // 0.1 AST 语法特征与动态执行分析（动态反射、变量调用 & $var、Base64 开关等）
    if !INDIRECT_COMMANDS.contains(&command) {
        let ast_class = analyze_segment_ast(command, args, depth);
        if ast_class == CommandClass::Redline {
            return CommandClass::Redline;
        }
        if ast_class == CommandClass::Dangerous {
            return CommandClass::Dangerous;
        }
        if ast_class == CommandClass::CdShape {
            return CommandClass::CdShape;
        }
    }

    // 1. 间接执行：先递归分析内层
    if INDIRECT_COMMANDS.contains(&command) {
        let inner = analyze_indirect_depth(segment_raw, depth + 1);
        if inner.overall_class == CommandClass::Redline {
            return CommandClass::Redline;
        }
        if inner.overall_class == CommandClass::Dangerous {
            return CommandClass::Dangerous;
        }
        if inner.overall_class == CommandClass::GitRevertShape {
            return CommandClass::Indirect;
        }
        if inner.overall_class == CommandClass::DeleteShape || inner.has_indirect_delete {
            return CommandClass::Indirect;
        }
        // BC10-3：若内层分析结果包含 CdShape，整链分类必须判定为 CdShape 或向上传播
        if inner.overall_class == CommandClass::CdShape
            || inner
                .segments
                .iter()
                .any(|s| s.class == CommandClass::CdShape)
        {
            return CommandClass::CdShape;
        }
        if !inner.segments.is_empty() {
            return CommandClass::Indirect;
        }
        // 无内层命令内容时按自身判定
    }

    // 2. 删除形态（含红线判定）——git 除外（git 只走回退形态分支）
    if let Some(class) = classify_delete_command(command, args) {
        return class;
    }

    // 3. cd 形态（T-AB-05 禁 cd 语义层）：段首命令名命中 cd 家族即标记。
    //    与删除形态互不干扰：cd 不在 DELETE_COMMANDS、删除命令也不在 CD_COMMANDS，
    //    两条路径独立判定；引号内的 "cd x" 经拆参后命令名是 echo，天然不命中；
    //    git -C / npm --prefix / python -m 等形态命令名不是 cd 家族，同样不命中
    if CD_COMMANDS.contains(&command) {
        return CommandClass::CdShape;
    }

    // 4. git 形态：git rm 属删除形态（走删除接管，S1 规格第 5 条），
    //    其余子命令按回退形态 / 普通命令判定
    if command == "git" {
        if args.first().map(|s| s.as_str()) == Some("rm") {
            return CommandClass::DeleteShape;
        }
        if classify_git_revert(args).is_some() {
            return CommandClass::GitRevertShape;
        }
        return CommandClass::Normal;
    }

    // 5. 红线形态（确定性毁灭目标，100% 拦截层）
    if REDLINE_COMMANDS.contains(&command) {
        return CommandClass::Redline;
    }

    // 6. 危险形态
    if DANGEROUS_COMMANDS.contains(&command) {
        return CommandClass::Dangerous;
    }

    // 7. curl|bash 管道（stdin 管道间接执行）——在整体分析后处理，这里按 Dangerous 提示
    if command == "curl" || command == "wget" {
        return CommandClass::Dangerous;
    }

    // 8. PS-01 T1.4：token 级疑似命令名扫描（赋值形态 / 未知命令 +
    //    非打印白名单）——命中清单命令按该命令的既有分类逻辑判定本段
    if let Some(class) = scan_ps_command_tokens(command, args) {
        return class;
    }

    CommandClass::Normal
}

/// git 回退形态识别：返回形态描述字符串，None 表示非回退。
fn classify_git_revert(args: &[String]) -> Option<String> {
    let (effective, positional) = strip_double_dash(args);
    let first = effective.first()?;
    match first.as_str() {
        "reset" => {
            // git reset --hard <ref>
            if effective.iter().any(|a| a == "--hard") {
                Some("git reset --hard".to_string())
            } else {
                None
            }
        }
        "clean" => {
            if effective.iter().any(|a| a == "-f" || a == "--force") {
                Some("git clean -f".to_string())
            } else {
                None
            }
        }
        "stash" => {
            if effective.get(1).map(|s| s.as_str()) == Some("drop") {
                Some("git stash drop".to_string())
            } else {
                None
            }
        }
        "revert" => {
            if effective.iter().any(|a| a == "--no-commit") {
                Some("git revert --no-commit".to_string())
            } else {
                None
            }
        }
        "restore" => {
            // git restore --source=<ref>
            if effective.iter().any(|a| a.starts_with("--source")) {
                Some("git restore --source".to_string())
            } else {
                None
            }
        }
        "checkout" => {
            // git checkout <旧ref>（分支名 vs commit hash 区分：全 hex 且 >=7 字符视为 ref）
            if positional.is_empty() && effective.len() >= 2 {
                let target = &effective[1];
                let is_hex_ref = !target.starts_with('-')
                    && target != "."
                    && !target.starts_with("--")
                    && target.len() >= 7
                    && target.chars().all(|c| c.is_ascii_hexdigit());
                if is_hex_ref {
                    Some(format!("git checkout {}", target))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 整体分类：任一段 Redline 则 Redline；否则优先级
/// Dangerous > GitRevertShape > DeleteShape > CdShape > Indirect > Normal
/// （T-AB-05：cd 形态与删除形态互不干扰，链内同时命中时删除优先——
/// 与方案第 4 点「先删除后 cd」的执行序一致）。
fn overall(segments: &[CommandSegment]) -> CommandClass {
    let mut has_dangerous = false;
    let mut has_revert = false;
    let mut has_delete = false;
    let mut has_cd = false;
    let mut has_indirect = false;
    for s in segments {
        match s.class {
            CommandClass::Redline => return CommandClass::Redline,
            CommandClass::Dangerous => has_dangerous = true,
            CommandClass::GitRevertShape => has_revert = true,
            CommandClass::DeleteShape => has_delete = true,
            CommandClass::CdShape => has_cd = true,
            CommandClass::Indirect => has_indirect = true,
            CommandClass::Normal => {}
        }
    }
    if has_dangerous {
        CommandClass::Dangerous
    } else if has_revert {
        CommandClass::GitRevertShape
    } else if has_delete {
        CommandClass::DeleteShape
    } else if has_cd {
        CommandClass::CdShape
    } else if has_indirect {
        CommandClass::Indirect
    } else {
        CommandClass::Normal
    }
}

/// 公开分类入口（T-AB-05 冻结签名，供 T-AB-04 调用）：
/// 入参为整条命令的拆段列表（段为单位，段内若仍含 && 等复合分隔符会再次拆开），
/// 返回整链分类，优先级与整体分类一致
/// （Redline > Dangerous > GitRevertShape > DeleteShape > CdShape > Indirect > Normal）。
/// 内部复用拆段 / 段分类 / 整体判定逻辑，与 analyze 完全同口径。
pub fn classify_command_segments(segments: &[String]) -> CommandClass {
    let mut classified = Vec::new();
    for seg in segments {
        // 引号感知拆段：echo "a && b" 保持单段，段内 cd 不会漏拆也不会误拆
        for piece in split_segments(seg) {
            let (command, args) = split_command_args(&piece);
            let normalized = normalize_command(&command);
            let class = classify(&normalized, &args, &piece);
            classified.push(CommandSegment {
                command: normalized,
                args,
                class,
                targets: Vec::new(),
            });
        }
    }
    overall(&classified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_compound_with_and() {
        let a = analyze("echo hi && rm -rf /");
        assert_eq!(a.segments.len(), 2);
        assert_eq!(a.segments[0].command, "echo");
        assert_eq!(a.segments[1].command, "rm");
        assert_eq!(a.segments[1].class, CommandClass::Redline);
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn splits_semicolon_and_pipe() {
        let a = analyze("git status; ls -la | grep foo");
        assert_eq!(a.segments.len(), 3);
        assert_eq!(a.segments[0].command, "git");
        assert_eq!(a.segments[1].command, "ls");
        assert_eq!(a.segments[2].command, "grep");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn indirect_sudo_bash_c_recursive() {
        let a = analyze("sudo bash -c 'rm -rf /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
        assert!(
            a.segments[0].class == CommandClass::Redline
                || a.segments[0].class == CommandClass::Indirect
        );
    }

    #[test]
    fn indirect_eval_recursive() {
        let a = analyze("eval rm -rf /");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn indirect_bash_c_recursive_redline() {
        let a = analyze("bash -c 'rm -rf /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn rm_double_dash_dot_is_delete_not_redline() {
        let a = analyze("rm -rf -- ./");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(!a.delete_targets.is_empty());
    }

    #[test]
    fn rm_plain_file_is_delete() {
        let a = analyze("rm -r -f /tmp/x");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.contains(&"/tmp/x".to_string()));
    }

    #[test]
    fn remove_item_literal_path() {
        let a = analyze("Remove-Item -LiteralPath 'C:\\x\\y.txt' -Force");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.iter().any(|t| t.contains("y.txt")));
    }

    #[test]
    fn git_reset_hard_is_revert() {
        let a = analyze("git reset --hard HEAD~5");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
        assert!(!a.git_revert_forms.is_empty());
    }

    #[test]
    fn git_clean_f_is_revert() {
        let a = analyze("git clean -f");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_stash_drop_is_revert() {
        let a = analyze("git stash drop");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_restore_source_is_revert() {
        let a = analyze("git restore --source=HEAD~3 src/main.rs");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_checkout_branch_is_normal() {
        let a = analyze("git checkout main");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn git_checkout_old_ref_is_revert() {
        let a = analyze("git checkout abc1234");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_status_is_normal() {
        let a = analyze("git status");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn normal_commands_are_normal() {
        assert_eq!(analyze("npm test").overall_class, CommandClass::Normal);
        assert_eq!(analyze("ls -la").overall_class, CommandClass::Normal);
    }

    #[test]
    fn quoted_semicolon_not_split() {
        let a = analyze("echo \"a;b\"");
        assert_eq!(a.segments.len(), 1);
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    // ===== PS-01 T1.1：换行拆段（R1 ① 盲区）=====

    #[test]
    fn splits_real_newline_into_segments() {
        // 换行分隔两命令：printf x\n/bin/rm -rf -- /（真实 \n）拆为 2 段，
        // 第二段 rm 归一后走既有红线判定
        let a = analyze("printf x\n/bin/rm -rf -- /");
        assert_eq!(a.segments.len(), 2);
        assert_eq!(a.segments[1].command, "rm");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn splits_crlf_once_no_empty_segment() {
        // \r\n 双字符只拆一次、不产生空段
        let a = analyze("echo a\r\nrm -rf -- /");
        assert_eq!(a.segments.len(), 2, "\\r\\n 必须只产生一次拆分（无空段）");
        assert_eq!(a.segments[1].class, CommandClass::Redline);
    }

    #[test]
    fn newline_inside_quotes_not_split() {
        // 负例：引号内真实换行不拆段（quote 状态机）
        let a = analyze("echo \"a\nb\"");
        assert_eq!(a.segments.len(), 1);
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn escaped_newline_continuation_not_split() {
        // 负例：`\` + 换行是续行（escaped 状态吞掉），不拆段
        let a = analyze("echo a\\\nb");
        assert_eq!(a.segments.len(), 1);
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    // ===== PS-01 T1.2：命令替换/scriptblock 包裹递归（R1 ② 盲区）=====

    #[test]
    fn cmd_subst_dollar_paren_inner_redline() {
        // $() 命令替换：双引号内也提取（bash 语义）——R1 形态 1
        let a = analyze("echo \"$(rm -rf -- /)\"");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn cmd_subst_nested_recursion() {
        // 嵌套递归：$() 内层再走间接执行（bash -c）红线升级
        let a = analyze("echo \"$(bash -c 'rm -rf -- /')\"");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn backtick_inner_redline() {
        // 反引号命令替换——R1 形态 2
        let a = analyze("echo `rm -rf -- /`");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn scriptblock_inner_delete_upgrades() {
        // {…} scriptblock 内层删除形态 → 段 DeleteShape（删除接管语义保持）
        let a = analyze("echo { Remove-Item C:\\x -Recurse -Force }");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
    }

    #[test]
    fn cmd_subst_inner_delete_upgrades() {
        // $() 内层删除形态（非盘符根）→ 段 DeleteShape
        let a = analyze("echo \"$(rm -rf /tmp/x)\"");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
    }

    #[test]
    fn env_var_ref_not_command_subst() {
        // 负例：变量引用不是命令替换——$HOME / ${PATH} 不提取不误拦
        assert_eq!(analyze("echo $HOME").overall_class, CommandClass::Normal);
        assert_eq!(analyze("echo ${PATH}").overall_class, CommandClass::Normal);
    }

    #[test]
    fn single_quoted_dollar_paren_is_literal() {
        // 负例：单引号内 $() 是字面量，不提取
        let a = analyze("echo '$(rm -rf -- /)'");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn cmd_subst_deep_nesting_no_panic() {
        // 32 层 $() 嵌套（最内层 rm -rf -- /）→ 不 panic 且 Redline
        // （R2 修订：深度上限 16，>16 → Redline）
        let mut cmd = String::from("echo ");
        for _ in 0..32 {
            cmd.push_str("$(");
        }
        cmd.push_str("rm -rf -- /");
        for _ in 0..32 {
            cmd.push(')');
        }
        let a = analyze(&cmd);
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    // ===== PS-01 T1.3：iex / Invoke-Expression / Start-Process /
    // -EncodedCommand 拦截（R1 ④ 盲区 + R3 修订）=====

    #[test]
    fn iex_wrapped_rm_redline() {
        // iex 包裹（Invoke-Expression 别名）——R1 形态 5
        let a = analyze("iex 'rm -rf -- /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn invoke_expression_wrapped_rm_redline() {
        // Invoke-Expression 包裹——R1 形态 6
        let a = analyze("Invoke-Expression 'rm -rf -- /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn iex_case_and_exe_variant() {
        // 大小写变体（IEX）与 .exe 形态（normalize 去 .exe 先例）
        let a = analyze("IEX 'rm -rf -- /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
        let b = analyze("iex.exe 'rm -rf -- /'");
        assert_eq!(b.overall_class, CommandClass::Redline);
    }

    #[test]
    fn start_process_wrapped_rm_redline() {
        // Start-Process 包裹：-ArgumentList 后藏内层命令——R1 形态 7
        let a = analyze("Start-Process cmd -ArgumentList '/c rm -rf -- /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn encoded_command_flag_redline() {
        // -EncodedCommand / -e / -enc 三变体（R2 修订样本：
        // cgBtACAALQByAGYAIAAtAC0AIAAvAA== = UTF-16LE base64("rm -rf -- /")）
        let b64 = "cgBtACAALQByAGYAIAAtAC0AIAAvAA==";
        let a = analyze(&format!("powershell -EncodedCommand {b64}"));
        assert_eq!(a.overall_class, CommandClass::Redline);
        let b = analyze(&format!("powershell -e {b64}"));
        assert_eq!(b.overall_class, CommandClass::Redline);
        let c = analyze(&format!("powershell -enc {b64}"));
        assert_eq!(c.overall_class, CommandClass::Redline);
    }

    #[test]
    fn start_process_plain_not_redline() {
        // 负例：Start-Process 无参数列表（普通启动）不误拦
        let a = analyze("Start-Process notepad.exe");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    // ===== PS-01 T1.4：PS 别名归一 + token 级扫描（F3-01 #1）=====

    #[test]
    fn ps_alias_ri_normalized_delete() {
        // ri（Remove-Item 别名）归一到 remove-item → 删除形态 + 目标提取
        let a = analyze("ri C:\\temp\\f.txt");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.contains(&"C:\\temp\\f.txt".to_string()));
    }

    #[test]
    fn ps_alias_ri_drive_root_redline() {
        // ri 盘符根 + 递归/强制 → 红线（先例 semantics.rs:400-421、591）
        let a = analyze("ri C:\\ -Recurse -Force");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn ps_alias_ri_after_newline_redline() {
        // T1.1 + T1.4 合击：换行分隔 + PS 删除别名——R1 形态 4
        let a = analyze("Write-Output x\nri C:\\ -Recurse -Force");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn ps_assignment_token_scan_redline() {
        // 赋值形态 token 级扫描：$x = <删除命令> 盘符根 → 红线
        let a = analyze("$x = Remove-Item C:\\ -Recurse -Force");
        assert_eq!(a.overall_class, CommandClass::Redline);
        let b = analyze("$x = ri C:\\ -Recurse -Force");
        assert_eq!(b.overall_class, CommandClass::Redline);
    }

    #[test]
    fn token_scan_echo_no_false_positive() {
        // 负例：打印白名单段首命令不触发 token 扫描（防 echo rm -rf / 误拦）
        let a = analyze("echo rm -rf /");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn token_scan_plain_args_no_false_positive() {
        // 负例：已知清单段首命令（git）不触发 token 扫描
        let a = analyze("git status -- rm.txt");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn mkfs_is_redline() {
        let a = analyze("mkfs.ext4 /dev/sdb");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn rm_dash_rf_root_redline() {
        let a = analyze("rm -r -f /");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn normalize_path_prefix() {
        let a = analyze("/bin/rm -rf /");
        assert_eq!(a.segments[0].command, "rm");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn windows_drive_root_redline() {
        let a = analyze("rd /s /q C:\\");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn git_rm_is_delete_shape() {
        let a = analyze("git rm file.txt");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.contains(&"file.txt".to_string()));
        assert!(
            a.git_revert_forms.is_empty(),
            "git rm 属删除形态，不计入回退清单"
        );
        assert!(!a.has_indirect_delete);
    }

    #[test]
    fn git_rm_cached_is_delete_shape() {
        // --cached 只解除跟踪不物理删除，仍按删除形态识别（目标为空由命令面兜底）
        let a = analyze("git rm --cached file.txt");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(!a.delete_targets.is_empty());
    }

    #[test]
    fn indirect_delete_wrapper_flagged() {
        let a = analyze("bash -c 'rm -rf tmp/foo'");
        assert!(a.has_indirect_delete, "间接执行内层删除形态必须置标记");
        // 不升级整体分类（保持 Indirect），由命令面（I2-S4）消费该标记拦截
        assert_eq!(a.overall_class, CommandClass::Indirect);
    }

    #[test]
    fn indirect_xargs_rm_flagged() {
        let a = analyze("xargs rm -rf tmp/foo");
        assert!(a.has_indirect_delete);
    }

    #[test]
    fn indirect_normal_inner_not_flagged() {
        let a = analyze("bash -c 'echo hi'");
        assert!(!a.has_indirect_delete);
        assert_eq!(a.overall_class, CommandClass::Indirect);
    }

    #[test]
    fn plain_delete_has_no_indirect_flag() {
        let a = analyze("rm -rf tmp/foo");
        assert!(!a.has_indirect_delete);
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
    }

    // ===== T-AB-05：禁 cd 语义层 =====

    #[test]
    fn cd_shape_detected() {
        let a = analyze("cd sub");
        assert_eq!(a.overall_class, CommandClass::CdShape);
        assert_eq!(a.segments[0].class, CommandClass::CdShape);
    }

    #[test]
    fn cd_dotdot_and_drive_flag_detected() {
        assert_eq!(analyze("cd ..").overall_class, CommandClass::CdShape);
        assert_eq!(analyze("cd /d C:\\").overall_class, CommandClass::CdShape);
    }

    #[test]
    fn powershell_cd_family_detected() {
        assert_eq!(
            analyze("Set-Location D:\\code").overall_class,
            CommandClass::CdShape
        );
        assert_eq!(analyze("sl sub").overall_class, CommandClass::CdShape);
        assert_eq!(analyze("pushd sub").overall_class, CommandClass::CdShape);
        assert_eq!(analyze("popd").overall_class, CommandClass::CdShape);
    }

    #[test]
    fn quoted_cd_inside_string_not_detected() {
        // 引号内 "cd x" 是 echo 的参数，命令名不是 cd 家族，不命中
        assert_eq!(analyze("echo \"cd x\"").overall_class, CommandClass::Normal);
        assert_eq!(analyze("echo cd x").overall_class, CommandClass::Normal);
    }

    #[test]
    fn non_stateful_forms_not_detected() {
        // 不依赖进程内目录状态的形态：git -C / npm --prefix / python -m
        assert_eq!(
            analyze("git -C src status").overall_class,
            CommandClass::Normal
        );
        assert_eq!(
            analyze("npm --prefix ./sub run build").overall_class,
            CommandClass::Normal
        );
        assert_eq!(
            analyze("python -m pip install x").overall_class,
            CommandClass::Normal
        );
    }

    #[test]
    fn cd_chain_with_delete_priority_delete_wins() {
        // 复合链同时命中：cd 段标记 CdShape，rm 段标记 DeleteShape，
        // 整体按删除优先（先删除后 cd，执行序不变）
        let a = analyze("cd x && rm -rf y");
        assert_eq!(a.segments[0].class, CommandClass::CdShape);
        assert_eq!(a.segments[1].class, CommandClass::DeleteShape);
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
    }

    #[test]
    fn cd_chain_without_delete_overall_cd() {
        let a = analyze("cd sub && git status");
        assert_eq!(a.overall_class, CommandClass::CdShape);
    }

    #[test]
    fn cd_does_not_trigger_delete_shape() {
        // 两条路径独立判定：cd 段不触发删除形态，也不产生删除目标
        let a = analyze("cd x");
        assert_eq!(a.segments[0].class, CommandClass::CdShape);
        assert!(a.delete_targets.is_empty());
        assert!(!a.has_indirect_delete);
    }

    #[test]
    fn path_prefixed_cd_normalized() {
        // 与 /bin/rm 归一逻辑同构：/usr/bin/cd 归一后仍是 cd
        let a = analyze("/usr/bin/cd /tmp");
        assert_eq!(a.overall_class, CommandClass::CdShape);
    }

    #[test]
    fn classify_command_segments_entry_works() {
        // 公开入口（冻结签名）：单段命中
        assert_eq!(
            classify_command_segments(&["cd x".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["Set-Location x".to_string()]),
            CommandClass::CdShape
        );
        // 复合链：删除优先，cd 判定独立生效
        assert_eq!(
            classify_command_segments(&["cd x".to_string(), "rm -rf y".to_string()]),
            CommandClass::DeleteShape
        );
        // 未拆段兜底：段内仍含 && 时再次拆开判定
        assert_eq!(
            classify_command_segments(&["cd x && rm -rf y".to_string()]),
            CommandClass::DeleteShape
        );
        // 不命中形态：整体 Normal
        assert_eq!(
            classify_command_segments(&["git -C src status".to_string()]),
            CommandClass::Normal
        );
        assert_eq!(
            classify_command_segments(&["echo hi".to_string(), "git status".to_string()]),
            CommandClass::Normal
        );
    }

    // ===== 12-T-PD-03：Windows 路径语义（A2-M1 + ML3）=====

    #[test]
    fn rm_bare_windows_path_preserved() {
        // 裸 Windows 路径：`\` 后跟普通路径字符不剥离，拆参后精确保留原串
        // （修复前被无条件剥离损坏成 C:tempa.txt）
        let a = analyze("rm C:\\temp\\a.txt");
        assert_eq!(a.segments[0].command, "rm");
        assert_eq!(a.delete_targets, vec!["C:\\temp\\a.txt".to_string()]);
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
    }

    #[test]
    fn rm_backslash_path_with_spaces_in_dirname() {
        // Windows 路径目录含空格：裸形态空格天然拆 token，关键契约是反斜杠不被剥离
        // （修复前 `C:\my` 被损坏成 `C:my`）
        let a = analyze("rm C:\\my dir\\a.txt");
        let targets = a.delete_targets.clone();
        assert!(
            targets.iter().any(|t| t == "C:\\my"),
            "拆出的盘符前缀保留反斜杠：{:?}",
            targets
        );
        assert!(
            !targets.iter().any(|t| t == "C:my"),
            "不允许出现剥离反斜杠的损坏串：{:?}",
            targets
        );
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        // 引号 / 转义空格形态：整条含空格路径完整保留为一个目标
        let b = analyze("rm \"C:\\my dir\\a.txt\"");
        assert!(b.delete_targets.iter().any(|t| t == "C:\\my dir\\a.txt"));
        let c = analyze("rm C:\\my\\ dir\\a.txt");
        assert!(c.delete_targets.iter().any(|t| t == "C:\\my dir\\a.txt"));
    }

    #[test]
    fn win_style_flags_not_collected_as_targets() {
        // ML3：rd /s /q、del /f /q 等 Windows 风格开关不入 targets，盘符路径保持原样
        let a = analyze("rd /s /q C:\\x");
        assert_eq!(a.delete_targets, vec!["C:\\x".to_string()]);
        // 开关仍参与递归/强制判定：rd /s /q C:\ 维持红线（:806 锚点口径不回归）
        assert_eq!(
            analyze("rd /s /q C:\\").overall_class,
            CommandClass::Redline
        );
        let c = analyze("del /f /q C:\\x\\a.txt");
        assert_eq!(c.delete_targets, vec!["C:\\x\\a.txt".to_string()]);
        // Unix 绝对路径不受影响：/tmp/x 仍入 targets
        let u = analyze("rm -f /tmp/x");
        assert!(u.delete_targets.iter().any(|t| t == "/tmp/x"));
    }

    #[test]
    fn trailing_backslash_preserved() {
        // 行尾孤反斜杠（cd /d C:\，:866 用例形态）不再吞字符：拆参后反斜杠保留
        let (_, args) = split_command_args("cd /d C:\\");
        assert_eq!(args, vec!["/d".to_string(), "C:\\".to_string()]);
    }

    // ===== 12-T-PD-04：PowerShell scriptblock 删除形态（A2-M2 + ML5）=====

    #[test]
    fn foreach_object_scriptblock_delete_flagged() {
        // 管道 + scriptblock 主形态：ForEach-Object { Remove-Item $_ }
        // 修复前无 { 主形态识别，整链判 Normal（间接删除盲区）
        let a = analyze("Get-ChildItem | ForEach-Object { Remove-Item $_ }");
        assert!(
            a.has_indirect_delete,
            "scriptblock 内层 Remove-Item 必须置间接删除标记"
        );
        // 判定语义不变：内层 DeleteShape 不升级整体分类，保持 Indirect（对齐 :829 契约）
        assert_eq!(a.overall_class, CommandClass::Indirect);
        // 无空格紧凑形态：{Remove-Item $_} 首尾花括号一体剥除
        let b = analyze("ForEach-Object {Remove-Item $_}");
        assert!(b.has_indirect_delete);
        // 管道变量形态：$_.FullName 等按普通 token 保留
        let c = analyze("gci | ForEach-Object { Remove-Item -Path $_.FullName -Force }");
        assert!(c.has_indirect_delete);
    }

    #[test]
    fn foreach_object_scriptblock_normal_not_flagged() {
        // 非删除 scriptblock 不误报：内层 Normal 不置标记
        let a = analyze("Get-ChildItem | ForEach-Object { Write-Output $_ }");
        assert!(!a.has_indirect_delete);
        assert_eq!(a.overall_class, CommandClass::Indirect);
        // 空 scriptblock 与纯变量形态同样不误报
        let b = analyze("ForEach-Object { }");
        assert!(!b.has_indirect_delete);
        let c = analyze("ForEach-Object { $_ }");
        assert!(!c.has_indirect_delete);
    }

    #[test]
    fn foreach_object_dash_process_scriptblock_flagged() {
        // -Process 显式参数形态：修复前只取其后单个 token，{ Remove-Item 拆开后漏判
        let a = analyze("ForEach-Object -Process { Remove-Item $_ }");
        assert!(a.has_indirect_delete);
        assert_eq!(a.overall_class, CommandClass::Indirect);
        // -Process 后剩余全部参数 join（对齐 bash -c rest 拼接先例），多 token 不丢
        let b = analyze("ForEach-Object -Process { Remove-Item -Path $_ -Force }");
        assert!(b.has_indirect_delete);
        // -Process 后无 scriptblock 的普通表达式不误报
        let c = analyze("ForEach-Object -Process { Write-Output 'hi' }");
        assert!(!c.has_indirect_delete);
    }

    #[test]
    fn powershell_exe_command_delete_flagged() {
        // ML5：normalize_command 去 .exe 扩展名（大小写不敏感）——
        // powershell.exe / cmd.exe / del.exe 形态一并命中既有清单
        let a = analyze("powershell.exe -Command 'Remove-Item C:\\temp\\a.txt'");
        assert!(a.has_indirect_delete);
        assert_eq!(a.overall_class, CommandClass::Indirect);
        let b = analyze("cmd.exe /c del C:\\temp\\a.txt");
        assert!(b.has_indirect_delete);
        let c = analyze("del.exe C:\\temp\\a.txt");
        assert_eq!(c.overall_class, CommandClass::DeleteShape);
        assert!(c.delete_targets.iter().any(|t| t == "C:\\temp\\a.txt"));
        // 扩展名大小写变体：PowerShell.EXE
        let d = analyze("powershell.EXE -Command 'Remove-Item x'");
        assert!(d.has_indirect_delete);
        // 带路径前缀形态：C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
        let e = analyze(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command 'Remove-Item x'",
        );
        assert!(e.has_indirect_delete);
    }

    #[test]
    fn pipeline_direct_remove_item_detected() {
        // 管道删除整体识别：管道末段裸 Remove-Item（无位置参数，目标走管道输入）
        // 仍命中删除形态，供 S4 删除形态重定向接管
        let a = analyze("Get-ChildItem C:\\x | Remove-Item -Force");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(!a.has_indirect_delete);
    }

    #[test]
    fn scriptblock_compound_delete_detected() {
        // scriptblock 内复合命令：join 后由 analyze 自然拆段（; 拆段）
        let a = analyze("ForEach-Object { Remove-Item x; Write-Output ok }");
        assert!(a.has_indirect_delete);
        // 复合链整体识别：scriptblock 与其它段并存时标记仍置位；
        // 整体分类按既有优先级判定（CdShape > Indirect，cd 段存在时不升级）
        let b = analyze("cd x && ForEach-Object { Remove-Item $_ }");
        assert!(b.has_indirect_delete);
        assert_eq!(b.overall_class, CommandClass::CdShape);
    }

    // ===== Unit 5.1：词法反混淆与动态 AST 门禁专项测试 =====

    #[test]
    fn test_split_command_args_normalized_backticks() {
        // 反引号混淆剥离：r`i -> ri, R`em`ove-Item -> Remove-Item
        let (cmd1, args1) = split_command_args_normalized("r`i C:\\ -Recurse -Force");
        assert_eq!(cmd1, "ri");
        assert_eq!(args1, vec!["C:\\", "-Recurse", "-Force"]);

        let (cmd2, args2) = split_command_args_normalized("R`em`ove-Item C:\\ -Force -Recurse");
        assert_eq!(cmd2, "Remove-Item");
        assert_eq!(args2, vec!["C:\\", "-Force", "-Recurse"]);

        // 双引号内反引号转义：`"r`i"` -> `"ri"`
        let (cmd3, _) = split_command_args_normalized("\"r`i\" C:\\");
        assert_eq!(cmd3, "ri");

        // 单引号内反引号字面量保留
        let (cmd4, args4) = split_command_args_normalized("echo 'r`i'");
        assert_eq!(cmd4, "echo");
        assert_eq!(args4, vec!["r`i"]);
    }

    #[test]
    fn test_is_ps_encoded_command_flag_variants() {
        assert!(is_ps_encoded_command_flag("-enco"));
        assert!(is_ps_encoded_command_flag("-EncodedCommand"));
        assert!(is_ps_encoded_command_flag("-encodedcommand"));
        assert!(is_ps_encoded_command_flag("-e"));
        assert!(is_ps_encoded_command_flag("-E"));
        assert!(is_ps_encoded_command_flag("-enc"));
        assert!(is_ps_encoded_command_flag("/e:cgBtACAALQByAGYAIAAvAA=="));
        assert!(is_ps_encoded_command_flag("-e:cgBtACAALQByAGYAIAAvAA=="));
        assert!(is_ps_encoded_command_flag(
            "-EncodedCommand=cgBtACAALQByAGYAIAAvAA=="
        ));
        assert!(is_ps_encoded_command_flag("/encodedcommand"));

        // 负例
        assert!(!is_ps_encoded_command_flag("-entity"));
        assert!(!is_ps_encoded_command_flag("-exec"));
        assert!(!is_ps_encoded_command_flag("-erroraction"));
        assert!(!is_ps_encoded_command_flag("npm"));
    }

    #[test]
    fn test_analyze_token_danger_dotnet_and_env() {
        assert_eq!(
            analyze_token_danger("[System.Diagnostics.Process]::Start"),
            Some(CommandClass::Redline)
        );
        assert_eq!(
            analyze_token_danger("[scriptblock]::create"),
            Some(CommandClass::Redline)
        );
        assert_eq!(
            analyze_token_danger("[PowerShell]::Create()"),
            Some(CommandClass::Redline)
        );
        assert_eq!(
            analyze_token_danger("$env:comspec"),
            Some(CommandClass::Dangerous)
        );
        assert_eq!(
            analyze_token_danger("$env:SystemRoot"),
            Some(CommandClass::Dangerous)
        );
    }

    #[test]
    fn test_ps_dynamic_reflection_and_call_operator() {
        // [System.Diagnostics.Process]::Start -> Redline
        let a = analyze("[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')");
        assert_eq!(a.overall_class, CommandClass::Redline);

        // & $var 动态变量调用 -> Dangerous
        let b = analyze("$x = 'Remove-Item'; & $x C:\\ -Force");
        assert_eq!(b.overall_class, CommandClass::Dangerous);

        // $(whoami) 与 &($code) 作为命令调用 -> Dangerous
        let d = analyze("$(whoami) args");
        assert_eq!(d.overall_class, CommandClass::Dangerous);

        let e = analyze("&($code) args");
        assert_eq!(e.overall_class, CommandClass::Dangerous);

        // % (ForEach-Object) 管道与内层 Remove-Item
        let c = analyze("Get-ChildItem C:\\ | % { Remove-Item $_.FullName -Force }");
        assert!(c.has_indirect_delete);
        assert_eq!(c.overall_class, CommandClass::Indirect);
    }

    #[test]
    fn test_adversarial_obfuscation_and_reflection_semantics() {
        // Section 8.1 对抗用例
        let cases = [
            "r`i C:\\ -Recurse -Force",
            "R`em`ove-Item C:\\ -Force -Recurse",
            "powershell -enco cgBtACAALQByAGYAIAAvAA==",
            "pwsh -e:cgBtACAALQByAGYAIAAvAA==",
            "[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')",
            "$x = 'Remove-Item'; & $x C:\\ -Force",
            "Get-ChildItem C:\\ | % { Remove-Item $_.FullName -Force }",
        ];

        for cmd in cases {
            let res = analyze(cmd);
            assert_ne!(
                res.overall_class,
                CommandClass::Normal,
                "混淆/反射命令不能被误判为 Normal: {cmd}"
            );
        }
    }

    #[test]
    fn test_powershell_call_operator_and_indirect_semantics() {
        let indirect_delete_cases = [
            "& cmd /c rmdir /s /q D:\\old",
            "& 'cmd' /c rmdir /s /q D:\\old",
            "& \"cmd.exe\" /c rmdir /s /q D:\\old",
            "& bash -c 'rm -rf /tmp/test'",
            "& bash -c 'rm /tmp/x'",
            "& pwsh -Command \"Remove-Item -Recurse -Force D:\\data\"",
            "& cmd /c Remove-Item D:\\file.txt",
            "Invoke-Command -ScriptBlock { Remove-Item -Recurse D:\\old }",
            "icm -ScriptBlock { rm /tmp/x }",
        ];

        for cmd in indirect_delete_cases {
            let sem = analyze(cmd);
            assert!(
                sem.has_indirect_delete
                    || sem.overall_class == CommandClass::DeleteShape
                    || sem.overall_class == CommandClass::Redline,
                "命令 {cmd} 必须识别为间接删除或删除形态或红线, 实际: {sem:?}"
            );
        }

        // 6 层嵌套间接调用触发 MAX_RECURSION_DEPTH = 5 深度熔断
        let deep_nested = "Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { echo deep } } } } } }";
        let sem_deep = analyze(deep_nested);
        assert_eq!(
            sem_deep.overall_class,
            CommandClass::Dangerous,
            "6层嵌套间接调用必须触发深度熔断 Dangerous"
        );
    }

    fn b64_encode(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
            out.push(TABLE[(b0 >> 2) as usize] as char);
            out.push(TABLE[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
            if chunk.len() > 1 {
                out.push(TABLE[(((b1 & 0xf) << 2) | (b2 >> 6)) as usize] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(TABLE[(b2 & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
        out
    }

    fn to_ps_b64(cmd: &str) -> String {
        let utf16: Vec<u8> = cmd.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        b64_encode(&utf16)
    }

    #[test]
    fn test_is_ps_encoded_command_flag_all_variants() {
        // 正向缩写与变体
        let positive = [
            "-e",
            "-E",
            "-ec",
            "-EC",
            "-eco",
            "-ecom",
            "-en",
            "-enc",
            "-enco",
            "-encode",
            "-encoded",
            "-encodedcommand",
            "-EncodedCommand",
            "/e",
            "/ec",
            "/enc",
            "/enco",
            "/encodedcommand",
            "--ec",
            "--encodedcommand",
            "-ec:",
            "/ec:",
            "-EncodedCommand=",
            "-ec:cgBtACAALQByAGYAIAAvAA==",
            "/encodedcommand:cgBtACAALQByAGYAIAAvAA==",
            "--encodedcommand=cgBtACAALQByAGYAIAAvAA==",
        ];
        for flag in positive {
            assert!(
                is_ps_encoded_command_flag(flag),
                "应识别为 PowerShell 编码命令参数: {flag}"
            );
        }

        // 负向参数（绝不能误判）
        let negative = [
            "-ex",
            "-exec",
            "-executionpolicy",
            "-ExecutionPolicy",
            "-ExecutionPolicy:Bypass",
            "/executionpolicy",
            "-erroraction",
            "-entity",
            "-ea",
            "-w",
            "-windowstyle",
            "-whatif",
            "npm",
            "powershell",
            "pwsh",
            "-help",
        ];
        for flag in negative {
            assert!(
                !is_ps_encoded_command_flag(flag),
                "不应误识别为 PowerShell 编码命令参数: {flag}"
            );
        }
    }

    #[test]
    fn test_is_ps_working_directory_flag_variants() {
        // 正向缩写与变体
        let positive = [
            "-wd",
            "-WD",
            "/wd",
            "/WD",
            "--wd",
            "--WD",
            "-work",
            "-working",
            "-workingdirectory",
            "-WorkingDirectory",
            "/workingdirectory",
            "/WorkingDirectory",
            "--workingdirectory",
            "--WorkingDirectory",
            "-wd:D:\\test",
            "/wd:D:\\test",
            "--workingdirectory=D:\\test",
        ];
        for flag in positive {
            assert!(
                is_ps_working_directory_flag(flag),
                "应识别为 PowerShell WorkingDirectory 参数: {flag}"
            );
        }

        // 负向参数
        let negative = [
            "-w",
            "-windowstyle",
            "-WindowStyle",
            "-whatif",
            "-wait",
            "-where",
            "npm",
            "pwsh",
            "cd",
        ];
        for flag in negative {
            assert!(
                !is_ps_working_directory_flag(flag),
                "不应误识别为 PowerShell WorkingDirectory 参数: {flag}"
            );
        }
    }

    #[test]
    fn test_extract_and_decode_ps_payload() {
        // 1. UTF-16LE 提取与解码
        let b64_utf16 = to_ps_b64("Write-Host hello");
        let args = vec!["powershell".to_string(), "-ec".to_string(), b64_utf16];
        assert_eq!(
            extract_and_decode_ps_payload(&args),
            Some("Write-Host hello".to_string())
        );

        // 2. UTF-8 回退
        let b64_utf8 = b64_encode(b"rm -rf /");
        let args2 = vec!["powershell".to_string(), "-enc".to_string(), b64_utf8];
        assert_eq!(
            extract_and_decode_ps_payload(&args2),
            Some("rm -rf /".to_string())
        );

        // 3. 冒号与等号内联参数
        let inline_colon = format!("-ec:{}", to_ps_b64("Get-Process"));
        assert_eq!(
            extract_and_decode_ps_payload(&["pwsh".to_string(), inline_colon]),
            Some("Get-Process".to_string())
        );

        let inline_eq = format!("--EncodedCommand={}", to_ps_b64("dir"));
        assert_eq!(
            extract_and_decode_ps_payload(&["powershell".to_string(), inline_eq]),
            Some("dir".to_string())
        );

        // 4. 非法 base64 / 缺失 payload
        assert_eq!(
            extract_and_decode_ps_payload(&["powershell".to_string(), "-ec".to_string()]),
            None
        );
        assert_eq!(
            extract_and_decode_ps_payload(&[
                "powershell".to_string(),
                "-ec".to_string(),
                "!!not_base64!!".to_string()
            ]),
            None
        );
    }

    #[test]
    fn test_encoded_command_decoding_semantics() {
        // 1. 内层为 Normal 命令：间接执行判定为 Indirect（非红线/非删除/非CD），并保留 decoded_payload
        let cmd_normal = format!("powershell -ec {}", to_ps_b64("Write-Host 'hello world'"));
        let sem_normal = analyze(&cmd_normal);
        assert_eq!(sem_normal.overall_class, CommandClass::Indirect);
        assert!(!sem_normal.has_indirect_delete);
        assert_eq!(
            sem_normal.decoded_payload.as_deref(),
            Some("Write-Host 'hello world'")
        );

        // 2. 内层为 Redline 命令：识别为 Redline
        let cmd_redline = format!("powershell -enc {}", to_ps_b64("rm -rf /"));
        let sem_redline = analyze(&cmd_redline);
        assert_eq!(sem_redline.overall_class, CommandClass::Redline);
        assert_eq!(sem_redline.decoded_payload.as_deref(), Some("rm -rf /"));

        // 3. 内层为 CdShape 命令：识别为 CdShape
        let cmd_cd = format!("pwsh -EncodedCommand {}", to_ps_b64("cd D:\\data"));
        let sem_cd = analyze(&cmd_cd);
        assert_eq!(sem_cd.overall_class, CommandClass::CdShape);
        assert_eq!(sem_cd.decoded_payload.as_deref(), Some("cd D:\\data"));

        // 4. 内层为 DeleteShape 命令：识别为删除形态/间接删除
        let cmd_del = format!(
            "powershell -ec {}",
            to_ps_b64("Remove-Item C:\\test -Force")
        );
        let sem_del = analyze(&cmd_del);
        assert!(
            sem_del.has_indirect_delete || sem_del.overall_class == CommandClass::DeleteShape,
            "Base64 内层删除形态必须识别: {sem_del:?}"
        );
        assert_eq!(
            sem_del.decoded_payload.as_deref(),
            Some("Remove-Item C:\\test -Force")
        );
    }

    #[test]
    fn test_cd_commands_expansion() {
        // CD_COMMANDS 扩充覆盖 Push-Location, Pop-Location, chdir
        let cd_cases = [
            "Push-Location D:\\project",
            "push-location D:\\project",
            "Pop-Location",
            "pop-location",
            "chdir D:\\project",
            "CHDIR /d D:\\project",
            "pushd D:\\project",
            "popd",
            "Set-Location D:\\project",
            "sl D:\\project",
            "cd D:\\project",
        ];
        for cmd in cd_cases {
            let res = analyze(cmd);
            assert_eq!(
                res.overall_class,
                CommandClass::CdShape,
                "CD 命令扩充必须命中 CdShape: {cmd}"
            );
        }
    }

    #[test]
    fn test_indirect_cd_shape_propagation() {
        // 间接执行包裹内含 cd 必须透传为 CdShape（防 CD 逃逸）
        let indirect_cd_cases = [
            "cmd /c \"cd /d D:\\ && whoami\"",
            "cmd.exe /c \"cd D:\\\"",
            "powershell -Command \"cd D:\\; dir\"",
            "pwsh -Command \"Push-Location D:\\; Get-ChildItem\"",
            "cmd /c \"chdir /d D:\\code\"",
        ];
        for cmd in indirect_cd_cases {
            let res = analyze(cmd);
            assert_eq!(
                res.overall_class,
                CommandClass::CdShape,
                "间接执行包裹内的 cd 必须判定为 CdShape: {cmd}, 实际: {res:?}"
            );
        }
    }

    #[test]
    fn test_powershell_working_directory_escape() {
        // -WorkingDirectory / -wd 逃逸启动参数必须被判定为 CdShape
        let wd_cases = [
            "pwsh -wd D:\\",
            "powershell -WorkingDirectory C:\\test -Command \"Get-Process\"",
            "pwsh -wd:D:\\code -Command \"cargo build\"",
            "powershell /wd D:\\",
            "pwsh --workingdirectory=D:\\repo -c \"dir\"",
        ];
        for cmd in wd_cases {
            let res = analyze(cmd);
            assert_eq!(
                res.overall_class,
                CommandClass::CdShape,
                "PowerShell -wd 目录逃逸必须判定为 CdShape: {cmd}, 实际: {res:?}"
            );
        }
    }
}

//! evaluate 受限求值（维度 14 §8，evaluate.rs —— 17 文档 §3 唯一权威，R-6）
//!
//! 三层校验（fail-closed，17 §3.2）：
//! 1. **静态词法**（执行前）：token 扫描——赋值类操作符（`=`/`+=`/`--`/`++`/`delete`）、
//!    白名单对象之外全局访问、禁用关键字/API 名；脚本长度上限 8KB；命中即拒绝
//!    （`tool.browser.eval_forbidden` 语义），不经执行。
//! 2. **运行时隔离**（执行中）：`Page.createIsolatedWorld` 建独立 world 执行
//!    （Chrome 151 已移除 Runtime.createIsolatedWorld，缺陷 A 修复；主 frameId 经
//!    Page.getFrameTree 获取），建世界后**注入只读白名单代理 `__crish_read`**
//!    （方法白名单 attr/text/rect/formValue/all/state，17 §3.1；缺陷 B 修复——注入
//!    脚本在**同一 world** 执行，用户表达式经同 world 的 Runtime.evaluate 即可见）；
//!    `userGesture:false`、`timeout:2000`、`returnByValue:true`、
//!    `generatePreview:false`；返回值纯 JSON 拷贝（结构化克隆语义，节点引用不出世界）。
//! 3. **结果校验**（执行后）：仅 JSON 标量/数组/纯对象；深度 ≤ 4、序列化 ≤ 64KB；
//!    超限拒绝。
//!
//! 词法层是防打扰的快速面，运行时层是真实保险（isolated world + 白名单代理 +
//! returnByValue 纯 JSON），任一层失败即拒绝；运行时层不依赖静态扫描兜底
//! （17 §3.2 注）。
//!
//! 审批与审计（17 §3.3）：能力位默认关（Ask 逐次审批）；审计记
//! `sha256(expression)` + 长度 + 前 80 字符；结果只记类型与大小。审计发射在工具层
//! （17 §6.1），本模块只做原语。

use crate::action::{ActionError, ActionErrorKind, ActionExecutor, ElementRef};
use serde_json::Value;

/// 受限求值请求（§8.2；允许形态/白名单 API 见 17 §3.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluateRequest {
    /// 受限求值表达式（白名单 API 见 17 §3.1）
    pub expression: String,
    /// 快照元素索引（可选；内部解析为 backendNodeId/objectId 后经代理求值）
    pub element: Option<ElementRef>,
    /// 求值硬限，上限 2000ms（17 §3.2）
    pub timeout_ms: u32,
}

/// 白名单方法（17 §3.1：__crish_read 仅暴露这 6 个只读方法）。
pub const READ_API: &[&str] = &["attr", "text", "rect", "formValue", "all", "state"];

/// 脚本长度上限（17 §3.2 ①，8KB）。
pub const MAX_EXPRESSION_BYTES: usize = 8 * 1024;
/// 结果序列化大小上限（17 §3.2 ③，64KB）。
pub const MAX_RESULT_BYTES: usize = 64 * 1024;
/// 结果深度上限（17 §3.2 ③）。
pub const MAX_RESULT_DEPTH: usize = 4;
/// 执行超时（17 §3.2 ②，2000ms）。
pub const EVAL_TIMEOUT_MS: u32 = 2000;

/// 禁止访问的全局/构造标识符（17 §3.1 禁止面：宿主全局、构造面、网络面、存储面）。
const FORBIDDEN_IDENTS: &[&str] = &[
    // 全局对象面
    "window",
    "document",
    "globalThis",
    "self",
    "top",
    "parent",
    "frames",
    // 导航/环境面
    "location",
    "navigator",
    "history",
    "screen",
    // 网络面
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "sendBeacon",
    // 存储面
    "localStorage",
    "sessionStorage",
    "cookie",
    "indexedDB",
    // 剪贴板面
    "clipboard",
    // 构造面
    "eval",
    "Function",
    "constructor",
    "prototype",
    "__proto__",
    "import",
    "require",
    // 宿主全局（防注入面）
    "process",
    "Deno",
    "Buffer",
    "global",
    "module",
    "exports",
];

/// 字符串成员访问形态的构造面成员（`x['constructor']` 等，17 §3.2 ②）。
const STRING_MEMBER_FORBIDDEN: &[&str] = &["constructor", "prototype", "__proto__"];

/// 赋值类操作符（17 §3.2 ① 黑名单；`==`/`!=`/`===`/`!==`/`=>` 放行）。
const ASSIGN_OPS: &[&str] = &[
    "=", "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??=", "++", "--",
];

/// 全深度禁止关键字（17 §3.1：with/delete 语句形态）。
const ALWAYS_FORBIDDEN_KEYWORDS: &[&str] = &["with", "delete"];

/// 顶层禁止声明关键字（17 §3.1：声明语句；IIFE 函数体内允许）。
const TOPLEVEL_FORBIDDEN_KEYWORDS: &[&str] = &["var", "let", "const", "function", "class"];

/// 词法拒绝原因（结构化错误消息用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexRejection {
    TooLong(usize),
    ForbiddenIdent(String),
    AssignmentOp(String),
    ForbiddenKeyword(String),
    TopLevelStatement,
}

impl std::fmt::Display for LexRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LexRejection::TooLong(n) => {
                write!(f, "脚本长度超限（{n} 字节 > {MAX_EXPRESSION_BYTES}）")
            }
            LexRejection::ForbiddenIdent(s) => write!(f, "禁止访问全局/构造标识符：{s}"),
            LexRejection::AssignmentOp(s) => write!(f, "禁止赋值类操作符：{s}"),
            LexRejection::ForbiddenKeyword(s) => write!(f, "禁止关键字/语句形态：{s}"),
            LexRejection::TopLevelStatement => write!(f, "禁止顶层语句序列（仅单个表达式/IIFE）"),
        }
    }
}

/// 最小 token 扫描器：跳过字符串/模板串/注释/正则字面量，识别标识符与操作符 token。
/// 不追求完整 JS 语法（静态层是防打扰快速面，运行时层兜底），
/// 但必须避免「字符串/注释内黑名单误伤」（正例测试锁定）。
struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    /// 括号深度（顶层 `;` 判定）
    depth: u32,
    /// 标识符 token（含所在深度；声明关键字按深度判定）
    idents: Vec<(String, u32)>,
    ops: Vec<String>,
    /// 最近 push 的 token（`x['constructor']` 字符串成员形态判定）
    last_pushed: Option<String>,
}

impl<'a> Lexer<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            chars: src.chars().peekable(),
            depth: 0,
            idents: Vec::new(),
            ops: Vec::new(),
            last_pushed: None,
        }
    }

    /// 前进一个字符（扫描器语义：仅推进游标）。
    ///
    /// `Iterator::next` 没有错误面，返回的 `Option` 只表示「是否到末尾」；
    /// 调用点均以 `peek()` 确认过当前字符存在，故此处无需处理末尾情况。
    fn bump(&mut self) {
        self.chars.next();
    }

    fn scan(&mut self) {
        while let Some(&c) = self.chars.peek() {
            match c {
                '"' | '\'' => self.scan_string(c),
                '`' => self.skip_template(),
                '/' => {
                    // 注释/正则/`/=` 赋值：`/` 后非 `/`/`*`/`=` 视作正则字面量起点
                    // （克隆迭代器后 nth(1) = 跳过当前 '/' 再取下一个字符）
                    let mut it = self.chars.clone();
                    match it.nth(1) {
                        Some('/') => {
                            self.bump();
                            self.bump();
                            self.skip_line_comment();
                        }
                        Some('*') => {
                            self.bump();
                            self.bump();
                            self.skip_block_comment();
                        }
                        Some('=') => {
                            self.bump();
                            self.bump();
                            self.push_op("/=".to_string());
                        }
                        _ => self.skip_regex(),
                    }
                }
                '(' | '[' | '{' => {
                    self.depth += 1;
                    let tok = c.to_string();
                    self.bump();
                    self.push_op(tok);
                }
                ')' | ']' | '}' => {
                    self.depth = self.depth.saturating_sub(1);
                    let tok = c.to_string();
                    self.bump();
                    self.push_op(tok);
                }
                ';' => {
                    if self.depth == 0 {
                        self.push_op(";".to_string());
                    } else {
                        self.last_pushed = None;
                    }
                    self.bump();
                }
                c if c.is_ascii_alphabetic() || c == '_' || c == '$' => self.scan_ident(),
                c if c.is_ascii_digit() => {
                    self.bump();
                }
                c if c.is_ascii_whitespace() => {
                    self.bump();
                }
                _ => self.scan_op(),
            }
        }
    }

    fn push_op(&mut self, op: String) {
        self.ops.push(op.clone());
        self.last_pushed = Some(op);
    }

    /// 字符串字面量：内容若为「紧邻方括号的构造面成员」（`x['constructor']`）→ 记为黑名单标识符。
    fn scan_string(&mut self, quote: char) {
        self.bump(); // 开引号
        let mut content = String::new();
        while let Some(c) = self.chars.next() {
            if c == '\\' {
                self.bump();
            } else if c == quote {
                break;
            } else {
                content.push(c);
            }
        }
        let member_access = self.last_pushed.as_deref() == Some("[");
        if member_access && STRING_MEMBER_FORBIDDEN.contains(&content.as_str()) {
            self.idents.push((content, self.depth));
        }
        self.last_pushed = None;
    }

    fn skip_template(&mut self) {
        self.bump(); // `
        while let Some(c) = self.chars.next() {
            if c == '\\' {
                self.bump();
            } else if c == '`' {
                break;
            } else if c == '$' && self.chars.peek() == Some(&'{') {
                // ${expr} 内嵌表达式：继续扫描（简化：按模板内容跳过至 `}`——保留扫描一致性）
                self.bump();
            }
        }
    }

    fn skip_line_comment(&mut self) {
        for c in self.chars.by_ref() {
            if c == '\n' {
                break;
            }
        }
    }

    fn skip_block_comment(&mut self) {
        let mut prev = '\0';
        for c in self.chars.by_ref() {
            if prev == '*' && c == '/' {
                break;
            }
            prev = c;
        }
    }

    fn skip_regex(&mut self) {
        let mut in_class = false;
        while let Some(c) = self.chars.next() {
            if c == '\\' {
                self.bump();
                continue;
            }
            if c == '[' {
                in_class = true;
                continue;
            }
            if c == ']' {
                in_class = false;
                continue;
            }
            if c == '/' && !in_class {
                break;
            }
            if c == '\n' {
                break;
            } // 单行正则字面量（简化）
        }
    }

    fn scan_ident(&mut self) {
        let mut s = String::new();
        while let Some(&c) = self.chars.peek() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' {
                s.push(c);
                self.bump();
            } else {
                break;
            }
        }
        self.idents.push((s.clone(), self.depth));
        self.last_pushed = Some(s);
    }

    fn scan_op(&mut self) {
        // 收集最长操作符前缀（2-3 字符），跳过非操作符字符
        let mut s = String::new();
        while let Some(&c) = self.chars.peek() {
            if c.is_ascii_alphanumeric()
                || c.is_ascii_whitespace()
                || c == '_'
                || c == '$'
                || c == '('
                || c == ')'
                || c == '['
                || c == ']'
                || c == '{'
                || c == '}'
            {
                break;
            }
            s.push(c);
            self.bump();
            if s.len() >= 3 {
                break;
            }
        }
        if !s.is_empty() {
            self.push_op(s);
        }
    }
}

/// 静态词法校验（17 §3.2 ①）。
pub fn lexical_check(expression: &str) -> Result<(), LexRejection> {
    if expression.len() > MAX_EXPRESSION_BYTES {
        return Err(LexRejection::TooLong(expression.len()));
    }
    let mut lexer = Lexer::new(expression);
    lexer.scan();

    for (ident, depth) in &lexer.idents {
        if FORBIDDEN_IDENTS.contains(&ident.as_str()) {
            return Err(LexRejection::ForbiddenIdent(ident.clone()));
        }
        if ALWAYS_FORBIDDEN_KEYWORDS.contains(&ident.as_str()) {
            return Err(LexRejection::ForbiddenKeyword(ident.clone()));
        }
        if *depth == 0 && TOPLEVEL_FORBIDDEN_KEYWORDS.contains(&ident.as_str()) {
            return Err(LexRejection::ForbiddenKeyword(ident.clone()));
        }
    }
    for op in &lexer.ops {
        if ASSIGN_OPS.contains(&op.as_str()) {
            return Err(LexRejection::AssignmentOp(op.clone()));
        }
        if op == ";" {
            return Err(LexRejection::TopLevelStatement);
        }
    }
    Ok(())
}

/// 结果校验（17 §3.2 ③）：深度 ≤ 4、序列化 ≤ 64KB。
pub fn validate_result(value: &Value) -> Result<(), LexRejection> {
    fn depth(v: &Value, d: usize) -> usize {
        match v {
            Value::Array(items) => items.iter().map(|i| depth(i, d + 1)).max().unwrap_or(d),
            Value::Object(map) => map.values().map(|i| depth(i, d + 1)).max().unwrap_or(d),
            _ => d,
        }
    }
    let d = depth(value, 0);
    if d > MAX_RESULT_DEPTH {
        return Err(LexRejection::TopLevelStatement); // 复用 Display 面：超限语义在消息层区分
    }
    let bytes = serde_json::to_string(value).unwrap_or_default().len();
    if bytes > MAX_RESULT_BYTES {
        return Err(LexRejection::TooLong(bytes));
    }
    Ok(())
}

/// 受限求值派发：三层校验（词法 → 隔离执行 → 结果校验）。
///
/// 失败映射（17 §1.3）：词法/结果超限 → `InvalidInput`（工具层映射
/// `tool.browser.eval_forbidden`）；执行超时 → `Timeout`；执行异常 →
/// `InvalidInput`（消息含"受限求值执行异常"）；能力位/审批由工具层先行拦截。
pub async fn dispatch_evaluate(
    exec: &ActionExecutor,
    request: &EvaluateRequest,
) -> Result<Option<Value>, ActionError> {
    // ① 静态词法
    lexical_check(&request.expression).map_err(|r| {
        ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("受限求值词法拒绝：{r}"),
        )
    })?;

    // ② 隔离执行（每次创建独立 world——页面导航即失效，简单可靠）
    let world = exec.ops.create_isolated_world().await.map_err(|e| {
        ActionError::new(
            ActionErrorKind::Unsupported,
            format!("隔离世界创建失败：{}", e.message),
        )
    })?;
    let result = exec
        .ops
        .evaluate_isolated(&world, &request.expression)
        .await
        .map_err(|e| {
            if e.kind == ActionErrorKind::Timeout {
                e
            } else {
                ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("受限求值执行失败：{}", e.message),
                )
            }
        })?;

    // ③ 结果校验
    validate_result(&result).map_err(|r| {
        ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("受限求值结果超限：{r}"),
        )
    })?;

    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::ActionExecutor;
    use crate::cdp::sender::CancellationToken;
    use std::sync::Arc;

    fn executor_with(ops: MockOps) -> ActionExecutor {
        ActionExecutor::new(
            Arc::new(ops),
            Arc::new(MockSnapshotStore::new(1)),
            CancellationToken::new(),
        )
    }

    fn req(expression: &str) -> EvaluateRequest {
        EvaluateRequest {
            expression: expression.to_string(),
            element: None,
            timeout_ms: EVAL_TIMEOUT_MS,
        }
    }

    // ── 词法层 ──

    #[test]
    fn lexical_accepts_read_only_expression() {
        assert!(lexical_check("__crish_read.text('#login')").is_ok());
        assert!(lexical_check("__crish_read.all('.item')").is_ok());
        assert!(lexical_check("(function(){ return __crish_read.attr('#a','href'); })()").is_ok());
        assert!(lexical_check("__crish_read.rect('#box').width").is_ok());
    }

    #[test]
    fn lexical_rejects_assignment_ops() {
        for op in ASSIGN_OPS {
            let expr = format!("__crish_read.text('#a') {op} 1");
            assert_eq!(
                lexical_check(&expr),
                Err(LexRejection::AssignmentOp(op.to_string()))
            );
        }
    }

    #[test]
    fn lexical_allows_equality_and_arrow() {
        // == != === !== => 放行（非赋值）
        assert!(lexical_check("__crish_read.state()['x'] === 1").is_ok());
        assert!(lexical_check("__crish_read.state().a != null").is_ok());
        assert!(lexical_check("(v => v)(__crish_read.text('#a'))").is_ok());
    }

    #[test]
    fn lexical_rejects_forbidden_idents() {
        for ident in [
            "document",
            "window",
            "eval",
            "Function",
            "constructor",
            "__proto__",
            "fetch",
            "localStorage",
            "location",
            "process",
            "require",
        ] {
            let expr = format!("{ident}.x");
            assert_eq!(
                lexical_check(&expr),
                Err(LexRejection::ForbiddenIdent(ident.to_string()))
            );
        }
    }

    #[test]
    fn lexical_rejects_constructor_chain() {
        // 方法链取构造器形态（17 §3.1：[] .filter.constructor 等）
        assert!(lexical_check("[].filter.constructor").is_err());
        assert!(lexical_check("a.constructor.constructor").is_err());
        assert!(lexical_check("x['constructor']").is_err());
        assert!(lexical_check("__crish_read.text('#a').constructor").is_err());
    }

    #[test]
    fn lexical_rejects_keywords_and_statements() {
        assert_eq!(
            lexical_check("with(document){}"),
            Err(LexRejection::ForbiddenKeyword("with".to_string()))
        );
        assert!(lexical_check("delete __crish_read").is_err());
        assert!(lexical_check("new Function('return 1')").is_err());
        assert!(lexical_check("let x = 1").is_err());
        assert!(lexical_check("var x = 1").is_err());
        // IIFE 函数体内声明允许（深度 > 0），顶层声明拒绝；赋值（任何深度）拒绝
        assert!(lexical_check("(function(){ var x; return x; })()").is_ok());
        assert!(lexical_check("(function(){ var x = 1; return x; })()").is_err());
    }

    #[test]
    fn lexical_rejects_top_level_semicolons() {
        assert_eq!(
            lexical_check("__crish_read.text('#a'); __crish_read.text('#b')"),
            Err(LexRejection::TopLevelStatement)
        );
        // IIFE 内部的分号不误伤（深度 > 0）
        assert!(lexical_check("(function(){ var x; return __crish_read.text('#a'); })()").is_ok());
    }

    #[test]
    fn lexical_no_false_positive_in_strings_and_comments() {
        // 字符串/注释内的黑名单不误伤
        assert!(lexical_check("__crish_read.attr('#a', 'document')").is_ok());
        assert!(lexical_check("__crish_read.text('#a') // window.eval is fine in comment").is_ok());
        assert!(lexical_check("/* constructor */ __crish_read.text('#a')").is_ok());
        assert!(lexical_check("__crish_read.attr('#a', 'x = 1')").is_ok());
        assert!(lexical_check("`template document` + __crish_read.text('#a')").is_ok());
    }

    #[test]
    fn lexical_length_limit() {
        let long = "x".repeat(MAX_EXPRESSION_BYTES + 1);
        assert_eq!(
            lexical_check(&long),
            Err(LexRejection::TooLong(MAX_EXPRESSION_BYTES + 1))
        );
    }

    // ── 结果校验 ──

    #[test]
    fn result_depth_and_size_limits() {
        assert!(validate_result(&serde_json::json!({"a": {"b": {"c": {"d": 1}}}})).is_ok());
        let deep = serde_json::json!({"a": {"b": {"c": {"d": {"e": 1}}}}});
        assert!(validate_result(&deep).is_err());
        let big = serde_json::json!({"x": "y".repeat(MAX_RESULT_BYTES)});
        assert!(validate_result(&big).is_err());
    }

    // ── 派发面 ──

    #[tokio::test]
    async fn dispatch_success_path() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
            s.isolated_result = serde_json::json!({"tag": "button", "text": "你好"});
        }
        let exec = executor_with(ops.clone());
        let out = dispatch_evaluate(&exec, &req("__crish_read.text('#b')"))
            .await
            .expect("应成功");
        assert_eq!(
            out,
            Some(serde_json::json!({"tag": "button", "text": "你好"}))
        );
        // 记录：创建世界 → 隔离求值（顺序）
        let s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
        let ops_seq: Vec<_> = s.calls.iter().map(|c| c.op).collect();
        let expected = vec![MockOp::CreateIsolatedWorld, MockOp::EvaluateIsolated];
        assert!(
            ops_seq.ends_with(&expected),
            "应依次创建世界并隔离求值，实际 {ops_seq:?}"
        );
        assert!(s
            .calls
            .iter()
            .any(|c| c.op == MockOp::EvaluateIsolated && c.detail.contains("world-42")));
    }

    #[tokio::test]
    async fn dispatch_lexical_rejection_no_world_created() {
        let ops = MockOps::new();
        let exec = executor_with(ops.clone());
        let err = dispatch_evaluate(&exec, &req("document.title"))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        assert!(err.message.contains("词法拒绝"));
        let s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            !s.calls.iter().any(|c| c.op == MockOp::CreateIsolatedWorld),
            "词法拒绝不应创建世界"
        );
    }

    #[tokio::test]
    async fn dispatch_world_creation_failure() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
            s.isolated_world = None;
        }
        let exec = executor_with(ops.clone());
        let err = dispatch_evaluate(&exec, &req("__crish_read.text('#a')"))
            .await
            .unwrap_err();
        assert!(err.message.contains("隔离世界创建失败"));
    }

    #[tokio::test]
    async fn dispatch_result_over_limit() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
            s.isolated_result = serde_json::json!({"a": {"b": {"c": {"d": {"e": 1}}}}});
        }
        let exec = executor_with(ops.clone());
        let err = dispatch_evaluate(&exec, &req("__crish_read.state()"))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        assert!(err.message.contains("结果超限"));
    }

    #[tokio::test]
    async fn dispatch_exec_failure_maps() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap_or_else(|p| p.into_inner());
            s.persist_errors.insert(
                MockOp::EvaluateIsolated,
                ActionError::new(ActionErrorKind::Timeout, "超时（注入）"),
            );
        }
        let exec = executor_with(ops.clone());
        let err = dispatch_evaluate(&exec, &req("__crish_read.text('#a')"))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ActionErrorKind::Timeout, "超时保持 Timeout 语义");
    }
}

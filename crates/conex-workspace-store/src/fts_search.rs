//! FTS 查询辅助：MATCH 表达式 / CJK 检测 / `instr` 子串路径。
//!
//! 由父模 [`crate::fts`] 经 `#[path]` 接入（**SD-16** 黄带切开）。
//! **诚实**：**≠ EL-03**；**不**静默改查询语义。

use super::BlockHit;
use crate::StoreError;
use rusqlite::Connection;

/// 属性键白名单：仅字母数字下划线（`query_blocks` 子模块复用）。
pub(crate) fn is_safe_attr_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// 将用户查询转为 FTS5 MATCH 表达式（空格分词 AND；词加引号防语法注入）。
pub(crate) fn build_fts_query(query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        return String::new();
    }
    q.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            // 短语转义：双引号翻倍
            let escaped = t.replace('\"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 是否含 CJK 脚本字符（统一汉字 / 兼容汉字 / 假名 / 韩文音节）。
///
/// unicode61 将这些字归为 Letter，**无空格连续汉字整段成一个 FTS token**，
/// 子串 `"工作区"` MATCH 无法命中整段 token → 产品路径改走 `instr` 回退。
pub(crate) fn contains_cjk(s: &str) -> bool {
    s.chars().any(is_cjk_char)
}

fn is_cjk_char(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4DBF}' // CJK Ext A
            | '\u{4E00}'..='\u{9FFF}' // CJK Unified
            | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
            | '\u{3040}'..='\u{309F}' // Hiragana
            | '\u{30A0}'..='\u{30FF}' // Katakana
            | '\u{AC00}'..='\u{D7AF}' // Hangul Syllables
    )
}

/// 含 CJK 时的子串检索：对每个空白分词要求 `instr(plain_text, token) > 0`（AND）。
///
/// 使用 `instr` 而非 `LIKE %q%`，避免 `%`/`_` 转义问题；不依赖 FTS tokenizer。
pub(super) fn search_fulltext_cjk_instr(
    conn: &Connection,
    doc_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<BlockHit>, StoreError> {
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        r#"
        SELECT
            doc_id,
            block_id,
            kind,
            plain_text,
            props_json
        FROM blocks
        WHERE doc_id = ?1
        "#,
    );
    let mut bind: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(doc_id.to_string())];
    for t in &tokens {
        let idx = bind.len() + 1;
        sql.push_str(&format!(" AND instr(plain_text, ?{idx}) > 0"));
        bind.push(rusqlite::types::Value::Text((*t).to_string()));
    }
    // 稳定序；rank 固定 0（非 bm25）
    sql.push_str(" ORDER BY order_key ASC, block_id ASC");
    let lim_idx = bind.len() + 1;
    sql.push_str(&format!(" LIMIT ?{lim_idx}"));
    bind.push(rusqlite::types::Value::Integer(limit));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        let plain: String = r.get(3)?;
        Ok(BlockHit {
            doc_id: r.get(0)?,
            block_id: r.get(1)?,
            kind: r.get(2)?,
            snippet: truncate_plain_snippet(&plain),
            rank: 0.0,
            props_json: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// plain_text 截断作 snippet（CJK 路径 / 无 FTS snippet 时）。
fn truncate_plain_snippet(plain: &str) -> String {
    const MAX: usize = 64;
    if plain.chars().count() > MAX {
        let s: String = plain.chars().take(MAX).collect();
        format!("{s}…")
    } else {
        plain.to_string()
    }
}

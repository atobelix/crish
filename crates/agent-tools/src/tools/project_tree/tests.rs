// G2 测试面：临时工作区清理（删除测试目录内文件，非产品删除路径，
// 可恢复语义不适用）——对齐 clippy.toml 豁免面（测试临时目录清理）
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::context::{create_mock_tool_context, ToolContext};
use conex_test_utils::TempWorkspace;

/// 测试用会话上下文：workspace_root 指向临时工作区
fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
    ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    }
}

fn sample_ws() -> TempWorkspace {
    let ws = TempWorkspace::new("ptree_shape");
    ws.write_file("src/main.rs", "fn main() {}\n");
    ws.write_file("src/lib.rs", "pub fn x() {}\n");
    ws.write_file("docs/readme.md", "# doc\n");
    ws.write_file("Cargo.toml", "[package]\n");
    ws
}

/// 取树文本（含根行与摘要行的完整文本）
fn tree_text(out: &serde_json::Value) -> String {
    out["text"].as_str().unwrap().to_string()
}

/// 只取树体行（去掉根行与尾部摘要块）
fn tree_body(out: &serde_json::Value) -> Vec<String> {
    let text = tree_text(out);
    text.lines()
        .skip(1)
        .take_while(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

#[tokio::test]
async fn tree_shape_dirs_first_sorted_prefixes() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    let text = tree_text(&out);
    let lines: Vec<&str> = text.lines().collect();
    // 首行为根行（根名 + /）
    assert!(lines[0].ends_with('/'), "根行应为根名 + /: {}", lines[0]);
    let body = tree_body(&out);
    // 目录优先 + 字母序（渲染为深度优先：目录行后紧跟其子树）：
    // docs/ → readme.md；src/ → lib.rs main.rs；最后根级文件 Cargo.toml
    assert!(body[0].starts_with("├── docs/"), "got {}", body[0]);
    // docs 非最后兄弟 → 其子树前缀 │
    assert!(body[1].starts_with("│   └── readme.md"), "got {}", body[1]);
    assert!(body[2].starts_with("├── src/"), "got {}", body[2]);
    assert!(body[3].starts_with("│   ├── lib.rs"), "got {}", body[3]);
    assert!(body[4].starts_with("│   └── main.rs"), "got {}", body[4]);
    assert!(body[5].starts_with("└── Cargo.toml"), "got {}", body[5]);
    // JSON 计数：docs/src 2 目录 + main/lib/readme/Cargo 4 文件 = 6 节点
    assert_eq!(out["dirs"], 2);
    assert_eq!(out["files"], 4);
    assert_eq!(out["shown"], 6);
    assert_eq!(out["collapsedNodes"], 0);
    assert_eq!(out["truncated"], false);
}

#[tokio::test]
async fn skips_builtin_dirs_reused() {
    let ws = TempWorkspace::new("ptree_skip");
    ws.write_file("src/a.rs", "x");
    ws.write_file("node_modules/pkg/index.js", "x");
    ws.write_file("target/debug/app.exe", "x");
    ws.write_file("dist/bundle.js", "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    let text = tree_text(&out);
    // SKIP_DIRS 复用：node_modules/target/dist 整枝不出树（src 正常）
    assert!(!text.contains("node_modules"), "{text}");
    assert!(!text.contains("target"), "{text}");
    assert!(!text.contains("dist"), "{text}");
    assert!(text.contains("src/"), "{text}");
    assert_eq!(out["dirs"], 1);
    assert_eq!(out["files"], 1);
}

#[tokio::test]
async fn dirs_only_excludes_files() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "dirsOnly": true }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    assert!(!text.contains("main.rs"), "{text}");
    assert!(!text.contains("Cargo.toml"), "{text}");
    assert!(text.contains("src/"), "{text}");
    assert_eq!(out["files"], 0);
    assert_eq!(out["dirs"], 2);
    assert_eq!(out["shown"], 2);
}

#[tokio::test]
async fn include_files_false_equals_dirs_only() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "includeFiles": false }),
        )
        .await
        .unwrap();
    assert_eq!(out["files"], 0);
    assert_eq!(out["shown"], 2);
    // dirsOnly=true 折叠到同一参数面（同一缓存键）→ 同文本
    let out2 = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "dirsOnly": true }),
        )
        .await
        .unwrap();
    assert_eq!(out["text"], out2["text"]);
    assert_eq!(out2["cacheHit"], true, "同一参数面应命中缓存");
}

#[tokio::test]
async fn exclude_globs_prunes_subtree() {
    let ws = TempWorkspace::new("ptree_exclude");
    ws.write_file("src/generated/gen.rs", "x");
    ws.write_file("src/generated/extra/deep.rs", "x");
    ws.write_file("src/keep.rs", "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "excludeGlobs": ["**/generated/**"] }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    assert!(
        !text.contains("generated"),
        "整枝剪除：generated 子树不出树: {text}"
    );
    assert!(text.contains("keep.rs"), "{text}");
    assert_eq!(out["dirs"], 1);
    assert_eq!(out["files"], 1);
}

#[tokio::test]
async fn exclude_globs_file_pattern_skips_files_keeps_dir() {
    let ws = TempWorkspace::new("ptree_exclude_file");
    ws.write_file("src/generated/gen.rs", "x");
    ws.write_file("src/keep.rs", "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "excludeGlobs": ["**/generated/*.rs"] }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    // 文件级 glob：目录保留、命中文件剔除（对齐 grep_search 语义）
    assert!(text.contains("generated/"), "{text}");
    assert!(!text.contains("gen.rs"), "{text}");
    assert!(text.contains("keep.rs"), "{text}");
    assert_eq!(out["files"], 1);
}

#[tokio::test]
async fn depth_clamped_to_max_walk() {
    let ws = TempWorkspace::new("ptree_clamp");
    ws.write_file("a/b/c/d/e/f.txt", "x");
    let tool = ProjectTreeTool::new();
    // depth=999 钳制到 MAX_WALK_DEPTH=16：不报错、输出 depth 字段为 16；
    // maxDepthContent 调高避免折叠遮挡断言目标
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 999, "maxDepthContent": 16 }),
        )
        .await
        .unwrap();
    assert_eq!(out["depth"], 16);
    assert!(
        tree_text(&out).contains("f.txt"),
        "树应包含 f.txt:\n{}",
        tree_text(&out)
    );
}

#[tokio::test]
async fn path_escape_rejected() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let err = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "path": "../escape" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.path_escape");
}

#[tokio::test]
async fn path_subdir_trees_from_that_root() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "path": "src", "depth": 16 }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    assert!(text.contains("main.rs"), "{text}");
    assert!(!text.contains("docs"), "{text}");
    assert_eq!(out["dirs"], 0);
    assert_eq!(out["files"], 2);
}

#[tokio::test]
async fn max_items_folds_with_marker_and_counts() {
    let ws = TempWorkspace::new("ptree_maxitems");
    for i in 0..10 {
        ws.write_file(&format!("a/f{i}.txt"), "x");
    }
    ws.write_file("b/g.txt", "x");
    ws.write_file("b/h.txt", "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "maxItems": 4 }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    assert!(text.contains("项未展开"), "超限应输出折叠行: {text}");
    assert!(text.contains("truncated: true"));
    assert_eq!(out["truncated"], true);
    // 折叠不变量：shown + collapsedNodes = dirs + files
    let dirs = out["dirs"].as_u64().unwrap();
    let files = out["files"].as_u64().unwrap();
    let shown = out["shown"].as_u64().unwrap();
    let collapsed = out["collapsedNodes"].as_u64().unwrap();
    assert_eq!(shown + collapsed, dirs + files);
    assert!(collapsed > 0);
    // 头部稳定：预算内节点照常渲染
    assert!(text.contains("a/"), "{text}");
    assert!(text.contains("f0.txt"), "{text}");
}

#[tokio::test]
async fn max_items_budget_respects_subtree_sizes() {
    let ws = TempWorkspace::new("ptree_budget");
    ws.write_file("a/x1.txt", "x");
    ws.write_file("a/x2.txt", "x");
    ws.write_file("a/x3.txt", "x");
    ws.write_file("b/y1.txt", "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "maxItems": 3 }),
        )
        .await
        .unwrap();
    // 树共 2 目录 + 4 文件 = 6 节点；预算 3：a/ x1 x2 渲染，其余 3 折叠
    assert_eq!(out["shown"], 3);
    assert_eq!(out["collapsedNodes"], 3);
    assert_eq!(out["truncated"], true);
}

#[tokio::test]
async fn max_depth_content_folds_deep_dirs() {
    let ws = TempWorkspace::new("ptree_deepfold");
    ws.write_file("a/b/c/d/e.txt", "x");
    let tool = ProjectTreeTool::new();
    // maxDepthContent=2：显示深度 3 及以上的目录折叠为 (+N 项)
    let out = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "maxDepthContent": 2 }),
        )
        .await
        .unwrap();
    let text = tree_text(&out);
    // 树：a(深1) b(深2) 展开；c(深3) 折叠 → c 子树 = c+d+e 共 3 节点，
    // (+N) 统计 = 子树节点数 - 自身 = 2
    assert!(text.contains("c/ (+2 项)"), "深度 3 目录应折叠: {text}");
    assert!(!text.contains("d/"), "折叠目录子树不出树: {text}");
    assert!(text.contains("a/"), "{text}");
    // 不变量：shown + collapsed = dirs + files
    let shown = out["shown"].as_u64().unwrap();
    let collapsed = out["collapsedNodes"].as_u64().unwrap();
    assert_eq!(
        shown + collapsed,
        out["dirs"].as_u64().unwrap() + out["files"].as_u64().unwrap()
    );
    assert_eq!(collapsed, 2, "c/d 两节点折叠, got {collapsed}");
    assert_eq!(shown, 3, "a/b/c 三行渲染, got {shown}");
}

#[tokio::test]
async fn cache_reused_for_same_params_and_hit_flag() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let args = serde_json::json!({ "depth": 16 });
    let first = tool.execute(&mock_ctx(&ws), args.clone()).await.unwrap();
    assert_eq!(first["cacheHit"], false);
    let second = tool.execute(&mock_ctx(&ws), args).await.unwrap();
    assert_eq!(second["cacheHit"], true);
    assert_eq!(first["text"], second["text"], "缓存命中输出逐字节一致");
}

#[tokio::test]
async fn cache_keyed_by_params() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let d1 = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 1 }))
        .await
        .unwrap();
    assert_eq!(d1["cacheHit"], false);
    // 不同参数（depth）→ 不同缓存条目：重新构建
    let d16 = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(d16["cacheHit"], false);
    assert!(d1["text"].as_str().unwrap() != d16["text"].as_str().unwrap());
    // 参数复归 → 命中原条目
    let d1_again = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 1 }))
        .await
        .unwrap();
    assert_eq!(d1_again["cacheHit"], true);
    assert_eq!(d1["text"], d1_again["text"]);
}

#[tokio::test]
async fn cache_keyed_by_exclude_globs_order() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let a = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "excludeGlobs": ["**/docs/**", "**/src/**"] }),
        )
        .await
        .unwrap();
    // 同一集合不同顺序 → 同一键（排序后 join）：第二次命中
    let b = tool
        .execute(
            &mock_ctx(&ws),
            serde_json::json!({ "depth": 16, "excludeGlobs": ["**/src/**", "**/docs/**"] }),
        )
        .await
        .unwrap();
    assert_eq!(b["cacheHit"], true);
    assert_eq!(a["text"], b["text"]);
}

#[tokio::test]
async fn cache_invalidates_when_file_added() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let first = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(first["cacheHit"], false);
    let hit = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(hit["cacheHit"], true);
    // 新增文件 → 父目录条目数变化 → 指纹失效 → 重建
    ws.write_file("src/new_file.rs", "x");
    let after = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(after["cacheHit"], false, "指纹变化应触发重建");
    assert!(tree_text(&after).contains("new_file.rs"));
    assert_eq!(after["files"], 5);
    // 再次调用恢复命中
    let hit2 = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(hit2["cacheHit"], true);
}

#[tokio::test]
async fn cache_invalidates_when_file_removed() {
    let ws = sample_ws();
    let tool = ProjectTreeTool::new();
    let _ = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    std::fs::remove_file(ws.path().join("docs/readme.md")).unwrap();
    let after = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    assert_eq!(after["cacheHit"], false);
    assert!(!tree_text(&after).contains("readme.md"));
    assert_eq!(after["files"], 3);
}

#[tokio::test]
async fn line_width_truncated_at_char_boundary() {
    let ws = TempWorkspace::new("ptree_wide");
    // ASCII 80 + CJK 55 = 135 chars / 245 bytes：超过 120 字符行宽，且低于
    // Linux 文件名 255 字节上限；截断点落在 CJK 段，覆盖多字节边界。
    let long_name = format!("{}{}", "a".repeat(80), "超长文件名".repeat(11));
    ws.write_file(&format!("{long_name}.txt"), "x");
    let tool = ProjectTreeTool::new();
    let out = tool
        .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
        .await
        .unwrap();
    let text = tree_text(&out);
    let max_line = text.lines().map(|l| l.chars().count()).max().unwrap_or(0);
    assert!(
        max_line <= MAX_LINE_CHARS,
        "树行不得超宽，got {max_line} > {MAX_LINE_CHARS}"
    );
    assert!(text.contains('…'), "超宽行应截断并带省略号");
}

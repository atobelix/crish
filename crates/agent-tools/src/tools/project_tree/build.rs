//! project_tree 树构建：排除式 glob 判定、前序遍历组装与排序

use super::cache::{dir_mtime_ns, TreeEntry, TreeNode};
use super::params::ProjectTreeParams;
use crate::tools::search::{glob_match, walker_for_root, SKIP_DIRS};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// 排除式 glob 判定（对齐 search.rs 语义：无 `/` 的模式匹配末段文件名）
fn glob_excluded(patterns: &[String], rel_str: &str) -> bool {
    patterns.iter().any(|pattern| {
        if pattern.contains('/') {
            glob_match(pattern, rel_str)
        } else {
            glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(rel_str))
        }
    })
}

/// 目录级排除判定（子树模式语义，T-38 扩展）：以 `/**` 结尾的模式按
/// 前缀匹配目录自身即整枝剪除（grep_search 只对文件判定，树需要目录级
/// 剪枝面：`**/generated/**` 剪除整个 generated 子树）；其余模式回退
/// [glob_excluded] 逐文件语义（目录保留、命中文件剔除，与 search 一致）。
///
/// 已知近似（诚实标注）：`a/**` 形式的模式按目录名匹配（任意深度同名
/// 目录剪除），与 gitignore 的深度语义有出入——文件级匹配恒精确。
fn dir_glob_excluded(patterns: &[String], rel_str: &str) -> bool {
    patterns.iter().any(|pattern| {
        if let Some(prefix) = pattern.strip_suffix("/**") {
            if prefix.is_empty() {
                return true; // "/**" 裸子树模式：剪除一切
            }
            if prefix.contains('/') {
                return glob_match(prefix, rel_str);
            }
            return glob_match(prefix, rel_str.rsplit('/').next().unwrap_or(rel_str));
        }
        if pattern.contains('/') {
            glob_match(pattern, rel_str)
        } else {
            glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(rel_str))
        }
    })
}

/// 构建树（一次前序遍历；SKIP_DIRS 由 walker_for_root 目录级剪枝，
/// excludeGlobs 由本函数跟踪已排除目录集合剪枝）。
///
/// 栈式组装：`stack[k]` 承载「深度 k 的最后一个目录」的子节点缓冲，
/// walker 前序保证子节点在父之后连续到达，出栈时把缓冲挂回父节点并
/// 完成排序与 size 累计（自底向上）。已排除目录不入栈也不进树，其后代
/// 由排除集合跳过——栈深度不依赖被剪枝子树，天然对齐。
pub(super) fn build_tree(params: &ProjectTreeParams) -> TreeEntry {
    let root_is_dir = std::fs::metadata(&params.root)
        .map(|m| m.is_dir())
        .unwrap_or(true);
    let mut stack: Vec<Vec<TreeNode>> = vec![Vec::new()];
    let mut fingerprints: HashMap<PathBuf, (u64, usize)> = HashMap::new();
    let mut excluded: HashSet<PathBuf> = HashSet::new();
    let mut dirs = 0usize;
    let mut files = if root_is_dir { 0 } else { 1 };

    if root_is_dir {
        // 根目录自身指纹（根内容变动恒检出）
        fingerprints.insert(
            params.root.clone(),
            (
                dir_mtime_ns(&params.root),
                std::fs::read_dir(&params.root)
                    .map(|rd| rd.count())
                    .unwrap_or(0),
            ),
        );
        for entry in walker_for_root(&params.root, params.depth, SKIP_DIRS).flatten() {
            let path = entry.path().to_path_buf();
            let rel = path.strip_prefix(&params.root).unwrap_or(&path);
            let depth_rel = rel.components().count();
            if depth_rel == 0 {
                continue; // 根条目自身（指纹已记录）；空子树缓冲留在栈底
            }
            // 位于已排除子树内：跳过（含该目录自身与其全部后代）
            if excluded.iter().any(|ex| path.starts_with(ex)) {
                continue;
            }
            // 栈对齐到当前深度（前序：深度先升后降），出栈缓冲挂回父节点
            while stack.len() > depth_rel {
                let Some(done) = stack.pop() else {
                    break;
                };
                if let Some(parent) = stack.last_mut().and_then(|lv| lv.last_mut()) {
                    parent.children.extend(done);
                    sort_and_finalize(&mut parent.children);
                    parent.size = 1 + parent.children.iter().map(|c| c.size).sum::<usize>();
                }
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if is_dir {
                // 排除式 glob 命中目录 → 整枝剪除（子树跳过，不入栈）
                if dir_glob_excluded(&params.exclude_globs, &rel_str) {
                    excluded.insert(path);
                    continue;
                }
                fingerprints.insert(
                    path.clone(),
                    (
                        dir_mtime_ns(&path),
                        std::fs::read_dir(&path).map(|rd| rd.count()).unwrap_or(0),
                    ),
                );
                dirs += 1;
                if let Some(last) = stack.last_mut() {
                    last.push(TreeNode {
                        name,
                        is_dir: true,
                        size: 1,
                        children: Vec::new(),
                    });
                }
                stack.push(Vec::new());
            } else if params.include_files {
                if glob_excluded(&params.exclude_globs, &rel_str) {
                    continue;
                }
                files += 1;
                if let Some(last) = stack.last_mut() {
                    last.push(TreeNode {
                        name,
                        is_dir: false,
                        size: 1,
                        children: Vec::new(),
                    });
                }
            }
        }
    }
    // 收尾：逐层出栈挂载（自底向上完成排序与 size）
    while stack.len() > 1 {
        let Some(done) = stack.pop() else {
            break;
        };
        if let Some(parent) = stack.last_mut().and_then(|lv| lv.last_mut()) {
            parent.children.extend(done);
            sort_and_finalize(&mut parent.children);
            parent.size = 1 + parent.children.iter().map(|c| c.size).sum::<usize>();
        }
    }
    let mut children = stack.pop().unwrap_or_default();
    sort_and_finalize(&mut children);
    TreeEntry {
        root_display: params.root_display.clone(),
        root_is_dir,
        children,
        dirs,
        files,
        fingerprints,
    }
}

/// 排序（目录优先 + 字母序）——确定性决定树文本字节（缓存命中面稳定）
fn sort_and_finalize(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
}

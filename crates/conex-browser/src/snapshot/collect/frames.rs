//! 跨域 iframe 递归采集：帧预算、帧候选筛选、owner 定位与帧会话生命周期。

use super::*;

/// 跨域帧预算（§1.5：max_iframes=64 与主 DOMSnapshot 文档数**共用**同一上限，
/// 跨域递归帧数并入；512KB 硬护栏原始载荷跨帧累计，46 复核——T-2 双层语义
/// 中硬护栏承接跨帧累计，150KB 降级阈值仅作用于单文档合计）。
#[derive(Debug, Clone, Copy)]
pub(super) struct FrameBudget {
    /// 剩余可处理的跨域帧数（主文档数已从 64 中扣除）
    pub(super) frames_left: usize,
    /// 剩余可用原始载荷字节
    pub(super) payload_left: usize,
}

impl FrameBudget {
    pub(super) fn new(frames_left: usize, payload_left: usize) -> Self {
        FrameBudget {
            frames_left,
            payload_left,
        }
    }
}

// ===========================================================================
// 跨域 iframe 递归采集（维度 13 §1.5 二期语义，U-4）
// ===========================================================================
//
// ## 索引协调选择（backendNodeId 碰撞处理）
// 采用**全局唯一（合成索引兜底）**而非帧内索引空间隔离：
// - 各帧会话的 DOMSnapshot.backendNodeId 在其**会话内**全局唯一，但跨会话
//   会复用（CDP 不保证跨会话唯一）；
// - 子帧根树与主树同入 `roots` 根森林，序列化侧（serialize.rs §3.3）以
//   「默认索引 = backendNodeId，冲突时从树中全部 id 的 max+1 起分配合成
//   索引」保证最终模型索引全局唯一——本层不做二次分配，碰撞由既有机制
//   消解（测试断言索引唯一性）。
// - 遗留交接：`NodeRef`（selector_map）的 `session_id`/`frame_target_id`
//   目前由序列化侧统一填写（一期接口）；跨帧元素的会话归属注入执行面
//   （维度 14 动作跨 iframe 执行）为执行侧接线项，登记交接。
//
// ## 跨域帧会话生命周期选择：采集后立即 detach（不缓存）
// 理由：① 快照是只读一次性读取，下一轮快照重新 attach 的单轮往返成本
// 可忽略；② 帧导航/替换会使缓存会话失效，缓存需失效管理与错误重试面；
// ③ 不 detach 会在长会话中累积至多 64 个附加会话（泄漏面）。若后续实测
// attach 开销显著，可升级为会话级 LRU 缓存（登记为演进项）。

/// 帧级采集中间产物（子帧 DOMSnapshot 解析 + AX + 载荷 + 已 pierce 帧集合）。
struct FrameDocument {
    capture: CaptureSnapshotResult,
    document: GetDocumentResult,
    ax: Vec<AXNode>,
    /// 原始载荷估算字节（DOMSnapshot + DOM.getDocument 文本长）
    payload: usize,
    /// 该帧会话 DOMSnapshot 文档集的 frameId（子帧递归的 pierce 集合）
    pierced: HashSet<String>,
}

/// 帧候选筛选（纯函数，单测面）：同源 pierce 排除 → 去重 → 深度预算 →
/// 帧数/载荷预算。返回 true = 值得继续（尺寸门限需 owner 树定位，留在
/// 调用方异步判定）。
///
/// 预算语义：**尺寸/定位不过门的帧不计入 64 上限**（§1.5「小 iframe 不
/// 进入」），帧数预算在通过全部前置判定后才由调用方扣减。
pub(super) fn frame_candidate_eligible(
    frame_id: &str,
    pierced: &HashSet<String>,
    visited: &mut HashSet<String>,
    depth: usize,
    budget: &FrameBudget,
    stats: &mut CrossOriginStats,
) -> bool {
    // 同源 pierce 已覆盖（DOMSnapshot 文档集内）→ 跳过
    if pierced.contains(frame_id) {
        return false;
    }
    // 已访问去重（防环/重复子树防御）
    if !visited.insert(frame_id.to_string()) {
        return false;
    }
    // 深度预算（max_iframe_depth=4：主文档深度 0，递归至多 4 层）
    if depth + 1 > MAX_IFRAME_DEPTH {
        stats.skipped_budget += 1;
        return false;
    }
    // 帧数预算（max_iframes=64 共用）与载荷预算（150KB，T-2）
    if budget.frames_left == 0 || budget.payload_left == 0 {
        stats.skipped_budget += 1;
        return false;
    }
    true
}

/// 尺寸门限（§1.5：尺寸 ≥ 10px×10px 才进入递归；无法确认尺寸 → 不进入，
/// 保守语义——无 bounds 的帧按占位呈现）。
pub(super) fn iframe_size_qualified(bounds: Option<Bounds>) -> bool {
    match bounds {
        Some(b) => b.width >= MIN_IFRAME_SIZE && b.height >= MIN_IFRAME_SIZE,
        None => false,
    }
}

/// src URL 匹配兜底（§1.5：getFrameOwner 失败/frameId 不在树时按 src 定位
/// iframe owner；精确匹配，重定向场景由 getFrameOwner 主路径覆盖）。
pub(super) fn find_owner_by_src(roots: &[EnhancedNode], url: &str) -> Option<i64> {
    for root in roots {
        let mut hit = None;
        root.walk(&mut |n| {
            if hit.is_none() && n.tag.as_deref() == Some("iframe") && n.get_attr("src") == Some(url)
            {
                hit = Some(n.backend_node_id);
            }
        });
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// 按 backendNodeId 查找节点（owner 存在性/尺寸定位；显式递归，避免
/// 闭包借用逃逸——walk 回调的生命周期约束）。
pub(super) fn find_node_by_id(roots: &[EnhancedNode], backend_id: i64) -> Option<&EnhancedNode> {
    for root in roots {
        if let Some(hit) = find_node_rec(root, backend_id) {
            return Some(hit);
        }
    }
    None
}

pub(super) fn find_node_rec(node: &EnhancedNode, backend_id: i64) -> Option<&EnhancedNode> {
    if node.backend_node_id == backend_id {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|c| find_node_rec(c, backend_id))
}

/// 节点布局 bounds 查找（尺寸门限输入）。
pub(super) fn find_node_bounds(roots: &[EnhancedNode], backend_id: i64) -> Option<Bounds> {
    find_node_by_id(roots, backend_id).and_then(|n| n.bounds)
}

/// 给 owner 元素打 `|IFRAME|` 标记（无论递归成功还是占位，标记恒打——
/// 序列化面呈现 iframe 语义，§3.2）。
pub(super) fn mark_owner_iframe(roots: &mut [EnhancedNode], backend_id: i64) -> bool {
    for root in roots {
        if let Some(found) = find_mut_node(root, backend_id) {
            found.frame_marker = Some(FrameMarker::Iframe);
            return true;
        }
    }
    false
}

/// 可变查找（mark_owner_iframe 用；独立于只读 walk 的借用）。
pub(super) fn find_mut_node(node: &mut EnhancedNode, backend_id: i64) -> Option<&mut EnhancedNode> {
    if node.backend_node_id == backend_id {
        return Some(node);
    }
    for child in &mut node.children {
        if let Some(hit) = find_mut_node(child, backend_id) {
            return Some(hit);
        }
    }
    None
}

impl CdpCollector {
    /// 跨域帧递归（§1.5）：对父树未覆盖的帧逐帧「定位 owner → 尺寸门限 →
    /// attach → 采集 → 子树递归 → detach」，子文档根树追加进父树。
    ///
    /// `roots`：父会话增强树（owner 打 `|IFRAME|` 标记 + 接收子根）；
    /// `pierced`：父会话 DOMSnapshot 文档集 frameId（同源已覆盖集合）；
    /// `visited`：全递归共享去重集合；`depth`：相对主文档嵌套深度。
    ///
    /// 实现注记：递归 async 调用需引入间接层避免无限尺寸 future
    /// （E0733）——整体返回 `Pin<Box<dyn Future>>`，与深度预算 4 联动
    /// （盒装指针摊平尺寸，递归深度由 `max_iframe_depth` 钳制）。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn recurse_frames<'a>(
        &'a self,
        parent_session: &'a str,
        roots: &'a mut Vec<EnhancedNode>,
        tree: &'a FrameTree,
        pierced: &'a HashSet<String>,
        visited: &'a mut HashSet<String>,
        depth: usize,
        budget: &'a mut FrameBudget,
        stats: &'a mut CrossOriginStats,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let children = tree.child_frames.as_deref().unwrap_or_default();
            for child in children {
                let frame_id = &child.frame.id;
                let frame_url = child.frame.url.as_str();
                // 前置判定（pierce/去重/深度/帧数/载荷预算；纯函数）
                if !frame_candidate_eligible(frame_id, pierced, visited, depth, budget, stats) {
                    continue;
                }
                // 定位 owner（getFrameOwner 主路径 + src URL 兜底）并打 |IFRAME| 标记
                let owner = match self
                    .locate_frame_owner(roots, parent_session, frame_id, frame_url)
                    .await
                {
                    Some(owner) => owner,
                    None => {
                        // 无法定位 owner：按小/未知帧处理（占位已尽力标记，见 locate）
                        stats.skipped_small += 1;
                        continue;
                    }
                };
                // 尺寸门限（10px×10px，§1.5）
                if !iframe_size_qualified(owner.1) {
                    stats.skipped_small += 1;
                    continue;
                }
                // 预算扣减（至此才占额：尺寸/定位不过门的帧不计入 64）
                budget.frames_left -= 1;
                // 帧级会话建立（frameId 即 OOPIF targetId 主路径；getTargets URL 兜底）
                let frame_session = match self.attach_frame_session(frame_id, frame_url).await {
                    Ok(s) => s,
                    Err(e) => {
                        stats.failed += 1;
                        tracing::warn!("跨域帧 attach 失败（{frame_id}）：{e}");
                        continue;
                    }
                };
                stats.sessions_attached += 1;
                // 子文档采集（DOMSnapshot + DOM.getDocument + AX；失败降级占位）
                let frame_doc = match self.collect_frame_document(&frame_session.session).await {
                    Ok(d) => d,
                    Err(e) => {
                        stats.failed += 1;
                        tracing::warn!("跨域帧采集失败（{frame_id}）：{e}");
                        self.detach_frame_session(&frame_session.session, stats)
                            .await;
                        continue;
                    }
                };
                // 载荷预算（150KB 采集层护栏，T-2）：超限该帧不入树并停止递归
                if frame_doc.payload > budget.payload_left {
                    stats.skipped_budget += 1;
                    tracing::warn!(
                        "跨域帧载荷超剩余预算（{frame_id}：{}B），截断",
                        frame_doc.payload
                    );
                    budget.payload_left = 0;
                    self.detach_frame_session(&frame_session.session, stats)
                        .await;
                    continue;
                }
                budget.payload_left -= frame_doc.payload;

                // 子文档增强树（独立根树，与主树同入根森林；索引碰撞由序列化
                // 合成索引消解——见模块注释「索引协调选择」）
                let mut frame_roots =
                    build_enhanced_tree(&frame_doc.capture, &frame_doc.document, &frame_doc.ax);

                // 子帧自身的跨域子帧递归（其 getFrameTree 失败则跳过嵌套递归，
                // 已采内容保留——best-effort 语义）
                match tokio::time::timeout(
                    FRAME_COLLECT_TIMEOUT,
                    self.session.send_page::<GetFrameTreeResult>(
                        &frame_session.session,
                        PAGE_GET_FRAME_TREE,
                        json!({}),
                    ),
                )
                .await
                {
                    Ok(Ok(sub_tree)) => {
                        self.recurse_frames(
                            &frame_session.session,
                            &mut frame_roots,
                            &sub_tree.frame_tree,
                            &frame_doc.pierced,
                            visited,
                            depth + 1,
                            budget,
                            stats,
                        )
                        .await;
                    }
                    Ok(Err(e)) => tracing::warn!("子帧帧树采集失败（{frame_id}）：{e}"),
                    Err(_) => tracing::warn!("子帧帧树采集超时（{frame_id}）"),
                }

                // 合并：子文档根树追加进父树根森林
                roots.append(&mut frame_roots);
                stats.frames_collected += 1;

                // 会话生命周期：采集后立即 detach（见模块注释「会话生命周期选择」）
                self.detach_frame_session(&frame_session.session, stats)
                    .await;
            }
        })
    }

    /// 定位 iframe owner（主路径 `DOM.getFrameOwner(frameId)` → backendNodeId；
    /// 失败/结果不在树中时按 src URL 匹配兜底，§1.5）；返回 (backend_id, bounds)。
    /// 标记打点：主路径与兜底路径命中后均给 owner 打 `|IFRAME|` 标记（占位语义）。
    async fn locate_frame_owner(
        &self,
        roots: &mut [EnhancedNode],
        parent_session: &str,
        frame_id: &str,
        frame_url: &str,
    ) -> Option<(i64, Option<Bounds>)> {
        let by_frame = async {
            let res = tokio::time::timeout(
                FRAME_COLLECT_TIMEOUT,
                self.session.send_page::<GetFrameOwnerResult>(
                    parent_session,
                    DOM_GET_FRAME_OWNER,
                    json!({ "frameId": frame_id }),
                ),
            )
            .await
            .ok()?
            .ok()?;
            let backend = res.backend_node_id?;
            // 结果须落在父树中（防御：协议异常/帧漂移时回退 src 匹配）
            if find_node_by_id(roots, backend).is_some() {
                Some(backend)
            } else {
                None
            }
        };
        let owner_id = by_frame
            .await
            .or_else(|| find_owner_by_src(roots, frame_url))?;
        let bounds = find_node_bounds(roots, owner_id);
        mark_owner_iframe(roots, owner_id);
        Some((owner_id, bounds))
    }

    /// 建立帧级会话（主路径：OOPIF 的 targetId 即其 frameId，直接
    /// `Target.attachToTarget`；兜底：`Target.getTargets` 按 type=iframe +
    /// URL 匹配目标再 attach——13 §1.5「src URL 匹配兜底」）。
    async fn attach_frame_session(
        &self,
        frame_id: &str,
        frame_url: &str,
    ) -> Result<SessionRef, String> {
        match self.session.attach_frame(frame_id).await {
            Ok(r) => Ok(r),
            Err(e) => {
                tracing::warn!(
                    "iframe attach 主路径失败（{frame_id}：{e}），尝试 getTargets URL 兜底"
                );
                self.attach_by_target_url(frame_url).await
            }
        }
    }

    /// getTargets URL 兜底（attach 主路径失败时按 iframe 目标 URL 精确匹配）。
    async fn attach_by_target_url(&self, url: &str) -> Result<SessionRef, String> {
        let targets: GetTargetsResult = self
            .session
            .send_browser(TARGET_GET_TARGETS, json!({}))
            .await
            .map_err(|e| e.to_string())?;
        let hit = targets
            .target_infos
            .iter()
            .find(|t| t.target_type == "iframe" && t.url == url)
            .map(|t| t.target_id.clone());
        match hit {
            Some(target_id) => self
                .session
                .attach_frame(&target_id)
                .await
                .map_err(|e| e.to_string()),
            None => Err("getTargets 未找到匹配 URL 的 iframe 目标".to_string()),
        }
    }

    /// 子帧文档采集（DOMSnapshot + DOM.getDocument + AX 三路并行；
    /// 2s 子帧超时护栏；AX 失败降级为空——子帧挂断不得拖垮主快照，§1.5）。
    async fn collect_frame_document(&self, session: &str) -> Result<FrameDocument, String> {
        let fut = async {
            let s = self.session.send_page::<Value>(
                session,
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                json!({
                    "computedStyles": COMPUTED_STYLES_WHITELIST,
                    "includePaintOrder": self.budgets.include_paint_order,
                    "includeDOMRects": self.budgets.include_dom_rects,
                }),
            );
            let d = self.session.send_page::<Value>(
                session,
                DOM_GET_DOCUMENT,
                json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
            );
            let ax =
                self.session
                    .send_page::<Value>(session, ACCESSIBILITY_GET_FULL_AX_TREE, json!({}));
            (s.await, d.await, ax.await)
        };
        let (s, d, ax) = tokio::time::timeout(FRAME_COLLECT_TIMEOUT, fut)
            .await
            .map_err(|_| "子帧采集超时".to_string())?;
        let snapshot_value = s.map_err(|e| format!("子帧 DOMSnapshot 失败：{e}"))?;
        let dom_value = d.map_err(|e| format!("子帧 DOM.getDocument 失败：{e}"))?;
        // 载荷估算同主通道分层：结构通道超预算 → 降级丢弃（payload 仅计主通道）
        let snapshot_bytes = snapshot_value.to_string().len();
        let dom_bytes = dom_value.to_string().len();
        let dom_degraded = snapshot_bytes + dom_bytes > MAX_RAW_PAYLOAD_BYTES;
        if dom_degraded {
            tracing::warn!(
                "子帧 DOM.getDocument 结构通道载荷超预算（快照 {snapshot_bytes}B + 结构 {dom_bytes}B），降级仅用 DOMSnapshot"
            );
        }
        let payload = if dom_degraded {
            snapshot_bytes
        } else {
            snapshot_bytes + dom_bytes
        };
        let capture: CaptureSnapshotResult = serde_json::from_value(snapshot_value)
            .map_err(|e| format!("子帧 DOMSnapshot 响应解析失败：{e}"))?;
        let document: GetDocumentResult = if dom_degraded {
            GetDocumentResult::default()
        } else {
            serde_json::from_value(dom_value)
                .map_err(|e| format!("子帧 DOM.getDocument 响应解析失败：{e}"))?
        };
        let ax: Vec<AXNode> = match ax {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                tracing::warn!("子帧 AX 采集失败，降级为空 AX：{e}");
                Vec::new()
            }
        };
        let pierced: HashSet<String> = capture
            .documents
            .iter()
            .filter_map(|d| d.frame_id.as_ref().map(|f| f.resolve(&capture.strings)))
            .collect();
        Ok(FrameDocument {
            capture,
            document,
            ax,
            payload,
            pierced,
        })
    }

    /// 帧会话关闭（best-effort：失败仅告警——目标销毁时 Chrome 自行清理）。
    async fn detach_frame_session(&self, session: &str, stats: &mut CrossOriginStats) {
        match self.session.detach_frame(session).await {
            Ok(()) => stats.sessions_detached += 1,
            Err(e) => tracing::warn!("iframe 会话 detach 失败（{session}）：{e}"),
        }
    }
}

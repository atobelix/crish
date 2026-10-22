//! 真实 CDP 采集器：四路并行 + 首轮超时 + 重发窗口 + AX 降级。

use super::frames::FrameBudget;
use super::*;

/// 真实 CDP 采集器（需要浏览器会话；e2e 验证路径）。
pub struct CdpCollector {
    pub(super) session: std::sync::Arc<crate::BrowserSession>,
    /// 采集预算全集（跨域递归开关 + 采集载荷面开关，46 复核后整体持有；
    /// 构造时传入 BudgetConfig，采集参数面随预算派生一致）
    pub(super) budgets: BudgetConfig,
}

impl CdpCollector {
    pub fn new(session: std::sync::Arc<crate::BrowserSession>, budgets: BudgetConfig) -> Self {
        CdpCollector { session, budgets }
    }
}

/// 真实采集：四路并行 + 首轮 10s 超时 + 2s 重发窗口 + AX 降级。
#[async_trait]
impl SnapshotCollector for CdpCollector {
    async fn collect(&self, _tab_id: &str, session: &str) -> Result<CollectedData, SnapshotError> {
        let started = std::time::Instant::now();

        // —— 首轮并行（10s 超时；AX 失败降级为空，其余失败进重发）——
        let first = tokio::time::timeout(FIRST_ROUND_TIMEOUT, async {
            let snapshot_fut = self.session.send_page::<Value>(
                session,
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                json!({
                    "computedStyles": COMPUTED_STYLES_WHITELIST,
                    "includePaintOrder": self.budgets.include_paint_order,
                    "includeDOMRects": self.budgets.include_dom_rects,
                }),
            );
            let dom_fut = self.session.send_page::<Value>(
                session,
                crate::cdp::domains::names::DOM_GET_DOCUMENT,
                json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
            );
            let metrics_fut =
                self.session
                    .send_page::<Value>(session, PAGE_GET_LAYOUT_METRICS, json!({}));
            let ax_fut =
                self.session
                    .send_page::<Value>(session, ACCESSIBILITY_GET_FULL_AX_TREE, json!({}));
            (
                snapshot_fut.await,
                dom_fut.await,
                metrics_fut.await,
                ax_fut.await,
            )
        })
        .await;

        let (snapshot_res, dom_res, metrics_res, ax_res) = match first {
            Ok(v) => v,
            Err(_) => {
                // 首轮超时：全部取消，2s 窗口内重发主三路（AX 直接降级为空）
                tracing::warn!("快照首轮采集超时，2s 窗口重发主通道");
                let retry = tokio::time::timeout(RETRY_WINDOW, async {
                    let s = self
                        .session
                        .send_page::<Value>(
                            session,
                            DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                            json!({
                                "computedStyles": COMPUTED_STYLES_WHITELIST,
                                "includePaintOrder": self.budgets.include_paint_order,
                                "includeDOMRects": self.budgets.include_dom_rects,
                            }),
                        )
                        .await;
                    let d = self
                        .session
                        .send_page::<Value>(
                            session,
                            DOM_GET_DOCUMENT,
                            json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
                        )
                        .await;
                    (s, d)
                })
                .await;
                match retry {
                    Ok((s, d)) => (s, d, Ok(json!({})), Ok(json!({ "nodes": [] }))),
                    Err(_) => {
                        return Err(SnapshotError::Timeout(
                            crate::snapshot::budget::HARD_TIMEOUT,
                        ));
                    }
                }
            }
        };

        let snapshot_value = snapshot_res.map_err(|e| {
            SnapshotError::Collect(format!("DOMSnapshot.captureSnapshot 失败：{e}"))
        })?;
        let dom_value =
            dom_res.map_err(|e| SnapshotError::Collect(format!("DOM.getDocument 失败：{e}")))?;
        let metrics_value = metrics_res
            .map_err(|e| SnapshotError::Collect(format!("Page.getLayoutMetrics 失败：{e}")))?;

        // —— AX 失败降级为空（§1.2：AX 树失败可降级，主结构不丢）——
        let ax: Vec<AXNode> = match ax_res {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                tracing::warn!("AX 树采集失败，降级为空 AX：{e}");
                Vec::new()
            }
        };

        // —— 反序列化 + 载荷双层护栏（46 复核）——
        // 分层语义：主通道 DOMSnapshot 超 512KB 硬护栏 = 硬错误（主数据缺失
        // 无法降级，防连接爆炸）；结构通道 getDocument 为兜底校验输入
        // （build_enhanced_tree 实际以 DOMSnapshot 重建，getDocument 仅预留
        // 校验面），合计超 150KB 常规预算时**降级跳过结构通道**——仅用
        // DOMSnapshot 继续，快照不失败（性能修复：中页面 getDocument 全深度
        // 215KB vs DOMSnapshot 85KB，曾致合计 ≈300KB 直接报 PayloadOverflow
        // 使采集整体失败；46 复核后 300 条目列表页主通道 326KB 在硬护栏内
        // 成功采集——模型输入面 32KB 截断树不受影响）。
        let snapshot_bytes = snapshot_value.to_string().len();
        if snapshot_bytes > HARD_RAW_PAYLOAD_BYTES {
            return Err(SnapshotError::PayloadOverflow {
                bytes: snapshot_bytes,
                max: HARD_RAW_PAYLOAD_BYTES,
            });
        }
        let dom_bytes = dom_value.to_string().len();
        let dom_degraded = snapshot_bytes + dom_bytes > MAX_RAW_PAYLOAD_BYTES;
        if dom_degraded {
            tracing::warn!(
                "DOM.getDocument 结构通道载荷超常规预算（快照 {snapshot_bytes}B + 结构 {dom_bytes}B > {}B），降级仅用 DOMSnapshot 主通道",
                MAX_RAW_PAYLOAD_BYTES
            );
        }
        // 降级后 payload 仅计主通道（被丢弃的结构通道不计入原始载荷估算）
        let payload_bytes = if dom_degraded {
            snapshot_bytes
        } else {
            snapshot_bytes + dom_bytes
        };

        let capture: CaptureSnapshotResult = serde_json::from_value(snapshot_value)
            .map_err(|e| SnapshotError::Collect(format!("DOMSnapshot 响应解析失败：{e}")))?;
        // 降级时结构通道以空占位（build_enhanced_tree 不使用该输入，仅签名占位）
        let document: GetDocumentResult = if dom_degraded {
            GetDocumentResult::default()
        } else {
            serde_json::from_value(dom_value)
                .map_err(|e| SnapshotError::Collect(format!("DOM.getDocument 响应解析失败：{e}")))?
        };

        let metrics: crate::cdp::domains::GetLayoutMetricsResult = serde_json::from_value(
            metrics_value,
        )
        .unwrap_or(crate::cdp::domains::GetLayoutMetricsResult {
            layout_viewport: crate::cdp::domains::LayoutViewport {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
                page_x: 0.0,
                page_y: 0.0,
                client_width: 1280.0,
                client_height: 800.0,
                scale: Some(1.0),
            },
            visual_viewport: crate::cdp::domains::VisualViewport {
                offset_x: 0.0,
                offset_y: 0.0,
                page_x: 0.0,
                page_y: 0.0,
                client_width: 1280.0,
                client_height: 800.0,
                scale: 1.0,
            },
            content_size: None,
        });

        let layout = LayoutMetrics {
            viewport: Bounds {
                x: metrics.layout_viewport.viewport_x(),
                y: metrics.layout_viewport.viewport_y(),
                width: metrics.layout_viewport.viewport_width(),
                height: metrics.layout_viewport.viewport_height(),
            },
            device_pixel_ratio: metrics.layout_viewport.scale.unwrap_or(1.0),
        };

        let mut roots = build_enhanced_tree(&capture, &document, &ax);
        let mut cross_origin = CrossOriginStats::default();

        // —— 跨域 iframe 递归（U-4 二期；`cross_origin_iframes` 配置位开启时）——
        // §1.5：Page.getFrameTree 取主 frame 树 → 对「未 pierce 的 frame」
        // （其 frameId 不在 DOMSnapshot 文档集内）帧级 attach → 递归采集。
        if self.budgets.cross_origin_iframes {
            match tokio::time::timeout(
                FRAME_COLLECT_TIMEOUT,
                self.session.send_page::<GetFrameTreeResult>(
                    session,
                    PAGE_GET_FRAME_TREE,
                    json!({}),
                ),
            )
            .await
            {
                Ok(Ok(frame_tree)) => {
                    // 已 pierce 帧集合 = DOMSnapshot 文档集的 frameId（同源帧
                    // 已在主采集文档内；frameId 为字符串池下标形态（Chrome 151
                    // 实测），经池解析；缺失时集合为空 → 全部帧按未覆盖处理）
                    let pierced: HashSet<String> = capture
                        .documents
                        .iter()
                        .filter_map(|d| d.frame_id.as_ref().map(|f| f.resolve(&capture.strings)))
                        .collect();
                    // 去重集合（防环/重复子树防御；主帧自身先行占位）
                    let mut visited: HashSet<String> = HashSet::new();
                    visited.insert(frame_tree.frame_tree.frame.id.clone());
                    // 预算：max_iframes=64 与主文档数共用；512KB 硬护栏载荷跨帧累计
                    let mut budget = FrameBudget::new(
                        MAX_IFRAMES.saturating_sub(capture.documents.len()),
                        HARD_RAW_PAYLOAD_BYTES.saturating_sub(payload_bytes),
                    );
                    self.recurse_frames(
                        session,
                        &mut roots,
                        &frame_tree.frame_tree,
                        &pierced,
                        &mut visited,
                        0,
                        &mut budget,
                        &mut cross_origin,
                    )
                    .await;
                }
                Ok(Err(e)) => {
                    tracing::warn!("Page.getFrameTree 失败，跳过跨域 iframe 递归：{e}");
                }
                Err(_) => {
                    tracing::warn!("Page.getFrameTree 超时，跳过跨域 iframe 递归");
                }
            }
            tracing::info!("跨域 iframe 快照统计：{cross_origin:?}");
        }

        let title = capture
            .documents
            .first()
            .and_then(|d| d.title.as_ref())
            .map(|t| t.resolve(&capture.strings))
            .unwrap_or_default();
        let url = capture
            .documents
            .first()
            .and_then(|d| d.document_url.as_ref())
            .map(|u| u.resolve(&capture.strings))
            .unwrap_or_default();

        // —— 耗时预算联动（T-1/46 复核观测面）——
        // 单次采集超出常规页 p95 目标（1.5s）时告警（含载荷分解），为
        // 「12s 硬超时（管理器兜底）→ 5s 硬预算 → p95 2s → 采集 p95 1.5s」
        // 分层中补上采集层自身的观测点；不中止采集（硬超时由管理器负责）。
        let collect_ms = started.elapsed().as_millis() as u64;
        if collect_ms > COLLECT_P95_TARGET.as_millis() as u64 {
            tracing::warn!(
                "快照采集超常规耗时预算：{collect_ms}ms > 目标 {}ms（载荷 {payload_bytes}B，结构通道{}）",
                COLLECT_P95_TARGET.as_millis(),
                if dom_degraded { "降级丢弃" } else { "保留" }
            );
        }

        Ok(CollectedData {
            roots,
            url,
            title,
            layout,
            raw_payload_bytes: payload_bytes,
            collect_ms,
            cross_origin,
        })
    }
}

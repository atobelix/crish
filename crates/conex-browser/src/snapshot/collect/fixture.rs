//! 构造输入采集器（测试/引擎侧确定性输入；不触网）。

use super::*;

/// 构造输入采集器（测试/引擎侧确定性输入；不触网）。
pub struct FixtureCollector {
    roots: Vec<EnhancedNode>,
    url: String,
    title: String,
    payload_bytes: usize,
    /// 模拟挂起（时间预算测试用；Some(secs) = 挂起指定时长后返回）
    hang: Option<std::time::Duration>,
}

impl FixtureCollector {
    pub fn new(roots: Vec<EnhancedNode>) -> Self {
        FixtureCollector {
            roots,
            url: "https://example.com".to_string(),
            title: String::new(),
            payload_bytes: 0,
            hang: None,
        }
    }

    /// 构造输入 + 元数据（url/title/载荷估算）。
    pub fn with_meta(
        roots: Vec<EnhancedNode>,
        url: &str,
        title: &str,
        payload_bytes: usize,
    ) -> Self {
        FixtureCollector {
            roots,
            url: url.to_string(),
            title: title.to_string(),
            payload_bytes,
            hang: None,
        }
    }

    /// 注入挂起（时间预算测试：12s 硬超时断言用）。
    pub fn hang_for(mut self, d: std::time::Duration) -> Self {
        self.hang = Some(d);
        self
    }
}

#[async_trait]
impl SnapshotCollector for FixtureCollector {
    async fn collect(&self, _tab_id: &str, _session: &str) -> Result<CollectedData, SnapshotError> {
        if let Some(d) = self.hang {
            tokio::time::sleep(d).await;
        }
        Ok(CollectedData {
            roots: self.roots.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            layout: LayoutMetrics::default(),
            raw_payload_bytes: self.payload_bytes,
            collect_ms: 0,
            cross_origin: CrossOriginStats::default(),
        })
    }
}

use serde::{Deserialize, Serialize};

// ── 会话操作域（G3 增补 C40-C43；归 F5 会话域——作用于桌面宿主的
// 会话存储（conex-db sessions 表），与桌面侧栏改名 / 置顶 / 归档 /
// 删除同一存储层、同一语义，不另建移动端专用会话表；四条结果统一
// OkResult（契约类型名 GenericOkResult），操作后移动端以 listSessions
// 回读对账为准，不做无回滚的乐观更新）──

/// C40 参数（会话改名：标题在宿主侧按桌面
/// `normalizeWritableSessionTitle` 同口径规范化后落库——清洗后为空
/// → cmd.invalid 拒绝，不落库；会话不存在 → cmd.not_found）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionParams {
    /// 目标会话 id
    pub session_id: String,
    /// 新标题（原始输入；规范化在宿主侧完成，与桌面改名同口径）
    pub title: String,
}

/// C41 参数（置顶 / 取消置顶：sessions.is_pinned 定向写，天然幂等——
/// 设为当前值同样成功，与桌面置顶语义一致）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionPinnedParams {
    /// 目标会话 id
    pub session_id: String,
    /// true = 置顶；false = 取消置顶
    pub pinned: bool,
}

/// C42 参数（归档 / 取消归档：sessions.is_archived 定向写，天然幂等；
/// 取消归档与桌面「已归档」列表的恢复操作同向同义）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionArchivedParams {
    /// 目标会话 id
    pub session_id: String,
    /// true = 归档；false = 取消归档
    pub archived: bool,
}

/// C43 参数（删除会话：真删——会话行 + 消息级联 + session_meta 前缀
/// 键同事务清理，会话产出目录进回收站，与桌面生产删除路径
/// （cleanup_orphan_sessions 链）同结果；守卫与桌面孤儿清理豁免
/// 同源：存在非终态 run / 未决输入 → cmd.session_busy，引擎水合
/// 子代理会话 → cmd.denied，会话不存在 → cmd.not_found；显式单删
/// 不套孤儿清理的宽限期——那是 keepIds 对账防误删机制）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionParams {
    /// 目标会话 id
    pub session_id: String,
}

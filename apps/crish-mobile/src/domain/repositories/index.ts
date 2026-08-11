// 数据访问层占位（Z0 R2-04 outbox / R2-06 repositories 落点）
// 纪律（M5 §1.2）：repository 负责「网络优先 + 缓存回退 + 离线入队」，
// 事件链「解析 → 先落 SQLite → 再推 store」；store 不感知网络细节
export {};

// 移动端通知层共享类型（R3-04）：PushMessage schema v1 子集（D7 §6.2）+ 深链 target（M8 §4.1.2）
// - WS 直推形态 = 完整 PushMessage（桌面 push-core 原样下发，D7 §6.2 全字段）；
// - 厂商通道/系统通知形态 = data 白名单扁平字段（D7 §6.3；去重前提：data 必含
//   dedupeKey + eventType，见 §6.4-2 展示层去重），由 normalizeSystemNotification 归一；
// - 目标形态（protocol-core 生成产物）未就绪前本地定义，D8 §3.4 落地后切换 re-export。

/** 推送级别（D7 §3.1 四级裁剪：P0 critical / P1 important / P2 normal，P3 不推不发） */
export type PushSeverity = 'critical' | 'important' | 'normal';

/** 推送目标（D7 §7.4 跳转映射表；screen 对齐 M8 §4.1.3 枚举面） */
export interface PushTarget {
  /** 目标屏（approval / session / run / terminal / ...；白名单校验在 notificationMeta） */
  screen: string;
  /** 归属会话 id（无则 null） */
  sessionId: string | null;
  /** 定位参数（toolCallId / runId / taskId / subagentId / timerId / cronId 等） */
  params: Record<string, string>;
}

/** 跨平台推送消息（D7 §6.2 schema v1 子集；id 全局递增，seq 每设备单调） */
export interface PushMessage {
  schemaVersion: number;
  /** 推送 id（全局唯一；桌面 push-core 生成） */
  id: string;
  /** 事件类型（approval-requested / run-terminal / task-failed / ...） */
  eventType: string;
  /** 事件序列（每设备单调；乱序/重放判定用，D7 §3.4.1） */
  seq: number;
  /** 事件时刻（毫秒） */
  tsMs: number;
  /** 推送级别（P0 critical / P1 important / P2 normal） */
  severity: PushSeverity;
  /** 分类（approval / run / task / system / ...，对齐通道归一输入） */
  category: string;
  /** 标题（必填展示字段） */
  title: string;
  /** 正文（可空） */
  body: string | null;
  /** 去重键（D7 §3.4.1：{eventType}:{业务键}；双通道去重数据面主键） */
  dedupeKey: string;
  /** 合并键（厂商通道系统级折叠：Android tag / iOS threadId，可空） */
  collapseKey: string | null;
  /** 通道 id（D7 §7.7 七渠道 → 本层归一为 Z0 四类，见 channels.ts） */
  channelId: string;
  /** 深链目标（点击跳转；参数稳定，不解析 title/body 文案，D7 §7.4 契约） */
  target: PushTarget;
}

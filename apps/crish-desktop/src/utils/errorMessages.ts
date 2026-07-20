/**
 * 统一错误/提示消息常量
 *
 * 迁移指南：
 *
 * 1. 引入常量：
 *    import { ERROR_MESSAGES as E } from '../../utils/errorMessages';
 *
 * 2. 替换硬编码文案（按类别查找替换）：
 *
 *    ────────── 持久化 ──────────
 *    '存储空间已满...'           → E.STORAGE_QUOTA_EXCEEDED
 *    '存储空间即将用尽...'       → E.STORAGE_QUOTA_WARNING (replace {percent})
 *    '数据保存失败...'           → E.SAVE_FAILED
 *    '当前输入内容尚未保存...'   → E.DRAFT_LOST
 *
 *    ────────── 网络/连接 ──────────
 *    '与引擎的连接已断开...'     → E.ENGINE_DISCONNECTED
 *    '正在重新连接...'           → E.ENGINE_RECONNECTING
 *    '连接超时...'               → E.ENGINE_TIMEOUT
 *    '消息发送失败...'           → E.MESSAGE_SEND_FAILED
 *    '网络错误...'               → E.NETWORK_ERROR
 *    '引擎未连接...'             → E.ENGINE_DISCONNECTED
 *    '引擎未同步...'             → use formatEngineDegradeToast from useToastQueue
 *
 *    ────────── 审批 ──────────
 *    '审批请求未在 5 分钟内...'  → E.APPROVAL_TIMEOUT
 *    '审批失败：...'             → E.APPROVAL_FAILED (replace {reason})
 *    '...执行失败：...'          → E.TOOL_EXECUTION_FAILED (replace {toolName}, {reason})
 *
 *    ────────── 文件 ──────────
 *    '文件已被外部修改...'       → E.FILE_CONFLICT
 *    '文件保存失败：...'         → E.FILE_SAVE_FAILED (replace {reason})
 *    '文件过大...'               → E.FILE_TOO_LARGE
 *
 *    ────────── 通用 ──────────
 *    '未知错误'/'发生未知错误'   → E.UNKNOWN_ERROR
 *    '操作成功'/'保存成功'       → E.OPERATION_SUCCESS（注意 toast 策略可能静默）
 *    '已取消'                    → E.OPERATION_CANCELLED
 *    '重试'                      → E.RETRY
 *    '取消'                      → E.CANCEL
 *    '确认'                      → E.CONFIRM
 *    '关闭'                      → E.CLOSE
 *    '复制失败'                  → E.COPY_FAILED（见下方扩展）
 *
 * 3. 带参数的文案替换：
 *    示例：E.STORAGE_QUOTA_WARNING.replace('{percent}', '85')
 *
 * 4. 若需新增消息，先在此文件定义再引用，避免散落硬编码。
 */

export const ERROR_MESSAGES = {
  // ── 持久化 ──────────────────────────────────────────────
  STORAGE_QUOTA_EXCEEDED: '存储空间已满，旧消息将被自动清理以腾出空间',
  STORAGE_QUOTA_WARNING: '存储空间即将用尽（已使用 {percent}%），建议清理历史会话',
  SAVE_FAILED: '数据保存失败，请检查存储空间后重试',
  DRAFT_LOST: '当前输入内容尚未保存，退出前请确认',

  // ── 网络/连接 ────────────────────────────────────────────
  ENGINE_DISCONNECTED: '与引擎的连接已断开，系统将在网络恢复后自动重连',
  ENGINE_RECONNECTING: '正在重新连接...',
  ENGINE_TIMEOUT: '连接超时，请检查引擎状态后重试',
  MESSAGE_SEND_FAILED: '消息发送失败，点击重试',
  NETWORK_ERROR: '网络错误，请检查连接后重试',

  // ── 审批 ─────────────────────────────────────────────────
  APPROVAL_TIMEOUT: '审批请求未在 5 分钟内完成，已自动取消',
  APPROVAL_FAILED: '审批失败：{reason}',
  TOOL_EXECUTION_FAILED: '"{toolName}" 执行失败：{reason}',

  // ── 文件 ─────────────────────────────────────────────────
  FILE_CONFLICT: '文件已被外部修改，是否覆盖？',
  FILE_SAVE_FAILED: '文件保存失败：{reason}',
  FILE_TOO_LARGE: '文件过大，无法预览（超过 512KB）',

  // ── 通用 ─────────────────────────────────────────────────
  UNKNOWN_ERROR: '发生未知错误，请重试',
  OPERATION_SUCCESS: '操作成功',
  OPERATION_CANCELLED: '已取消',
  RETRY: '重试',
  CANCEL: '取消',
  CONFIRM: '确认',
  CLOSE: '关闭',
} as const;

export type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

/**
 * 替换模板占位符 {key} 为 values[key]。
 * 示例：tpl(E.APPROVAL_FAILED, { reason: '用户取消' })
 */
export function tpl(template: string, values: Record<string, string | number>): string {
  let result = template;
  for (const [key, val] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
  }
  return result;
}

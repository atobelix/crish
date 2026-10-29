export const action: Record<string, string> = {
  'common.report_bug': '请尝试重试或上报该问题。',
  'provider.check_network': '服务暂时不可用，请稍后重试。',
  'provider.check_key': '请在“设置”中检查 API 密钥。',
  'provider.retry': '请重试。',
  'tool.aborted_before_dispatch': '请求已被用户或控制总线中止，无需重试。',
  'tool.cancelled': '兄弟工具执行失败或批处理取消，跳过执行。',
  'tool.outcome_unknown': '系统冷启动恢复自动合成未闭合调用，继续会话。',
};

export default action;

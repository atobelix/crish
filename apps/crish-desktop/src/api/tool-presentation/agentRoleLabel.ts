/**
 * 子 agent 角色 wire 名 → 角色名呈现解析（R4b 呈现层口径）。
 *
 * 背景：R4a 把引擎 `SubagentStarted.role`（SubagentRole wire 名）原样落入
 * `SessionAgent.displayLabel` —— 数据层刻意无损（DB 的 display_label 是 spawn
 * 定义的自由文本，同一字段不许两套口径），wire 名 → 角色名是**呈现层**决策，
 * 统一在本模块收口：流内分派卡 / 侧栏头部 / 团队板 / 浏览列表 / 顶栏下拉
 * 五个呈现面共用同一解析，禁止各面自备译名表。
 *
 * 文案源：i18n 字典 `chat.agentCard.role.*`（zh-CN / en-US 对称登记），经
 * 全局单例 t() 在纯函数层消费（useI18n.ts 的全局翻译 helper 即为此设）；
 * 本模块不持有任何硬编码文案（check-i18n-hardcoded 门禁）。
 *
 * 规则：
 * - 仅对引擎五种 role wire 名做**精确匹配**（trim 后全等）；
 * - 自由文本 displayLabel（如「Rust 内核分析师」）与未知 wire 名一律原样返回，
 *   不猜测、不截断 —— 新角色上线时在字典加键并在本 switch 登记一行。
 */
import { t } from '../../i18n';

/** 引擎 SubagentRole wire 名集合（呈现映射的适用域） */
const SUBAGENT_ROLE_WIRE_NAMES: ReadonlySet<string> = new Set([
  'researcher',
  'implementer',
  'reviewer',
  'debugger',
  'planner',
]);

/** 是否为引擎 role wire 名（trim 后精确命中） */
export function isSubagentRoleWireName(
  label: string | null | undefined
): boolean {
  if (!label) return false;
  return SUBAGENT_ROLE_WIRE_NAMES.has(label.trim());
}

/**
 * 呈现层角色名解析：wire 名 → 字典角色名（随当前语言）；其余（自由文本 /
 * 未知 wire 名 / 空值）原样返回（空值返回空串）。数据层字段不经本函数回写。
 */
export function mapSubagentRoleWireName(
  label: string | null | undefined
): string {
  if (!label) return '';
  const wire = label.trim();
  if (!wire) return '';
  switch (wire) {
    case 'researcher':
      return t('chat.agentCard.role.researcher');
    case 'implementer':
      return t('chat.agentCard.role.implementer');
    case 'reviewer':
      return t('chat.agentCard.role.reviewer');
    case 'debugger':
      return t('chat.agentCard.role.debugger');
    case 'planner':
      return t('chat.agentCard.role.planner');
    default:
      return wire;
  }
}

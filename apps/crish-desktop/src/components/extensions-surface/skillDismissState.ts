/**
 * 技能卸载标记门面。
 * 底层持久化逻辑收敛至 api/skillDismissState，满足组件层禁直接写 localStorage 门禁。
 */

export * from '../../api/skillDismissState';

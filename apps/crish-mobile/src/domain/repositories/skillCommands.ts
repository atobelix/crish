// F6 技能域命令构造与响应解析（G7 数据层纯逻辑）
//
// 对齐依据：
// - 字段真源：crates/conex-device-protocol/contracts/device-protocol.json
//   （C44 listSkills；commands 段 name/kind/paramsType/resultType +
//   types 段 SkillEntry 字段表）；
// - 真源口径：本命令读宿主技能发现（workbench_discover_skills）——
//   与桌面「设置 → 扩展 → 技能」页同一发现函数、同一技能目录
//   （活动工作区 + 主目录全局），本文件不引入任何手机本地技能状态；
// - 只读边界：技能启停（activation）的生效值是桌面 webview 本地
//   状态（localStorage），宿主侧没有可远程读写的数据面，故命令面
//   只有列表、无启停命令；SkillEntry.fileActivation 仅为技能文件
//   frontmatter 声明的缺省，不是用户生效状态，UI 不得据此呈现
//   「已启用/已停用」；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params,
//   timeoutMs?}，kind 与 body.command 后缀必须一致（生成解析器校验）；
// - 响应解析：复用生成解析器（parseListSkillsResult）——不手写第二套
//   字段校验（M5 §1.3 组合纪律）。

import type { ListSkillsResult, CommandRequest } from '@crish/shared-types';
import { parseListSkillsResult as parseWireListSkillsResult } from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F6 技能域命令名（C44，G7 增补；本域仅此一条只读命令） */
export type SkillCommandName = 'listSkills';

/** F6 技能域命令 kind（协议层消息类别） */
export type SkillCommandKind = 'remote.listSkills';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.） */
export const SKILL_COMMAND_KIND: Record<SkillCommandName, SkillCommandKind> = {
  listSkills: 'remote.listSkills',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface SkillCommandRequest {
  kind: SkillCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────

/** C44 技能目录列表：参数恒空对象 */
export function buildListSkillsRequest(): SkillCommandRequest {
  return {
    kind: 'remote.listSkills',
    body: { command: 'listSkills', params: {} },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F6 技能域命令响应载荷（生成 resultType） */
export type SkillCommandResultPayload = ListSkillsResult;

/** 命令名 → 响应载荷类型映射（生成 resultType） */
export interface SkillCommandResultMap {
  listSkills: ListSkillsResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷；
 * WsGateway.invoke 已解信封，此处校验 result 内容）。
 */
export function parseSkillCommandResult<T extends SkillCommandName>(
  command: T,
  raw: unknown
): ParseResult<SkillCommandResultMap[T]> {
  const result = parseAnySkillCommandResult(command, raw);
  return result as ParseResult<SkillCommandResultMap[T]>;
}

function parseAnySkillCommandResult(
  command: SkillCommandName,
  raw: unknown
): ParseResult<SkillCommandResultPayload> {
  switch (command) {
    case 'listSkills':
      return parseWireListSkillsResult(raw);
  }
}

// ── 作用域呈现（与桌面设置技能页 scopeGroupLabel 同文案）──────────────────

/**
 * 技能作用域分组标签（宿主发现原样值 → 呈现文案，与桌面
 * scopeGroupLabel 同口径）：project = 当前项目、workspace = 工作区、
 * global = 全局；未知作用域原样回传（不编造归类）。
 */
export function skillScopeLabel(scope: string): string {
  switch (scope) {
    case 'project':
      return '当前项目';
    case 'workspace':
      return '工作区';
    case 'global':
      return '全局';
    default:
      return scope;
  }
}

/** 作用域分组排序键（与宿主投影/桌面列表同序：project → workspace → 其余） */
export function skillScopeOrder(scope: string): number {
  switch (scope) {
    case 'project':
      return 0;
    case 'workspace':
      return 1;
    default:
      return 2;
  }
}

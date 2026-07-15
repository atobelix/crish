/**
 * 命令分类：统一委托 @crish/decision-engine，避免双份 SAFE_READ 漂移。
 */

import {
  classifyCommand,
  DEFAULT_HARDLINE_REGISTRY,
  type CommandClassification as EngineClassification,
  type CommandRisk as EngineRisk,
} from "@crish/decision-engine";

export type CommandRisk = EngineRisk | "hardline";

export interface CommandClassification {
  risk: CommandRisk;
  reason: string;
  matched?: string;
}

/** 极危：走 decision-engine Hardline 注册表 */
export function getHardlineCommandBlock(command: string | undefined): CommandClassification | undefined {
  if (!command) return undefined;
  const hit = DEFAULT_HARDLINE_REGISTRY.isHardline(command.trim());
  if (!hit) return undefined;
  return { risk: "hardline", reason: hit.reason, matched: hit.pattern.source };
}

/** shell isReadOnly 入口：risk === "read" 才视为只读放行 */
export function classifyTerminalCommand(command: string): CommandClassification {
  const result: EngineClassification = classifyCommand(command);
  return {
    risk: result.risk,
    reason: result.reason,
    ...(result.matched !== undefined ? { matched: result.matched } : {}),
  };
}

// 技能域命令仓库（G7 接线层）：WsGateway.invoke → skillCommands 构造/解析
//
// 职责（对齐 M5 §1.2 repository 组合纪律：仓库 = 命令构造 + 网络发送 + 响应解析）：
// - 命令发送唯一入口：listSkills 一条（C44）——读宿主技能发现的实时
//   投影（与桌面「设置 → 扩展 → 技能」页同一真源），仓库不缓存、
//   不落本地状态：每次 listSkills 都是桌面技能目录的实时投影；
// - 只读边界：技能启停生效值在桌面 webview 本地（localStorage），
//   宿主无数据面——本仓库刻意没有启停方法，不伪造写面；
// - 响应解析复用 skillCommands.parseSkillCommandResult（生成面解析器）；
// - 错误归一化：invokeCommand 统一执行链（gatewayCommand.ts）——GatewayError
//   透传 code/retryable → SkillsCommandError；解析失败/未知异常 → internal；
// - 注入模式：网关来源构造注入（GatewaySource）——实例 = 测试 mock / 同代
//   直注；解析函数 = 生产命令域（skillsWiring 传 resolveCommandGateway，每次
//   invoke 现取当代网关，H1 陈旧捕获根治，见 gatewayCommand 文件头口径）。

import { invokeCommand, type GatewaySource } from './gatewayCommand';
import {
  buildListSkillsRequest,
  parseSkillCommandResult,
} from '@/domain/repositories/skillCommands';
import type {
  SkillCommandName,
  SkillCommandRequest,
  SkillCommandResultMap,
} from '@/domain/repositories/skillCommands';
import type { ListSkillsResult } from '@crish/shared-types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 技能域命令错误（code = 协议错误码 / 本地映射码，UI 层映射文案） */
export class SkillsCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'SkillsCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const SKILLS_ERROR_INTERNAL = 'internal';

// ── 仓库接口（注入 mock 面；VM/接线层只依赖接口不依赖实现） ────────────────

export interface SkillsRepository {
  /** C44 技能目录列表（宿主技能发现实时投影，只读） */
  listSkills(): Promise<ListSkillsResult>;
}

// ── 网关实现 ──────────────────────────────────────────────────────────────

/** 经 WsGateway.invoke 发送 F6 技能命令并解析响应（注入网关来源，测试可注入假网关） */
export class GatewaySkillsRepository implements SkillsRepository {
  constructor(private readonly gatewaySource: GatewaySource) {}

  listSkills(): Promise<ListSkillsResult> {
    return this.invoke('listSkills', buildListSkillsRequest());
  }

  /** 统一执行链转发（invokeCommand，gatewayCommand.ts；错误归一化为域错误类） */
  private invoke<T extends SkillCommandName>(
    command: T,
    req: SkillCommandRequest
  ): Promise<SkillCommandResultMap[T]> {
    return invokeCommand(
      this.gatewaySource,
      req,
      command,
      (raw) => parseSkillCommandResult(command, raw),
      (code, message, retryable) =>
        new SkillsCommandError(code, message, retryable)
    );
  }
}

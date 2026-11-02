// @vitest-environment jsdom
/**
 * ApprovalAskCard · R7 申请人标注渲染测试。
 *
 * 覆盖口径：
 * - requester 存在（子 agent 发起）→ 头行区出现「[身份标] 由子 agent「标题」请求」
 *   + 申请理由上下文一行；arbiter='main-agent' 时以次级信息附带「经主 agent 裁决」；
 * - 身份标按 subagentId 走 agentIdentity（与分派卡同源）——解析不到
 *   subagentId 时只有文案、没有身份标，绝不按 runId 误挂；
 * - requester 缺省（主 agent 发起）→ 无任何标注，与既有呈现一致；
 * - 申请理由与 riskReason 同文时不重复展示（parse 层 reason→riskReason 兜底串扰的收口）。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApprovalAskCard } from './ApprovalAskCard';
import type { MessageToolApprovalMeta } from '../../store/types';
import type { ApprovalRiskMeta } from '../../api/approvalMeta';
import {
  AGENT_GLYPHS,
  agentIdentity,
} from '../../api/tool-presentation/agentIdentity';

type Props = React.ComponentProps<typeof ApprovalAskCard>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    msgId: 'm1',
    toolId: 'tc-1',
    summary: '是否允许执行 npm test？',
    cmd: 'npm test',
    onAllow: vi.fn(),
    onDeny: vi.fn(),
    ...overrides,
  };
}

function renderCard(overrides: Partial<Props> = {}) {
  const props = makeProps(overrides);
  const utils = render(<ApprovalAskCard {...props} />);
  return { props, ...utils };
}

afterEach(() => {
  cleanup();
});

describe('ApprovalAskCard · R7 申请人标注', () => {
  it('子 agent 发起 + 主 agent 裁决：身份标 + 标题 + arbiter 次级信息 + 理由行齐全', () => {
    const riskMeta: MessageToolApprovalMeta = {
      riskLevel: 'medium',
      source: 'backend',
      requester: {
        runId: 'run-sub-1',
        subagentId: 'agent-1',
        label: '检索代码',
        reason: '需要运行测试套件验证改动',
      },
      arbiter: 'main-agent',
    };
    const { container } = renderCard({ riskMeta });
    const row = screen.getByTestId('approval-requester');
    expect(row).not.toBeNull();
    expect(row.getAttribute('data-requester-agent')).toBe('agent-1');
    expect(row.textContent).toContain('由子 agent「检索代码」请求');
    expect(row.textContent).toContain('经主 agent 裁决');
    // 身份标与 agentIdentity 同源：字形与色值变量都对得上
    const identity = agentIdentity('agent-1');
    expect(AGENT_GLYPHS).toContain(identity.glyph);
    expect(row.textContent).toContain(identity.glyph);
    const glyphSpan = row.querySelector('span[aria-hidden]');
    expect(glyphSpan).not.toBeNull();
    expect(glyphSpan?.textContent).toBe(identity.glyph);
    // 申请理由作上下文一行展示
    expect(
      container.querySelector('[data-requester-reason]')?.textContent
    ).toBe('需要运行测试套件验证改动');
  });

  it('解析不到 subagentId（只有 runId）：只有通用文案，无身份标、无 arbiter 后缀', () => {
    const riskMeta: ApprovalRiskMeta = {
      riskLevel: 'unknown',
      requiresDoubleConfirm: false,
      recommendSnapshot: false,
      source: 'backend',
      requester: { runId: 'run-sub-9' },
    };
    const { container } = renderCard({ riskMeta });
    const row = screen.getByTestId('approval-requester');
    expect(row.getAttribute('data-requester-agent')).toBe('run-sub-9');
    expect(row.textContent).toContain('由子 agent 请求');
    expect(row.textContent).not.toContain('经主 agent 裁决');
    expect(row.querySelector('span[aria-hidden]')).toBeNull();
    expect(container.querySelector('[data-requester-reason]')).toBeNull();
  });

  it('arbiter=user（用户裁决）：不附带裁决来源次级信息', () => {
    const riskMeta: MessageToolApprovalMeta = {
      requester: {
        runId: 'run-sub-1',
        subagentId: 'agent-1',
        label: '检索代码',
      },
      arbiter: 'user',
    };
    renderCard({ riskMeta });
    const row = screen.getByTestId('approval-requester');
    expect(row.textContent).toContain('由子 agent「检索代码」请求');
    expect(row.textContent).not.toContain('经主 agent 裁决');
  });

  it('主 agent 发起（无 requester）：无标注行', () => {
    const riskMeta: MessageToolApprovalMeta = {
      trustZone: 'T1',
      riskLevel: 'medium',
      source: 'backend',
    };
    renderCard({ riskMeta });
    expect(screen.queryByTestId('approval-requester')).toBeNull();
  });

  it('申请理由与 riskReason 同文：不重复出理由行（riskReason 既有展示承担）', () => {
    const riskMeta: MessageToolApprovalMeta = {
      riskLevel: 'medium',
      source: 'backend',
      riskReason: '需要运行测试套件验证改动',
      requester: {
        runId: 'run-sub-1',
        subagentId: 'agent-1',
        label: '检索代码',
        reason: '需要运行测试套件验证改动',
      },
    };
    const { container } = renderCard({ riskMeta });
    expect(screen.getByTestId('approval-requester')).not.toBeNull();
    expect(container.querySelector('[data-requester-reason]')).toBeNull();
  });
});

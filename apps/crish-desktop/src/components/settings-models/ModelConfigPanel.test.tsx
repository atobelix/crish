// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelConfigPanel } from './ModelConfigPanel';
import type { CfgDraft } from './useModelProfilesState';

const dummyMeta = {
  profileId: 'p1',
  model: 'deepseek-v4-pro',
  enabled: true,
  displayName: 'DeepSeek V4 Pro',
};

function PanelWrapper({
  initialThinkingEnabled = false,
  modelId = 'deepseek-v4-pro',
}: {
  initialThinkingEnabled?: boolean;
  modelId?: string;
}) {
  const [cfgDraft, setCfgDraft] = useState<CfgDraft | null>({
    displayName: 'DeepSeek V4 Pro',
    contextLength: '128000',
    maxOutputTokens: '4096',
    caps: {
      tools: true,
      image: true,
      video: false,
      reasoning: initialThinkingEnabled,
    },
    thinkingLevel: 'default',
    thinkingEnabled: initialThinkingEnabled,
    thinkingMap: initialThinkingEnabled
      ? {
          Off: 'off',
          Low: 'low',
          Medium: 'medium',
          High: 'high',
          Max: 'max',
        }
      : undefined,
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    pricing: {
      currency: 'USD',
      input: '',
      output: '',
      cacheRead: '',
      cacheWrite: '',
    },
  });

  return (
    <ModelConfigPanel
      modelId={modelId}
      cfgDraft={cfgDraft!}
      setCfgDraft={setCfgDraft as any}
      meta={dummyMeta as any}
      tKey="deepseek-v4-pro"
      testBusy={null}
      runTest={vi.fn()}
      closeConfig={vi.fn()}
      saveConfig={vi.fn()}
    />
  );
}

describe('ModelConfigPanel (人体工学瘦身与协议彻底剔除)', () => {
  it('【最高指令 1】单模型抽屉 100% 物理移除协议下拉控件', () => {
    const { container } = render(<PanelWrapper initialThinkingEnabled={false} />);

    // 确保没有出现协议相关的文字或选择器
    expect(screen.queryByText(/调用协议/)).not.toBeInTheDocument();
    expect(screen.queryByText(/openai\/chat/)).not.toBeInTheDocument();
    expect(screen.queryByText(/跟随服务商默认协议/)).not.toBeInTheDocument();
    expect(container.querySelector('[name="protocol"]')).toBeNull();
  });

  it('【最高指令 2】非思考模型彻底隐藏思考配置项', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    // 当 thinkingEnabled 为 false 时，思考配置区域彻底隐藏
    expect(screen.queryByText(/思考推理 \(Thinking \/ Reasoning\)/)).not.toBeInTheDocument();
    expect(screen.queryByText('UI 显示名 (TitleCase)')).not.toBeInTheDocument();
  });

  it('【最高指令 2】思考模型正常渲染纯英文 TitleCase 拍平映射表', () => {
    render(<PanelWrapper initialThinkingEnabled={true} />);

    // 思考模型渲染思考配置区域
    expect(screen.getByText(/思考推理 \(Thinking \/ Reasoning\)/)).toBeInTheDocument();
    expect(screen.getByText('UI 显示名 (TitleCase)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Off')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max')).toBeInTheDocument();
  });

  it('在能力开关处开启「推理」：动态呼出思考强度配置区域', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    expect(screen.queryByText(/思考推理 \(Thinking \/ Reasoning\)/)).not.toBeInTheDocument();

    // 找到「推理」开关并点击
    const reasoningSwitch = screen.getByRole('switch', { name: /推理/ });
    fireEvent.click(reasoningSwitch);

    // 思考区域应立即渲染出现
    expect(screen.getByText(/思考推理 \(Thinking \/ Reasoning\)/)).toBeInTheDocument();
    expect(screen.getByText('UI 显示名 (TitleCase)')).toBeInTheDocument();
  });

  it('多模态矩阵与四维选填价格正常渲染在首屏', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    expect(screen.getByText(/多模态支持 \(Modalities\)/)).toBeInTheDocument();
    expect(screen.getByText(/四维计费 \(选填 · 留空优雅静默\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });
});

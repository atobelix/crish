// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelConfigPanel } from './ModelConfigPanel';
import type { CfgDraft } from './useModelProfilesState';

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

  it('未声明思考的模型仍可补上思考档位', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    expect(screen.getByText('思考推理')).toBeInTheDocument();
    expect(screen.queryByText('界面档位名称')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置思考档位' }));

    expect(screen.getByText('界面档位名称')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭思考' })).toBeInTheDocument();
  });

  it('已声明思考的模型直接展示档位表，并且可以关闭', () => {
    render(<PanelWrapper initialThinkingEnabled={true} />);

    expect(screen.getByText('思考推理')).toBeInTheDocument();
    expect(screen.getByText('界面档位名称')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Off')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭思考' }));
    expect(screen.queryByText('界面档位名称')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置思考档位' })).toBeInTheDocument();
  });

  it('能力矩阵统一（用户裁决 #2/#3）：无独立「推理」开关；四维计费不再渲染在抽屉', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    // 推理由思考编辑器承载，不再有独立的 capabilities 推理开关
    expect(screen.queryByRole('switch', { name: /推理/ })).not.toBeInTheDocument();
    // 四维计费移出抽屉（在用量配置单价里配置）
    expect(screen.queryByText(/四维计费/)).not.toBeInTheDocument();
    expect(screen.queryByText(/缓存读取/)).not.toBeInTheDocument();
    // 模态矩阵仍在（能力真源 = modalities）
    expect(screen.getByText(/多模态支持/)).toBeInTheDocument();
  });

  it('多模态矩阵正常渲染在首屏（能力矩阵统一后）', () => {
    render(<PanelWrapper initialThinkingEnabled={false} />);

    expect(screen.getByText(/多模态支持/)).toBeInTheDocument();
    // 计费区域已移除（用量页配置），首屏更干净
    expect(screen.queryByText(/四维计费/)).not.toBeInTheDocument();
  });

});

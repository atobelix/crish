// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ModelThinkingEditor,
  STANDARD_THINKING_PRESET,
} from './ModelThinkingEditor';

describe('ModelThinkingEditor (思考档位纯英文 TitleCase 与拍平映射)', () => {
  it('渲染纯英文 TitleCase 显示名与 Wire 参数值映射表', () => {
    const thinkingMap = {
      Off: 'off',
      Low: 'low',
      Medium: 'medium',
      High: 'high',
      Max: 'max',
    };
    render(
      <ModelThinkingEditor
        enabled={true}
        onEnabledChange={vi.fn()}
        thinkingMap={thinkingMap}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('思考推理')).toBeInTheDocument();
    expect(screen.getByText('界面档位名称')).toBeInTheDocument();
    expect(screen.getByText('API参数值')).toBeInTheDocument();

    expect(screen.getByDisplayValue('Off')).toBeInTheDocument();
    expect(screen.getByDisplayValue('off')).toBeInTheDocument();
    expect(screen.getByDisplayValue('High')).toBeInTheDocument();
    expect(screen.getByDisplayValue('high')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max')).toBeInTheDocument();
    expect(screen.getByDisplayValue('max')).toBeInTheDocument();
  });

  it('编辑显示名或 Wire 值：触发 onChange 更新对应字典映射', () => {
    const onChange = vi.fn();
    const thinkingMap = {
      Low: 'low',
    };
    render(
      <ModelThinkingEditor
        enabled={true}
        onEnabledChange={vi.fn()}
        thinkingMap={thinkingMap}
        onChange={onChange}
      />
    );

    // 修改 Wire 参数值
    const wireInput = screen.getByDisplayValue('low');
    fireEvent.change(wireInput, { target: { value: 'low-budget' } });
    expect(onChange).toHaveBeenCalledWith({
      Low: 'low-budget',
    });

    // 修改 UI 显示名
    const labelInput = screen.getByDisplayValue('Low');
    fireEvent.change(labelInput, { target: { value: 'Light' } });
    expect(onChange).toHaveBeenCalledWith({
      Light: 'low',
    });
  });

  it('点击删除档位按钮：从映射表中移除对应档位', () => {
    const onChange = vi.fn();
    const thinkingMap = {
      Low: 'low',
      High: 'high',
    };
    render(
      <ModelThinkingEditor
        enabled={true}
        onEnabledChange={vi.fn()}
        thinkingMap={thinkingMap}
        onChange={onChange}
      />
    );

    const deleteBtns = screen.getAllByRole('button', { name: '删除档位' });
    fireEvent.click(deleteBtns[0]);

    expect(onChange).toHaveBeenCalledWith({
      High: 'high',
    });
  });

  it('点击添加档位与重置推荐档位：行为正确', () => {
    const onChange = vi.fn();
    render(
      <ModelThinkingEditor
        enabled={true}
        onEnabledChange={vi.fn()}
        thinkingMap={{ Custom: 'custom' }}
        onChange={onChange}
      />
    );

    // 点击添加档位
    fireEvent.click(screen.getByRole('button', { name: '添加档位' }));
    expect(onChange).toHaveBeenCalledWith({
      Custom: 'custom',
      Custom1: 'custom1',
    });

    // 点击重置推荐档位
    fireEvent.click(screen.getByRole('button', { name: '重置推荐档位' }));
    expect(onChange).toHaveBeenCalledWith({ ...STANDARD_THINKING_PRESET });
  });

  it('不再渲染内嵌总开关：思考启闭由外层统一控制', () => {
    render(
      <ModelThinkingEditor
        enabled={true}
        thinkingMap={{ Low: 'low' }}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByRole('switch')).toBeNull();
  });
});

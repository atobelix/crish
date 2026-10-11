// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ManualAddForm } from './ManualAddForm';
import { emptyAddDraft, type AddModelDraft } from './modelsIpcHelpers';
import { addDraftToModelInput } from './catalogWriteGate';

function ManualAddWrapper({
  runScan = vi.fn().mockResolvedValue(undefined),
  scanBusy = false,
  scannedModels = ['online-gpt-5', 'online-claude-3-5-sonnet'],
  existingModels = ['custom-existing-model'],
  providerVendor = 'openai',
}: {
  runScan?: () => Promise<void>;
  scanBusy?: boolean;
  scannedModels?: string[];
  existingModels?: string[];
  providerVendor?: string;
}) {
  const [draft, setDraft] = useState<AddModelDraft>(emptyAddDraft());

  return (
    <ManualAddForm
      addDraft={draft}
      setAddDraft={setDraft}
      handleManualAdd={vi.fn()}
      setManualOpen={vi.fn()}
      runScan={runScan}
      scanBusy={scanBusy}
      providerVendor={providerVendor}
      scannedModels={scannedModels}
      existingModels={existingModels}
    />
  );
}

/**
 * 真实链路捕获器：把表单当前草稿经价格闸门转成落树补丁，供断言。
 * 复刻 useModelProfilesState.handleManualAdd 的 `addDraftToModelInput` 调用。
 */
function CaptureWrapper({
  onCapture,
  providerVendor = 'deepseek',
  scannedModels = ['deepseek-v4-pro'],
}: {
  onCapture: (draft: AddModelDraft, patch: Record<string, unknown>) => void;
  providerVendor?: string;
  scannedModels?: string[];
}) {
  const [draft, setDraft] = useState<AddModelDraft>(emptyAddDraft());

  return (
    <ManualAddForm
      addDraft={draft}
      setAddDraft={setDraft}
      handleManualAdd={() =>
        onCapture(
          draft,
          addDraftToModelInput(draft.modelId.trim(), draft) as Record<
            string,
            unknown
          >
        )
      }
      setManualOpen={vi.fn()}
      providerVendor={providerVendor}
      scannedModels={scannedModels}
      existingModels={[]}
    />
  );
}

describe('ManualAddForm 手动新增：字典参考价不落树（用户裁决：字典只做参考）', () => {
  it('负向断言：手动输入已知模型 ID 后未编辑价格 → 落树补丁不含 pricing 键', () => {
    const captured: { draft: AddModelDraft; patch: Record<string, unknown> }[] =
      [];
    render(
      <CaptureWrapper
        onCapture={(draft, patch) => captured.push({ draft, patch })}
      />
    );

    const input = screen.getByPlaceholderText('输入或选择，如 gpt-5.6-sol');
    fireEvent.change(input, { target: { value: 'deepseek-v4-pro' } });
    // 失焦触发智能预填（含字典参考价）
    fireEvent.blur(input);

    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));

    const { draft, patch } = captured.at(-1)!;

    // 参考价确实进了草稿 —— 界面提示可用
    expect(draft.pricing).toBeDefined();
    expect(draft.pricing!.input).toBe('3');
    // 但预填绝不构成用户声明
    expect(draft.pricingExplicit).not.toBe(true);
    // 落树补丁不含 pricing —— 负向断言
    expect(Object.hasOwn(patch, 'pricing')).toBe(false);
    // 非价格预填仍落树
    expect(patch['displayName']).toBe('DeepSeek V4 Pro');
    expect(patch['contextWindow']).toBe(1048576);
  });

  it('负向断言：选定在线建议（同样触发字典预填）后补丁仍不含 pricing', () => {
    const captured: { draft: AddModelDraft; patch: Record<string, unknown> }[] =
      [];
    render(
      <CaptureWrapper
        onCapture={(draft, patch) => captured.push({ draft, patch })}
      />
    );

    const input = screen.getByPlaceholderText('输入或选择，如 gpt-5.6-sol');
    fireEvent.focus(input);
    fireEvent.click(screen.getAllByText('deepseek-v4-pro')[0]!);

    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));

    const { draft, patch } = captured.at(-1)!;
    expect(draft.pricing).toBeDefined();
    expect(Object.hasOwn(patch, 'pricing')).toBe(false);
  });
});

describe('ManualAddForm (手动添加模型与配置面板 1:1 对齐一等公民)', () => {
  it('移除右上角旧独立按钮，在模型 ID 行内联在线获取按钮', () => {
    const runScan = vi.fn().mockResolvedValue(undefined);
    render(<ManualAddWrapper runScan={runScan} />);

    // 确保没有右上角旧样式独立的大文字按钮
    expect(screen.queryByText('在线获取模型列表')).toBeNull();

    // 模型 ID 所在行内联渲染「在线获取」按钮
    const fetchBtn = screen.getByRole('button', { name: '在线获取' });
    expect(fetchBtn).toBeInTheDocument();

    fireEvent.click(fetchBtn);
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('下拉建议列表仅展示在线探测与已配置的模型，杜绝猜测兜底', () => {
    // 探测列表包含 2 个模型
    render(
      <ManualAddWrapper
        scannedModels={['deepseek-v4-pro', 'gemini-3.8-flash']}
        existingModels={[]}
      />
    );

    const input = screen.getByPlaceholderText('输入或选择，如 gpt-5.6-sol');
    fireEvent.focus(input);

    // 下拉框渲染在线模型
    expect(screen.getAllByText('deepseek-v4-pro').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gemini-3.8-flash').length).toBeGreaterThan(0);

    // 绝不渲染未经在线探测的猜测模型
    expect(screen.queryByText('gpt-4o-mini')).toBeNull();
  });

  it('模型建议框支持 ARIA combobox 语义和完整键盘选择', () => {
    render(<ManualAddWrapper />);

    const input = screen.getByRole('combobox', { name: '模型 ID *' });
    fireEvent.focus(input);

    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'End' });
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('custom-existing-model');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape 关闭建议并清除活动项', () => {
    render(<ManualAddWrapper />);

    const input = screen.getByRole('combobox', { name: '模型 ID *' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('当没有在线探测模型时，下拉建议为空，杜绝假猜', () => {
    render(<ManualAddWrapper scannedModels={[]} existingModels={[]} />);

    const input = screen.getByPlaceholderText('输入或选择，如 gpt-5.6-sol');
    fireEvent.focus(input);

    // 没有任何建议弹窗项
    expect(screen.queryByText('gpt-4o')).toBeNull();
    expect(screen.queryByText('claude-3-5-sonnet')).toBeNull();
  });

  it('表单字段与 ModelConfigPanel 1:1 结构对齐，废弃 CapEditor 并引入多模态矩阵与思考档位', () => {
    render(<ManualAddWrapper />);

    // 基础输入项
    expect(screen.getByText('展示名称')).toBeInTheDocument();
    expect(screen.getByText('上下文长度')).toBeInTheDocument();
    expect(screen.getByText('最大输出')).toBeInTheDocument();

    // 多模态矩阵（输入/输出药丸胶囊）
    expect(screen.getByText('多模态支持')).toBeInTheDocument();
    expect(screen.getByText('输入模态:')).toBeInTheDocument();
    expect(screen.getByText('输出模态:')).toBeInTheDocument();
    expect(screen.getAllByText('文档/文件').length).toBeGreaterThan(0);

    // 思考推理开启按钮
    expect(screen.getByText('思考推理')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置思考档位' })).toBeInTheDocument();

    // 底部没有旧 CapEditor 的复选框（工具/识图/视频/推理等独立 checkbox 已废弃）
    expect(screen.queryByLabelText('推理 (Thinking / Reasoning)')).toBeNull();
  });

  it('选定在线建议项或输入已知模型 ID 时，自动触发智能预填', () => {
    render(
      <ManualAddWrapper
        providerVendor="deepseek"
        scannedModels={['deepseek-v4-pro']}
      />
    );

    const input = screen.getByPlaceholderText('输入或选择，如 gpt-5.6-sol');
    fireEvent.focus(input);

    // 点击建议项
    const suggestionItem = screen.getAllByText('deepseek-v4-pro')[0]!;
    fireEvent.click(suggestionItem);

    // 自动预填官方真实上下文（1,048,576）、展示名称、最大输出（393,216）以及思考档位
    expect(screen.getByDisplayValue('DeepSeek V4 Pro')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1048576')).toBeInTheDocument();
    expect(screen.getByDisplayValue('393216')).toBeInTheDocument();

    // 思考档位自动开启，并展示拍平档位
    expect(screen.getByText('界面档位名称')).toBeInTheDocument();
    expect(screen.getByText('API参数值')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max')).toBeInTheDocument();
  });
});

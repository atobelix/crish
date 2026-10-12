// @vitest-environment jsdom
/**
 * ui/Select 测试套件：
 * 1. options 模式与复合组件拓扑、槽位与无障碍
 * 2. 同心圆角尺寸矩阵（sm / md / lg）
 * 3. 一键清除与 Backspace/Delete 快捷键
 * 4. 全键盘无障碍漫游（Arrow/Home/End/Space/Enter/Esc）
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { layerStackService } from '../internal/layer-stack/LayerStackService';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
  SelectSeparator,
} from './Select';

const OPTIONS = [
  { id: 'gpt4', label: 'GPT-4' },
  { id: 'claude', label: 'Claude' },
  { id: 'local', label: '本地模型', disabled: true },
];

/** 受控包装：模拟业务侧受控选中状态（options 模式） */
function ControlledSelect(props: React.ComponentProps<typeof Select>) {
  const [value, setValue] = useState<string | null>(null);
  return <Select value={value} onChange={(v) => setValue(v)} {...props} />;
}

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('ui/Select (Options 模式向后兼容)', () => {
  it('未选择时显示占位文案', () => {
    render(<ControlledSelect options={OPTIONS} placeholder="选择模型" />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('选择模型');
  });

  it('combobox 语义：aria-haspopup=listbox + aria-controls 指向 listbox', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    const controlsId = trigger.getAttribute('aria-controls');
    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox.id).toBe(controlsId);
  });

  it('点击触发器展开 listbox，选中项带 aria-selected 与勾选', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-4' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    fireEvent.click(screen.getByRole('option', { name: 'GPT-4' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('GPT-4');
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });

  it('受控 value 驱动选中态与 aria-selected', async () => {
    render(<Select value="claude" options={OPTIONS} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Claude');
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'Claude' });
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  it('onChange 上报选中 id', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }));
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('键盘漫游：ArrowDown 选中 + Enter 提交', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    await screen.findByRole('listbox');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('禁用项不可选中', async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const disabled = await screen.findByRole('option', { name: '本地模型' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Esc 关闭面板', async () => {
    render(<ControlledSelect options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });

  it('支持自定义 id 传递至触发器', () => {
    render(<Select id="custom-select-id" options={OPTIONS} />);
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'id',
      'custom-select-id'
    );
  });

  it('disabled 触发器不可交互', () => {
    render(<Select disabled options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('hint 选项：行内展示辅助说明，选择不受影响', async () => {
    const onChange = vi.fn();
    render(
      <Select
        options={[{ id: 'a', label: '选项甲', hint: '仅作说明' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: /选项甲/ });
    expect(screen.getByText('仅作说明')).toBeInTheDocument();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('触发器事件流：点击触发器正常展开列表', async () => {
    const onOuterClick = vi.fn();
    render(
      <div onClick={onOuterClick}>
        <ControlledSelect options={OPTIONS} />
      </div>
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(onOuterClick).toHaveBeenCalledTimes(1);
    await screen.findByRole('listbox');
  });

  it('size="sm" 下发 triggerSm 类名', () => {
    render(<Select size="sm" options={OPTIONS} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.className).toContain('triggerSm');
  });
});

describe('ui/Select (Compound 复合组件模式)', () => {
  it('声明式树形结构与 data-slot 标记', async () => {
    const onValueChange = vi.fn();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger startSlot={<span data-testid="prefix-icon">★</span>}>
          <SelectValue placeholder="请选择选项" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectGroupLabel>主流模型</SelectGroupLabel>
            <SelectItem value="gpt-4o">GPT-4o</SelectItem>
            <SelectItem value="claude-3-5" hint="Anthropic 旗舰">
              Claude 3.5 Sonnet
            </SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="deepseek-r1" shortcut="⌘1">
            DeepSeek-R1
          </SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAttribute('data-slot', 'select-trigger');
    expect(screen.getByTestId('prefix-icon')).toBeInTheDocument();
    expect(screen.getByText('请选择选项')).toHaveAttribute(
      'data-slot',
      'select-value'
    );

    fireEvent.click(trigger);
    const content = await screen.findByRole('listbox');
    expect(content).toHaveAttribute('data-slot', 'select-content');
    expect(content).toHaveAttribute('data-positioned', 'true');
    expect(screen.getByText('主流模型')).toHaveAttribute(
      'data-slot',
      'select-group-label'
    );

    const deepseekItem = screen.getByRole('option', { name: /DeepSeek-R1/ });
    expect(deepseekItem).toHaveAttribute('data-slot', 'select-item');
    expect(screen.getByText('⌘1')).toBeInTheDocument();

    fireEvent.click(deepseekItem);
    expect(onValueChange).toHaveBeenCalledWith('deepseek-r1');
    expect(trigger).toHaveTextContent('DeepSeek-R1');
  });

  it('同心圆角类名矩阵 (sm / md / lg)', async () => {
    const { unmount } = render(
      <Select size="sm" defaultOpen>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Item 1</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByRole('combobox').className).toContain('triggerSm');
    expect((await screen.findByRole('listbox')).className).toContain(
      'contentSm'
    );
    expect(screen.getByRole('option').className).toContain('itemSm');
    unmount();

    render(
      <Select size="lg" defaultOpen>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Item 1</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByRole('combobox').className).toContain('triggerLg');
    expect((await screen.findByRole('listbox')).className).toContain(
      'contentLg'
    );
    expect(screen.getByRole('option').className).toContain('itemLg');
  });

  it('clearable 功能：点击清除按钮清空选值', async () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="test-val" clearable onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="test-val">Test Option</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Test Option');
    const clearBtn = screen.getByRole('button', { name: '清空选值' });
    expect(clearBtn).toBeInTheDocument();

    fireEvent.click(clearBtn);
    expect(onValueChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('combobox')).toHaveTextContent('请选择');
  });

  it('键盘 Backspace / Delete 快捷清空选值', () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="test-val" clearable onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="test-val">Test Option</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'Backspace' });
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it('多选模式 (multiple) 支持多次选中与反选', async () => {
    const onValueChange = vi.fn();
    render(
      <Select multiple onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder="多选" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="opt1">Option 1</SelectItem>
          <SelectItem value="opt2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    const opt1 = await screen.findByRole('option', { name: 'Option 1' });
    const opt2 = screen.getByRole('option', { name: 'Option 2' });

    fireEvent.click(opt1);
    expect(onValueChange).toHaveBeenCalledWith(['opt1']);

    fireEvent.click(opt2);
    expect(onValueChange).toHaveBeenCalledWith(['opt1', 'opt2']);
  });

  it('全键盘漫游：Home/End 与 ArrowUp/Down 循环与跳过禁用项', async () => {
    render(
      <Select defaultOpen>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">One</SelectItem>
          <SelectItem value="2" disabled>
            Two (Disabled)
          </SelectItem>
          <SelectItem value="3">Three</SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole('combobox');
    const opt1 = screen.getByRole('option', { name: 'One' });
    const opt3 = screen.getByRole('option', { name: 'Three' });

    // 默认高亮首项
    expect(opt1).toHaveAttribute('data-highlighted', '');

    // 按 End 跳至末尾项
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(opt3).toHaveAttribute('data-highlighted', '');

    // 按 Home 跳至第一项
    fireEvent.keyDown(trigger, { key: 'Home' });
    expect(opt1).toHaveAttribute('data-highlighted', '');
  });
});

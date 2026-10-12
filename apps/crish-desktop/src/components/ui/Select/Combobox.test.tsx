// @vitest-environment jsdom
/**
 * ui/Select/Combobox 测试套件：
 * 1. 原生过滤与关键词高亮匹配（highlightMatches）
 * 2. 搜索无匹配时的优雅空态（ComboboxEmpty）
 * 3. IME 输入法合成锁状态机防御（拦截选词回车）
 * 4. 多选 Chips 胶囊排版、微型删除与 Backspace 倒格删除
 * 5. 视口几何翻折与边界碰撞纯函数解算
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
  Combobox,
  ComboboxInput,
  ComboboxChips,
  ComboboxChip,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  highlightMatches,
} from './Combobox';
import { computeFloatingPosition } from './useFloatingPosition';

const MODEL_ITEMS = [
  { id: 'gpt-4o', label: 'GPT-4o (Omni)' },
  { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'deepseek-r1', label: 'DeepSeek-R1' },
  { id: 'qwen-2-5-coder', label: 'Qwen 2.5 Coder' },
];

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('ui/Combobox 关键词高亮算法 (highlightMatches)', () => {
  it('当 query 为空时原样返回纯文本', () => {
    const res = highlightMatches('DeepSeek-R1', '');
    expect(res).toBe('DeepSeek-R1');
  });

  it('正确命中并高亮子串', () => {
    const { container } = render(
      <div>{highlightMatches('DeepSeek-R1', 'Seek')}</div>
    );
    const highlight = container.querySelector('span');
    expect(highlight).toBeInTheDocument();
    expect(highlight).toHaveTextContent('Seek');
  });

  it('忽略大小写高亮', () => {
    const { container } = render(
      <div>{highlightMatches('Claude 3.5 Sonnet', 'claude')}</div>
    );
    const highlight = container.querySelector('span');
    expect(highlight).toHaveTextContent('Claude');
  });
});

describe('ui/Combobox 单选与过滤', () => {
  function SingleComboboxDemo({
    onValueChange,
  }: {
    onValueChange?: (v: any) => void;
  }) {
    const [query, setQuery] = useState('');
    const filtered = MODEL_ITEMS.filter((item) =>
      item.label.toLowerCase().includes(query.toLowerCase())
    );

    return (
      <Combobox
        onValueChange={onValueChange}
        query={query}
        onQueryChange={setQuery}
      >
        <ComboboxInput placeholder="检索 AI 模型..." />
        <ComboboxContent>
          <ComboboxList>
            {filtered.length === 0 ? (
              <ComboboxEmpty>未找到相关模型</ComboboxEmpty>
            ) : (
              filtered.map((item) => (
                <ComboboxItem key={item.id} value={item.id} label={item.label}>
                  {item.label}
                </ComboboxItem>
              ))
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    );
  }

  it('输入关键字过滤选项，并在匹配项中渲染高亮', async () => {
    render(<SingleComboboxDemo />);
    const input = screen.getByRole('combobox');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'gpt' } });

    const content = await screen.findByRole('listbox');
    expect(content).toBeInTheDocument();
    expect(content).toHaveAttribute('data-positioned', 'true');

    const gptOption = screen.getByRole('option', { name: /GPT-4o/ });
    expect(gptOption).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Claude/ })
    ).not.toBeInTheDocument();

    // 选项内高亮
    const highlight = gptOption.querySelector('span');
    expect(highlight).toHaveTextContent('GPT');
  });

  it('无匹配时展示 ComboboxEmpty 空态提示', async () => {
    render(<SingleComboboxDemo />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'unknown-xyz' } });

    await screen.findByRole('listbox');
    expect(screen.getByText('未找到相关模型')).toBeInTheDocument();
  });

  it('点击选项触发 onValueChange 并关闭浮层', async () => {
    const onValueChange = vi.fn();
    render(<SingleComboboxDemo onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    const option = await screen.findByRole('option', { name: /DeepSeek-R1/ });
    fireEvent.click(option);

    expect(onValueChange).toHaveBeenCalledWith('deepseek-r1');
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    );
  });
});

describe('ui/Combobox IME 状态机合成防御 (Composition Guard)', () => {
  it('拼音选词敲击 Enter 时不触发选项选中', async () => {
    const onValueChange = vi.fn();
    render(
      <Combobox defaultOpen onValueChange={onValueChange}>
        <ComboboxInput />
        <ComboboxContent>
          <ComboboxList>
            <ComboboxItem value="zh-model">中文大模型</ComboboxItem>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    );

    const input = screen.getByRole('combobox');
    await screen.findByRole('listbox');

    // 触发输入法开始合成拼音
    fireEvent.compositionStart(input);

    // 模拟输入法选词按下回车
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onValueChange).not.toHaveBeenCalled();

    // 输入法结束合成
    fireEvent.compositionEnd(input);

    // 正常回车提交
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('zh-model');
  });
});

describe('ui/Combobox 多选 Chips 体系 (ComboboxChips)', () => {
  function MultiChipsDemo({
    onValueChange,
  }: {
    onValueChange?: (v: any) => void;
  }) {
    return (
      <Combobox multiple clearable onValueChange={onValueChange}>
        <ComboboxChips placeholder="选择多个模型..." />
        <ComboboxContent>
          <ComboboxList>
            {MODEL_ITEMS.map((item) => (
              <ComboboxItem key={item.id} value={item.id} label={item.label}>
                {item.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    );
  }

  it('多选模式下多次选中依次生成 Chips 胶囊', async () => {
    const onValueChange = vi.fn();
    render(<MultiChipsDemo onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox');

    fireEvent.focus(input);
    const opt1 = await screen.findByRole('option', { name: /GPT-4o/ });
    fireEvent.click(opt1);

    expect(onValueChange).toHaveBeenCalledWith(['gpt-4o']);

    const opt2 = screen.getByRole('option', { name: /Claude 3.5 Sonnet/ });
    fireEvent.click(opt2);

    expect(onValueChange).toHaveBeenCalledWith(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('点击 Chip 内的微型叉号移除该项', () => {
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        defaultValue={['gpt-4o', 'deepseek-r1']}
        onValueChange={onValueChange}
      >
        <ComboboxChips />
        <ComboboxContent>
          <ComboboxList>
            {MODEL_ITEMS.map((item) => (
              <ComboboxItem key={item.id} value={item.id}>
                {item.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    );

    const removeBtn = screen.getByRole('button', {
      name: 'Remove GPT-4o (Omni)',
    });
    fireEvent.click(removeBtn);

    expect(onValueChange).toHaveBeenCalledWith(['deepseek-r1']);
  });

  it('输入框为空时按 Backspace 键依次高亮并删除末尾 Chip', () => {
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        defaultValue={['gpt-4o', 'deepseek-r1']}
        onValueChange={onValueChange}
      >
        <ComboboxChips />
      </Combobox>
    );

    const input = screen.getByRole('combobox');
    // 第一次 Backspace：激活末尾 Chip
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onValueChange).not.toHaveBeenCalled();

    // 第二次 Backspace：删除已激活的末尾 Chip
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onValueChange).toHaveBeenCalledWith(['gpt-4o']);
  });
});

describe('ui/Select useFloatingPosition 视口碰撞算法 (computeFloatingPosition)', () => {
  it('底部空间充裕时，默认向下方展开 (side: bottom)', () => {
    const result = computeFloatingPosition({
      triggerRect: {
        top: 100,
        bottom: 132,
        left: 200,
        right: 360,
        width: 160,
        height: 32,
      } as DOMRect,
      popupWidth: 160,
      popupHeight: 200,
      side: 'bottom',
      sideOffset: 6,
      edgePadding: 8,
      viewport: { width: 1280, height: 800, offsetTop: 0, offsetLeft: 0 },
    });

    expect(result.side).toBe('bottom');
    expect(result.y).toBe(138); // 132 + 6
    expect(result.x).toBe(200);
    expect(result.transformOrigin).toBe('top left');
  });

  it('底部空间不足且上方空间更大时，自动翻折至上方 (side: top)', () => {
    const result = computeFloatingPosition({
      triggerRect: {
        top: 650,
        bottom: 682,
        left: 200,
        right: 360,
        width: 160,
        height: 32,
      } as DOMRect,
      popupWidth: 160,
      popupHeight: 200,
      side: 'bottom',
      sideOffset: 6,
      edgePadding: 8,
      viewport: { width: 1280, height: 700, offsetTop: 0, offsetLeft: 0 },
    });

    expect(result.side).toBe('top');
    expect(result.y).toBe(650 - 200 - 6); // 444
    expect(result.transformOrigin).toBe('bottom left');
  });

  it('右侧边界超出视口时，刚性钳位在视口安全区内', () => {
    const result = computeFloatingPosition({
      triggerRect: {
        top: 100,
        bottom: 132,
        left: 1200,
        right: 1360,
        width: 160,
        height: 32,
      } as DOMRect,
      popupWidth: 200,
      popupHeight: 150,
      side: 'bottom',
      edgePadding: 8,
      viewport: { width: 1280, height: 800, offsetTop: 0, offsetLeft: 0 },
    });

    // 最大 X 不超过 1280 - 200 - 8 = 1072
    expect(result.x).toBe(1072);
  });
});

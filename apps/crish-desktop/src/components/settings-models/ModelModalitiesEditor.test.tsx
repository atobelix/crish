// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ModelModalitiesEditor,
  ALL_INPUT_MODALITIES,
  ALL_OUTPUT_MODALITIES,
} from './ModelModalitiesEditor';

describe('ModelModalitiesEditor (多模态矩阵一等公民)', () => {
  it('完整渲染全部输入模态与输出模态标签', () => {
    const modalities = {
      input: ['text', 'image'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/多模态支持 \(Modalities\)/)).toBeInTheDocument();
    expect(screen.getByText('输入模态:')).toBeInTheDocument();
    expect(screen.getByText('输出模态:')).toBeInTheDocument();

    for (const mod of ALL_INPUT_MODALITIES) {
      expect(screen.getAllByText(new RegExp(mod)).length).toBeGreaterThan(0);
    }
    for (const mod of ALL_OUTPUT_MODALITIES) {
      expect(screen.getAllByText(new RegExp(mod)).length).toBeGreaterThan(0);
    }
  });

  it('点击未激活输入模态：触发 onChange 追加该模态', () => {
    const onChange = vi.fn();
    const modalities = {
      input: ['text'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={onChange}
      />
    );

    const inputSection = screen.getByText('输入模态:').parentElement!;
    const audioBtn = inputSection.querySelectorAll('button')[2]!; // audio is 3rd: text, image, audio
    fireEvent.click(audioBtn);
    expect(onChange).toHaveBeenCalledWith({
      input: ['text', 'audio'],
      output: ['text'],
    });
  });

  it('点击已激活 image 模态：触发 onChange 移除并同步 caps.image: false', () => {
    const onChange = vi.fn();
    const onSyncCaps = vi.fn();
    const modalities = {
      input: ['text', 'image'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={onChange}
        onSyncCaps={onSyncCaps}
      />
    );

    const inputSection = screen.getByText('输入模态:').parentElement!;
    const imageBtn = inputSection.querySelectorAll('button')[1]!; // image is 2nd
    fireEvent.click(imageBtn);
    expect(onChange).toHaveBeenCalledWith({
      input: ['text'],
      output: ['text'],
    });
    expect(onSyncCaps).toHaveBeenCalledWith({ image: false });
  });

  it('点击输出模态：触发 onChange 更新 output', () => {
    const onChange = vi.fn();
    const modalities = {
      input: ['text'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={onChange}
      />
    );

    const outputSection = screen.getByText('输出模态:').parentElement!;
    const imageBtn = outputSection.querySelector('button:nth-child(2)')!;
    fireEvent.click(imageBtn);

    expect(onChange).toHaveBeenCalledWith({
      input: ['text'],
      output: ['text', 'image'],
    });
  });
});

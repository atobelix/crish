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
      <ModelModalitiesEditor modalities={modalities} onChange={vi.fn()} />
    );

    expect(screen.getByText(/多模态支持/)).toBeInTheDocument();
    expect(screen.getByText('输入模态:')).toBeInTheDocument();
    expect(screen.getByText('输出模态:')).toBeInTheDocument();

    // 用户裁决 #4：模态标签为纯中文（去中英混杂）
    const labelMap: Record<string, string> = {
      text: '文本',
      image: '图片',
      audio: '音频',
      video: '视频',
      file: '文档/文件',
    };
    for (const mod of ALL_INPUT_MODALITIES) {
      expect(
        screen.getAllByText(new RegExp(labelMap[mod])).length
      ).toBeGreaterThan(0);
    }
    for (const mod of ALL_OUTPUT_MODALITIES) {
      expect(
        screen.getAllByText(new RegExp(labelMap[mod])).length
      ).toBeGreaterThan(0);
    }
  });

  it('点击未激活输入模态：触发 onChange 追加该模态', () => {
    const onChange = vi.fn();
    const modalities = {
      input: ['text'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor modalities={modalities} onChange={onChange} />
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
      <ModelModalitiesEditor modalities={modalities} onChange={onChange} />
    );

    const outputSection = screen.getByText('输出模态:').parentElement!;
    const imageBtn = outputSection.querySelector('button:nth-child(2)')!;
    fireEvent.click(imageBtn);

    expect(onChange).toHaveBeenCalledWith({
      input: ['text'],
      output: ['text', 'image'],
    });
  });

  it('保底每项至少选一个：仅剩1个模态时点击不触发取消（输入与输出均受控）', () => {
    const onChange = vi.fn();
    const modalities = {
      input: ['text'],
      output: ['text'],
    };
    render(
      <ModelModalitiesEditor modalities={modalities} onChange={onChange} />
    );

    const inputSection = screen.getByText('输入模态:').parentElement!;
    const inputBtn = inputSection.querySelectorAll('button')[0]!; // text is 1st
    fireEvent.click(inputBtn);
    expect(onChange).not.toHaveBeenCalled();

    const outputSection = screen.getByText('输出模态:').parentElement!;
    const outputBtn = outputSection.querySelectorAll('button')[0]!; // text is 1st
    fireEvent.click(outputBtn);
    expect(onChange).not.toHaveBeenCalled();
  });
});

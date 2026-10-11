// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelConfigDialog } from './ModelConfigDialog';
import type { CfgDraft } from './useModelProfilesState';

function DialogHarness({
  onSave = vi.fn(),
  onClose = vi.fn(),
}: {
  onSave?: () => void;
  onClose?: () => void;
}) {
  const [cfgDraft, setCfgDraft] = useState<CfgDraft | null>({
    enabled: true,
    displayName: 'DeepSeek V4 Pro',
    contextWindow: '128000',
    thinkingEnabled: false,
  });

  return (
    <ModelConfigDialog
      open
      modelId="deepseek-v4-pro"
      providerId="deepseek"
      cfgDraft={cfgDraft}
      setCfgDraft={setCfgDraft}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

describe('ModelConfigDialog', () => {
  it('在弹窗里配置已有模型，未声明思考时可以补上', () => {
    render(<DialogHarness />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'DeepSeek V4 Pro' })).toBeInTheDocument();
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument();
    expect(screen.queryByText('界面档位名称')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置思考档位' }));
    expect(screen.getByText('界面档位名称')).toBeInTheDocument();
  });

  it('保存走弹窗底栏', () => {
    const onSave = vi.fn();
    render(<DialogHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

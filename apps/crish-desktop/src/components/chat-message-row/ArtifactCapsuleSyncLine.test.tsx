// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArtifactCapsule, SyncLine } from './ArtifactCapsuleSyncLine';

describe('ArtifactCapsule & SyncLine (§5.4)', () => {
  it('ArtifactCapsule 渲染绿色下划线超链接与产物前缀，点击触发分流回调', () => {
    const onClick = vi.fn();
    const { container } = render(
      <ArtifactCapsule
        name="PE-08-session-loop-ipc-batcher"
        path="/path/to/PE-08.md"
        onClick={onClick}
      />
    );

    expect(container.querySelector('[data-icon="file-text"]')).not.toBeNull();
    // 移除“已生成”前缀冗余，布局自解释
    const btn = screen.getByRole('button', {
      name: '打开产物 PE-08-session-loop-ipc-batcher',
    });
    expect(btn).toBeDefined();

    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledWith('/path/to/PE-08.md');
    expect(container.querySelector('.flow-artifact')).not.toBeNull();
  });

  it('SyncLine 在同步中态渲染呼吸绿点与同步提示文案', () => {
    const { container } = render(
      <SyncLine status="syncing" label="batcher.rs 与前端虚拟列表渲染管线" />
    );

    expect(
      screen.getByText(/正在同步 batcher.rs 与前端虚拟列表渲染管线\.\.\./)
    ).toBeDefined();
    expect(container.querySelector('.flow-sync-dot')).not.toBeNull();
  });

  it('SyncLine 在完成态渲染已落盘与文件大小', () => {
    const { container } = render(
      <SyncLine status="completed" label="batcher.rs" size="1.2KB" />
    );

    expect(screen.getByText(/\(1\.2KB\)/)).toBeDefined();
    expect(container.querySelector('[data-icon="check"]')).not.toBeNull();
  });
});

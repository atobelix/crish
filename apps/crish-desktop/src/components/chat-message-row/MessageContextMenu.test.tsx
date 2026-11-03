// @vitest-environment jsdom
/**
 * MessageContextMenu 契约：复制/固定两条目接线到行既有能力入口。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MessageContextMenu } from './MessageContextMenu';
import { layerStackService } from '@/components/ui';

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('MessageContextMenu', () => {
  it('复制与固定条目分别回调行既有入口', async () => {
    const onCopy = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <MessageContextMenu
        x={8}
        y={8}
        anchorEl={null}
        copyLabel="复制正文"
        pinLabel="固定消息"
        isPinned={false}
        onClose={vi.fn()}
        onCopy={onCopy}
        onTogglePin={onTogglePin}
      />
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: /复制正文/ }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('menuitem', { name: /固定消息/ }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});

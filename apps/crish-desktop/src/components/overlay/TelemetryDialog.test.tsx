/**
 * 诊断日志弹窗（PE-05 T05.2 #1）关键行为测试：
 * 打开渲染 / Esc 关闭 / 遮罩点击关闭 / 清空日志动作
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TelemetryDialog } from './TelemetryDialog';

const { telemetryMock } = vi.hoisted(() => ({
  telemetryMock: {
    getEntries: vi.fn(() => []),
    getSessionId: vi.fn(() => 'session-12345678'),
    downloadLog: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../../services/TelemetryService', () => ({
  telemetry: telemetryMock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  telemetryMock.getEntries.mockReturnValue([
    { level: 'info', msg: 'a' },
    { level: 'error', msg: 'b' },
    { level: 'warn', msg: 'c' },
  ]);
});

describe('TelemetryDialog（ui/Dialog 基座迁移后）', () => {
  it('打开时渲染 role=dialog 与统计行', () => {
    render(<TelemetryDialog onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('记录总数')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('Esc 关闭并回调 onClose', () => {
    const onClose = vi.fn();
    render(<TelemetryDialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击关闭并回调 onClose', () => {
    const onClose = vi.fn();
    render(<TelemetryDialog onClose={onClose} />);
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('清空日志：telemetry.clear + 关闭', () => {
    const onClose = vi.fn();
    render(<TelemetryDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '清空日志' }));
    expect(telemetryMock.clear).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
/**
 * 设置 · 状态诊断面板渲染测试（PE-04 T04.5-2）。
 * mock fetchEngineStatus 数据源，断言四区（子系统就绪 / 日志配置 /
 * 最近错误 / 最近诊断）与错误醒目提示。
 * T-F 06 T2.5：搜索索引未就绪 → 「重建索引」按钮（core_rebuild_search_index）。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StatusDiagnosticsPanel } from './StatusDiagnosticsPanel';
import styles from './StatusDiagnosticsPanel.module.css';

const fetchEngineStatus = vi.fn();
const rebuildSearchIndex = vi.fn();

vi.mock('../../api/engineConfig', () => ({
  fetchEngineStatus: (...args: unknown[]) => fetchEngineStatus(...args),
}));

vi.mock('../../api/rustCore', () => ({
  rebuildSearchIndex: (...args: unknown[]) => rebuildSearchIndex(...args),
}));

const OK_STATUS = {
  ok: true,
  connected: true,
  engineReady: true,
  dbReady: false,
  searchIndexReady: true,
  logLevel: 'info',
  logDir: 'C:\\logs\\crish',
  diagnostics: [
    { ts: 1700000000000, level: 'info', message: 'engine init complete' },
    { ts: 1700000000100, level: 'error', message: 'run 失败: 引擎失败' },
  ],
  lastError: {
    kind: 'RunFailed',
    detail: '引擎失败（未就绪占位生产者）',
    ts: 1700000000100,
  },
};

beforeEach(() => {
  fetchEngineStatus.mockReset();
  rebuildSearchIndex.mockReset();
});

describe('StatusDiagnosticsPanel', () => {
  it('渲染四区：子系统就绪 / 日志配置 / 最近错误 / 最近诊断', async () => {
    fetchEngineStatus.mockResolvedValue(OK_STATUS);
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    // 子系统就绪徽标（engineReady OK；dbReady 异常醒目；searchIndexReady OK）
    await waitFor(() => {
      expect(screen.getByTestId('diag-engineReady')).toHaveTextContent('OK');
    });
    expect(screen.getByTestId('diag-dbReady')).toHaveTextContent('异常');
    expect(screen.getByTestId('diag-searchIndexReady')).toHaveTextContent('OK');

    // 日志配置
    const logLevel = screen.getByTestId('diag-log-level');
    expect(logLevel).toHaveTextContent('info');
    expect(logLevel).toHaveClass(styles.monoBadge);
    expect(screen.getByTestId('diag-log-dir')).toHaveTextContent(
      'C:\\logs\\crish'
    );

    // 最近错误（醒目错误块：kind + detail）
    const lastError = screen.getByTestId('diag-last-error');
    expect(lastError).toHaveTextContent('RunFailed');
    expect(lastError).toHaveTextContent('引擎失败（未就绪占位生产者）');
    expect(screen.getByRole('button', { name: '复制错误信息' })).toBeTruthy();

    // 最近诊断（最新在前：第一条为 error 级 run 失败）
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveClass(styles.diagItem);
    expect(items[0]).toHaveTextContent('ERROR');
    expect(items[0]).toHaveTextContent('run 失败: 引擎失败');
    expect(items[1]).toHaveClass(styles.diagItem);
    expect(items[1]).toHaveTextContent('INFO');
    expect(items[1]).toHaveTextContent('engine init complete');

    // 在线状态（无连接异常横幅）
    expect(screen.getByTestId('diag-connection')).toHaveTextContent('在线');
    expect(screen.queryByTestId('diag-error-banner')).toBeNull();
  });

  it('无错误记录 / 无诊断时展示空态，不渲染错误块', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: true,
      connected: true,
      engineReady: true,
      dbReady: true,
      searchIndexReady: true,
      logLevel: 'debug',
      logDir: 'C:\\logs\\crish',
    });
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-no-error')).toHaveTextContent(
        '无错误记录'
      );
    });
    expect(screen.getByTestId('diag-no-error')).toHaveClass(styles.noError);
    expect(screen.getByTestId('diag-no-diagnostics')).toHaveTextContent(
      '暂无诊断记录'
    );
    expect(screen.getByTestId('diag-no-diagnostics')).toHaveClass(
      styles.noError
    );
    expect(screen.queryByTestId('diag-last-error')).toBeNull();
    expect(screen.getByTestId('diag-log-level')).toHaveTextContent('debug');
  });

  it('获取失败时醒目提示（错误横幅 + 连接异常），仍保留面板骨架', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: false,
      connected: false,
      error: 'not_connected',
    });
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-error-banner')).toBeTruthy();
    });
    expect(screen.getByTestId('diag-error-banner')).toHaveTextContent(
      '无法获取核心状态'
    );
    expect(screen.getByTestId('diag-error-banner')).toHaveTextContent(
      'not_connected'
    );
    expect(screen.getByTestId('diag-connection')).toHaveTextContent('连接异常');
    // 骨架仍在（未就绪徽标按未知渲染）
    expect(screen.getByTestId('diag-engineReady')).toHaveTextContent('未知');
  });

  it('fetchEngineStatus 抛异常 → 同样走错误醒目提示', async () => {
    fetchEngineStatus.mockRejectedValue(new Error('invoke failed'));
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-error-banner')).toHaveTextContent(
        'invoke failed'
      );
    });
  });

  it('T2.5：searchIndexReady=false 时渲染「重建索引」按钮，点击调 rebuildSearchIndex 并刷新状态', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: true,
      connected: true,
      engineReady: true,
      dbReady: true,
      searchIndexReady: false,
    });
    rebuildSearchIndex.mockResolvedValue(true);
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-searchIndexReady')).toHaveTextContent(
        '异常'
      );
    });
    const rebuildBtn = screen.getByTestId('diag-rebuild-search-index');
    expect(rebuildBtn).toBeTruthy();
    expect(rebuildBtn).toHaveTextContent('重建索引');
    expect(rebuildBtn).toHaveAttribute('data-variant', 'secondary');

    fireEvent.click(rebuildBtn);
    await waitFor(() => {
      expect(rebuildSearchIndex).toHaveBeenCalledTimes(1);
    });
    // 成功后刷新状态（fetchEngineStatus 再次被调用）
    await waitFor(() => {
      expect(fetchEngineStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('微内核健康且在线（即使模型未配置 engineReady=false），引擎行展示 OK', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: true,
      connected: true,
      initialized: true,
      engineReady: false,
      dbReady: true,
      searchIndexReady: true,
      logLevel: 'info',
      logDir: 'C:\\logs\\crish',
    });
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-engineReady')).toHaveTextContent('OK');
    });
  });

  it('微内核发生崩溃（lastCrash 存在）时，引擎行展示异常', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: true,
      connected: true,
      initialized: true,
      engineReady: true,
      dbReady: true,
      searchIndexReady: true,
      lastCrash: {
        fileName: 'crash-20261020-070000-main.log',
        timestampMs: 1700000000000,
      },
      logLevel: 'info',
      logDir: 'C:\\logs\\crish',
    });
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-engineReady')).toHaveTextContent('异常');
    });
  });

  it('T2.5：searchIndexReady=true / 状态未知时不渲染重建按钮', async () => {
    fetchEngineStatus.mockResolvedValue({
      ok: true,
      connected: true,
      engineReady: true,
      dbReady: true,
      searchIndexReady: true,
    });
    render(<StatusDiagnosticsPanel pollIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('diag-searchIndexReady')).toHaveTextContent(
        'OK'
      );
    });
    expect(screen.queryByTestId('diag-rebuild-search-index')).toBeNull();
  });
});

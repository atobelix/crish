// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import {
  SidePanelLauncherHub,
  detectActiveServicePort,
} from './SidePanelLauncherHub';
import * as previewBrowserStore from '../../api/previewBrowserStore';

describe('SidePanelLauncherHub 空状态与运行中端口直达', () => {
  const onOpenPanel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('展示核心双入口：应用预览与代码产物与文件', () => {
    const { getByTestId, getByText } = render(
      <SidePanelLauncherHub onOpenPanel={onOpenPanel} detectedPort={null} />
    );

    expect(getByTestId('launcher-card-preview')).toBeTruthy();
    expect(getByTestId('launcher-card-files')).toBeTruthy();
    expect(getByText('应用预览')).toBeTruthy();
    expect(getByText('代码产物与文件')).toBeTruthy();
  });

  it('点击应用预览卡片触发 onOpenPanel(preview)', () => {
    const { getByTestId } = render(
      <SidePanelLauncherHub onOpenPanel={onOpenPanel} detectedPort={null} />
    );

    fireEvent.click(getByTestId('launcher-card-preview'));
    expect(onOpenPanel).toHaveBeenCalledWith('preview');
  });

  it('点击代码产物与文件卡片触发 onOpenPanel(files)', () => {
    const { getByTestId } = render(
      <SidePanelLauncherHub onOpenPanel={onOpenPanel} detectedPort={null} />
    );

    fireEvent.click(getByTestId('launcher-card-files'));
    expect(onOpenPanel).toHaveBeenCalledWith('files');
  });

  it('检测到运行中端口时，显示直达胶囊并支持一键预览导航', () => {
    const setPreviewSpy = vi.spyOn(previewBrowserStore, 'setPreviewUrl');

    const { getByTestId, getByText } = render(
      <SidePanelLauncherHub onOpenPanel={onOpenPanel} detectedPort={5173} />
    );

    const activeServiceCard = getByTestId('launcher-card-active-service');
    expect(activeServiceCard).toBeTruthy();
    expect(
      getByText(/运行中的服务:\s*http:\/\/localhost:5173\s*\(点击在右侧预览\)/)
    ).toBeTruthy();

    fireEvent.click(activeServiceCard);
    expect(setPreviewSpy).toHaveBeenCalledWith('http://localhost:5173');
    expect(onOpenPanel).toHaveBeenCalledWith('preview');
  });

  it('detectActiveServicePort 能够探测响应端口', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('5173')) {
        return Promise.resolve(new Response('ok'));
      }
      return Promise.reject(new Error('Connection refused'));
    });
    globalThis.fetch = fetchMock;

    const detected = await detectActiveServicePort([3000, 5173, 8080], 200);
    expect(detected).toBe(5173);

    globalThis.fetch = originalFetch;
  });
});

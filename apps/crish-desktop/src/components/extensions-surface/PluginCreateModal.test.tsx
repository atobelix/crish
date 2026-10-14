// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { PluginCreateModal } from './PluginCreateModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as customPluginStorage from './customPluginStorage';

describe('PluginCreateModal (PluginImportModal)', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders import modal and dropzone with file and directory selection', () => {
    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    expect(screen.getByText('导入插件')).toBeInTheDocument();
    expect(
      screen.getByText(/点击选择文件，或将插件文件拖拽至此处/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '选择文件' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '选择插件目录' })
    ).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: '确认导入' });
    expect(confirmBtn).toBeDisabled();
  });

  it('imports plugin via manifest.json file', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const manifestContent = JSON.stringify({
      id: 'awesome-tool',
      name: 'Awesome Tool',
      version: '2.0.0',
      description: 'A great custom plugin tool',
      type: 'tool',
    });

    const file = new File([manifestContent], 'manifest.json', {
      type: 'application/json',
    });

    const fileInput = screen.getByTestId('plugin-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    expect(screen.getByText('Awesome Tool')).toBeInTheDocument();
    expect(screen.getByText('awesome-tool')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
    expect(screen.getByText('A great custom plugin tool')).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: '确认导入' });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'awesome-tool',
        name: 'Awesome Tool',
        version: '2.0.0',
        description: 'A great custom plugin tool',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('imports plugin via package.json file', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const packageContent = JSON.stringify({
      name: '@scoped/my-linter',
      version: '1.5.0',
      description: 'Npm linter plugin for code review',
      author: 'Tester',
    });

    const file = new File([packageContent], 'package.json', {
      type: 'application/json',
    });

    const fileInput = screen.getByTestId('plugin-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    expect(screen.getByText('my-linter')).toBeInTheDocument();
    expect(screen.getByText('1.5.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'my-linter',
        version: '1.5.0',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('imports plugin via .zip file', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const file = new File(['fake-zip-binary-data'], 'git-workflow-plugin.zip', {
      type: 'application/zip',
    });

    const fileInput = screen.getByTestId('plugin-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('git-workflow-plugin').length
    ).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'git-workflow-plugin',
        name: 'git-workflow-plugin',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('imports plugin via directory selection containing manifest.json', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const manifestContent = JSON.stringify({
      id: 'dir-plugin',
      name: 'Directory Plugin',
      version: '3.1.0',
      description: 'Imported from folder',
    });

    const file = new File([manifestContent], 'manifest.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'my-plugin-folder/manifest.json',
    });

    const otherFile = new File(['code'], 'index.js', {
      type: 'text/javascript',
    });
    Object.defineProperty(otherFile, 'webkitRelativePath', {
      value: 'my-plugin-folder/index.js',
    });

    const dirInput = screen.getByTestId('plugin-dir-input');
    fireEvent.change(dirInput, { target: { files: [file, otherFile] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    expect(screen.getByText('Directory Plugin')).toBeInTheDocument();
    expect(screen.getByText('dir-plugin')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dir-plugin',
        name: 'Directory Plugin',
        version: '3.1.0',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('supports reselect to reset to dropzone', async () => {
    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const file = new File(['{"name":"Temp"}'], 'manifest.json', {
      type: 'application/json',
    });
    const fileInput = screen.getByTestId('plugin-file-input');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));

    expect(
      screen.getByText(/点击选择文件，或将插件文件拖拽至此处/)
    ).toBeInTheDocument();
  });

  it('handles malformed JSON file gracefully with error hint and disabled confirm button', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const corruptFile = new File(
      ['{ invalid json content: 123,'],
      'broken-plugin.json',
      {
        type: 'application/json',
      }
    );

    const fileInput = screen.getByTestId('plugin-file-input');
    fireEvent.change(fileInput, { target: { files: [corruptFile] } });

    await waitFor(() => {
      expect(
        screen.getByText(/无法从文件「broken-plugin.json」解析出有效插件配置/)
      ).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole('button', { name: '确认导入' });
    expect(confirmBtn).toBeDisabled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('handles directory without valid manifest or package.json gracefully', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const txtFile = new File(['hello world'], 'readme.txt', {
      type: 'text/plain',
    });
    Object.defineProperty(txtFile, 'webkitRelativePath', {
      value: 'empty-dir/readme.txt',
    });

    const dirInput = screen.getByTestId('plugin-dir-input');
    fireEvent.change(dirInput, { target: { files: [txtFile] } });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    // Fallback to directory name
    expect(screen.getAllByText('empty-dir').length).toBeGreaterThanOrEqual(1);
    const confirmBtn = screen.getByRole('button', { name: '确认导入' });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'empty-dir',
        name: 'empty-dir',
      })
    );
  });

  it('handles drag and drop of file', async () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    const dropZone = screen.getByLabelText('插件文件上传区域');
    const validFile = new File(
      [
        JSON.stringify({
          id: 'dragged-tool',
          name: 'Dragged Tool',
          version: '1.0.0',
        }),
      ],
      'manifest.json',
      { type: 'application/json' }
    );

    fireEvent.dragOver(dropZone);
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [validFile],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('已识别插件信息')).toBeInTheDocument();
    });

    expect(screen.getByText('Dragged Tool')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dragged-tool',
        name: 'Dragged Tool',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
  });
});

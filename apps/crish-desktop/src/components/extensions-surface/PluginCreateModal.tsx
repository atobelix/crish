import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, Button, Input } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import {
  saveCustomPlugin,
  parsePluginFromFileContent,
  parsePluginFromZipFile,
  parsePluginFromDirectoryFiles,
  type CustomPluginItem,
} from './customPluginStorage';
import styles from './PluginCreateModal.module.css';

export interface PluginCreateModalProps {
  open: boolean;
  initialTab?: 'create' | 'manual';
  onClose: () => void;
  onSuccess?: (plugin: CustomPluginItem) => void;
}

export const PluginCreateModal: React.FC<PluginCreateModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [parsedPlugin, setParsedPlugin] = useState<CustomPluginItem | null>(
    null
  );
  const [sourceName, setSourceName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLoading(false);
      setDragOver(false);
      setParsedPlugin(null);
      setSourceName('');
      setErrorMsg(null);
    }
  }, [open]);

  const processFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const isZip =
          file.name.toLowerCase().endsWith('.zip') ||
          file.type === 'application/zip' ||
          file.type === 'application/x-zip-compressed';

        let parsed: CustomPluginItem | null = null;
        if (isZip) {
          parsed = await parsePluginFromZipFile(file);
        } else {
          const text =
            typeof file.text === 'function'
              ? await file.text()
              : await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result as string);
                  reader.onerror = reject;
                  reader.readAsText(file);
                });
          parsed = parsePluginFromFileContent(text, file.name);
        }

        if (parsed) {
          setParsedPlugin(parsed);
          setSourceName(file.name);
        } else {
          setErrorMsg(
            `无法从文件「${file.name}」解析出有效插件配置，请检查 JSON 结构`
          );
          showToast('无法解析插件配置，请确保文件包含有效插件元数据');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`解析文件失败：${msg}`);
        showToast(`解析失败：${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  const processDirectoryFiles = useCallback(
    async (files: File[]) => {
      if (!files || files.length === 0) return;
      setLoading(true);
      setErrorMsg(null);
      try {
        const parsed = await parsePluginFromDirectoryFiles(files);
        if (parsed) {
          setParsedPlugin(parsed);
          const first = files[0];
          const relativePath = (first as any)?.webkitRelativePath || '';
          const dirName =
            (relativePath ? relativePath.split('/')[0] : '') ||
            (first ? first.name : '') ||
            '插件目录';
          setSourceName(`${dirName}/ (${files.length} 个文件)`);
        } else {
          setErrorMsg(
            '未能在所选目录中找到 manifest.json 或 package.json 配置文件'
          );
          showToast('未找到有效插件配置文件');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`扫描目录失败：${msg}`);
        showToast(`扫描失败：${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void processFile(file);
    }
    e.target.value = '';
  };

  const handleDirInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processDirectoryFiles(Array.from(files));
    }
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const singleFile = files[0];
    if (files.length === 1 && singleFile) {
      void processFile(singleFile);
    } else {
      void processDirectoryFiles(Array.from(files));
    }
  };

  const handleConfirmImport = () => {
    if (!parsedPlugin) return;

    saveCustomPlugin(parsedPlugin);
    showToast(`已成功导入插件「${parsedPlugin.name}」`);
    onSuccess?.(parsedPlugin);
    onClose();
  };

  const handleReselect = () => {
    setParsedPlugin(null);
    setSourceName('');
    setErrorMsg(null);
  };

  return (
    <Dialog
      size="lg"
      open={open}
      onClose={onClose}
      title="导入插件"
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<AppIcon name="folder-input" size={14} />}
            disabled={!parsedPlugin || loading}
            loading={loading}
            onClick={handleConfirmImport}
          >
            确认导入
          </Button>
        </div>
      }
    >
      {/* 隐藏的文件输入组件 */}
      <Input
        bare
        ref={fileInputRef}
        type="file"
        accept=".zip,.json,application/json,application/zip,application/x-zip-compressed"
        className={styles.hiddenInput}
        data-testid="plugin-file-input"
        onChange={handleFileInputChange}
      />
      <Input
        bare
        ref={dirInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as any)}
        className={styles.hiddenInput}
        data-testid="plugin-dir-input"
        onChange={handleDirInputChange}
      />

      {errorMsg && <div className={styles.errorHint}>{errorMsg}</div>}

      {!parsedPlugin ? (
        <div
          className={`${styles.dropZone} ${dragOver ? styles.dropZoneDragging : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="region"
          aria-label="插件文件上传区域"
        >
          <div className={styles.dropzoneIconWrapper}>
            <AppIcon
              name="folder-input"
              size={20}
              className={styles.dropZoneIcon}
              aria-hidden
            />
          </div>
          <div className={styles.dropZoneTitle}>
            {loading
              ? '正在解析插件信息…'
              : '点击选择文件，或将插件文件拖拽至此处'}
          </div>
          <div className={styles.dropZoneDesc}>
            支持插件压缩包 (.zip)、manifest.json、package.json
            或选择整个插件目录，无需手动编写配置
          </div>
          <div
            className={styles.dropZoneActions}
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="secondary"
              size="sm"
              icon={<AppIcon name="folder-input" size={14} />}
              loading={loading}
              onClick={() => fileInputRef.current?.click()}
            >
              选择文件
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<AppIcon name="folder" size={14} />}
              loading={loading}
              onClick={() => dirInputRef.current?.click()}
            >
              选择插件目录
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.previewCard} data-testid="plugin-preview-card">
          <div className={styles.previewHeader}>
            <div className={styles.previewTitle}>
              <AppIcon name="puzzle" size={16} />
              <span>已识别插件信息</span>
            </div>
            {sourceName && (
              <span className={styles.fileBadge}>{sourceName}</span>
            )}
          </div>

          <div className={styles.previewGrid}>
            <div className={styles.previewField}>
              <span className={styles.previewLabel}>插件名称</span>
              <span className={styles.previewValue}>{parsedPlugin.name}</span>
            </div>
            <div className={styles.previewField}>
              <span className={styles.previewLabel}>插件 ID</span>
              <span className={styles.previewValue}>{parsedPlugin.id}</span>
            </div>
            <div className={styles.previewField}>
              <span className={styles.previewLabel}>版本号</span>
              <span className={styles.previewValue}>
                {parsedPlugin.version}
              </span>
            </div>
            <div className={styles.previewField}>
              <span className={styles.previewLabel}>插件类型</span>
              <span className={styles.previewValue}>
                {parsedPlugin.type === 'tool' ? '工具插件' : '自定义插件'}
              </span>
            </div>
            <div
              className={`${styles.previewField} ${styles.previewDescField}`}
            >
              <span className={styles.previewLabel}>功能描述</span>
              <span className={styles.previewDesc}>
                {parsedPlugin.description}
              </span>
            </div>
          </div>

          <div className={styles.reselectRow}>
            <Button
              variant="ghost"
              size="sm"
              icon={<AppIcon name="rotate-cw" size={12} />}
              onClick={handleReselect}
            >
              重新选择
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
};

export const PluginImportModal = PluginCreateModal;

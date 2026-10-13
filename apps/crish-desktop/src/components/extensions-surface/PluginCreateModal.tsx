import React, { useState, useEffect } from 'react';
import { Dialog, Button, Input, Textarea, SegmentedControl } from '../ui';
import { AppIcon } from '../ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import {
  saveCustomPlugin,
  parseManualPluginInput,
  type CustomPluginItem,
} from './customPluginStorage';
import styles from './PluginCreateModal.module.css';

export interface PluginCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (plugin: CustomPluginItem) => void;
}

export const PluginCreateModal: React.FC<PluginCreateModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'create' | 'manual'>('create');
  const [name, setName] = useState('');
  const [pluginId, setPluginId] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [manualInput, setManualInput] = useState('');

  useEffect(() => {
    if (open) {
      setActiveTab('create');
      setName('');
      setPluginId('');
      setVersion('1.0.0');
      setDescription('');
      setIdManuallyEdited(false);
      setManualInput('');
    }
  }, [open]);

  const handleNameChange = (val: string) => {
    setName(val);
    if (!idManuallyEdited) {
      const slug = val
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-');
      setPluginId(slug);
    }
  };

  const handleSaveCreate = () => {
    const trimmedName = name.trim();
    const trimmedId = pluginId.trim();

    if (!trimmedName) {
      showToast('请输入插件名称');
      return;
    }
    if (!trimmedId) {
      showToast('请输入插件 ID（唯一标识符）');
      return;
    }

    const item: CustomPluginItem = {
      id: trimmedId,
      name: trimmedName,
      version: version.trim() || '1.0.0',
      description: description.trim(),
      type: 'custom',
      tags: ['custom'],
      createdAt: Date.now(),
    };

    saveCustomPlugin(item);
    showToast(`自定义插件「${item.name}」已成功保存！`);
    onSuccess?.(item);
    onClose();
  };

  const handleInstallManual = () => {
    const raw = manualInput.trim();
    if (!raw) {
      showToast('请输入插件 JSON 规格或本地路径 / npm 包名');
      return;
    }

    const item = parseManualPluginInput(raw);
    if (!item) {
      showToast('无法解析插件规格或路径，请检查输入格式');
      return;
    }

    saveCustomPlugin(item);
    showToast(`成功安装插件「${item.name}」！`);
    onSuccess?.(item);
    onClose();
  };

  return (
    <Dialog
      size="lg"
      open={open}
      onClose={onClose}
      title="添加与制作插件"
      description="自主制作或手动导入自定义插件规格，扩展智能工作台能力"
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          {activeTab === 'create' ? (
            <Button
              variant="primary"
              size="sm"
              icon={<AppIcon name="save" size={14} />}
              onClick={handleSaveCreate}
            >
              保存自定义插件
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<AppIcon name="download" size={14} />}
              onClick={handleInstallManual}
            >
              解析并安装
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.tabWrapper}>
        <SegmentedControl
          size="sm"
          block
          value={activeTab}
          onChange={(v) => setActiveTab(v as 'create' | 'manual')}
          options={[
            {
              value: 'create',
              label: '制作自定义插件',
              icon: <AppIcon name="puzzle" size={14} />,
            },
            {
              value: 'manual',
              label: '手动导入 / 规格安装',
              icon: <AppIcon name="code" size={14} />,
            },
          ]}
        />
      </div>

      {activeTab === 'create' ? (
        <div className={styles.formGrid}>
          <div className={styles.guideCard}>
            <div className={styles.guideTitle}>
              <AppIcon name="puzzle" size={16} />
              <span>制作新的自定义插件</span>
            </div>
            <div className={styles.guideDesc}>
              定义插件的基本信息与元数据，保存后可随时在扩展工作台中启用、配置或分享给其他协作者。
            </div>
          </div>

          <div className={styles.rowInputs}>
            <Input
              label="插件名称 (Name)"
              placeholder="例如：My Awesome Tool"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              autoFocus
            />
            <Input
              label="插件 ID (Identifier)"
              placeholder="例如：my-awesome-tool"
              value={pluginId}
              onChange={(e) => {
                setIdManuallyEdited(true);
                setPluginId(e.target.value);
              }}
              hint="英文、数字与短横线，全局唯一标识"
            />
          </div>

          <Input
            label="版本号 (Version)"
            placeholder="1.0.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />

          <Textarea
            label="功能描述 (Description)"
            placeholder="描述此插件的主要功能、适用场景及执行参数…"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      ) : (
        <div className={styles.formGrid}>
          <div className={styles.guideCard}>
            <div className={styles.guideTitle}>
              <AppIcon name="code" size={16} />
              <span>导入 JSON 配置或安装外部包</span>
            </div>
            <div className={styles.guideDesc}>
              粘贴他人分享的插件 JSON 规格，或者输入本地文件路径（如
              ./extensions/my-tool）与 npm 包名。
            </div>
          </div>

          <Textarea
            label="插件 JSON 规格 / 本地路径 / npm 包名"
            placeholder={`{\n  "id": "my-shared-tool",\n  "name": "协作工具",\n  "version": "1.0.0",\n  "description": "..."\n}\n\n或输入：@scope/plugin-name 或 ./plugins/custom-tool`}
            rows={8}
            className={styles.codeArea}
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            hint="系统将自动识别 JSON 结构并解析元数据，非 JSON 输入将作为扩展路径解析。"
          />
        </div>
      )}
    </Dialog>
  );
};

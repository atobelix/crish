import React, { useRef } from 'react';
import { Button, Dialog } from '@/components/ui';
import { ModelConfigPanel } from './ModelConfigPanel';
import type { CfgDraft } from './useModelProfilesState';

/**
 * 已有模型的配置弹窗。
 * 用界面弹窗基座，避免在窄列表里展开一整张表。
 */
export const ModelConfigDialog: React.FC<{
  open: boolean;
  modelId: string;
  providerId?: string;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}> = ({
  open,
  modelId,
  providerId,
  cfgDraft,
  setCfgDraft,
  onClose,
  onSave,
}) => {
  const lastDraft = useRef<CfgDraft | null>(cfgDraft);
  if (cfgDraft) lastDraft.current = cfgDraft;
  const shown = cfgDraft ?? lastDraft.current;
  const title = shown?.displayName?.trim() || modelId || '模型配置';
  const description =
    shown && modelId && title !== modelId ? modelId : undefined;

  return (
    <Dialog
      open={open && shown != null}
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void onSave()}
          >
            保存
          </Button>
        </>
      }
    >
      {shown ? (
        <ModelConfigPanel
          modelId={modelId}
          providerId={providerId}
          cfgDraft={shown}
          setCfgDraft={setCfgDraft}
        />
      ) : null}
    </Dialog>
  );
};

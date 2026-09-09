/**
 * 融合触发：一条弱分割胶囊，左真模型槽、右思考档。
 * 模型由宿主 rightActions（ModelBadgePicker）注入。
 * 档位能力 = yaml thinking 字典（listThinkingOptions）；标签 = 字典 key。
 * 选中 Title 写入会话 runtime.thinkingTitle，不写 yaml、不写全局 settings。
 * 无思考选项则物理卸载右侧槽。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ComposerFusedTrigger.module.css';
import { Menu, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  getActiveModelId,
  getActiveProfileId,
} from '../../api/provider-profiles/profileActiveSelection';
import { onUiEvent } from '../../api/uiEvents';
import {
  getLiveModel,
  listThinkingOptions,
  resolveThinkingHandoff,
} from '../../api/modelsCatalogLive';
import {
  getSessionThinkingTitle,
  setSessionThinkingTitle,
  loadModelThinkingPref,
  saveModelThinkingPref,
} from '../../api/SessionRuntimeRegistry';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { useSessionStore } from '../../store/sessionStore';

export type ComposerFusedTriggerProps = {
  children?: React.ReactNode;
};

export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
  children,
}) => {
  const catalogVersion = useModelsCatalogVersion();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState(() => ({
    providerId: (getActiveProfileId() ?? '').trim(),
    modelId: (getActiveModelId() ?? '').trim(),
  }));
  const [titleEpoch, setTitleEpoch] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const update = (detail?: { profileId?: string; model?: string }) => {
      setIdentity({
        providerId: (detail?.profileId || getActiveProfileId() || '').trim(),
        modelId: (detail?.model || getActiveModelId() || '').trim(),
      });
    };
    const offModel = onUiEvent('model-changed', update);
    const offProfiles = onUiEvent('profiles-changed', () => update());
    update();
    return () => {
      offModel();
      offProfiles();
    };
  }, [catalogVersion]);

  // Picker（或其它写入口）改档后同步刷新胶囊：订阅 thinking-title-changed
  useEffect(() => {
    const off = onUiEvent('thinking-title-changed', (detail) => {
      if (detail?.sessionId === sessionId) {
        setTitleEpoch((n) => n + 1);
      }
    });
    return off;
  }, [sessionId]);

  const { providerId, modelId } = identity;

  useEffect(() => {
    setOpen(false);
  }, [sessionId, providerId, modelId]);

  const liveModel = useMemo(
    () => getLiveModel(providerId, modelId),
    [providerId, modelId, catalogVersion]
  );

  const options = useMemo(
    () => listThinkingOptions(providerId, modelId),
    [providerId, modelId, catalogVersion]
  );

  const storedTitle = useMemo(
    () =>
      // 先读会话内存存档；未设置时尝试按模型读取 localStorage 跨会话存档
      getSessionThinkingTitle(sessionId) ??
      loadModelThinkingPref(providerId, modelId),
    [sessionId, titleEpoch, providerId, modelId]
  );

  const handoff = useMemo(
    () => resolveThinkingHandoff(providerId, modelId, storedTitle),
    [providerId, modelId, storedTitle, catalogVersion]
  );

  const showThinking = options.length > 0;

  useEffect(() => {
    // 仅当 showThinking=false 时不重置已有存档（避免异步目录重刷时误清状态）
    if (!showThinking) return;
    if (!handoff.supported) return;
    if (storedTitle !== handoff.selectedTitle) {
      setSessionThinkingTitle(sessionId, handoff.selectedTitle);
      setTitleEpoch((n) => n + 1);
    }
  }, [
    sessionId,
    showThinking,
    storedTitle,
    handoff.supported,
    handoff.selectedTitle,
  ]);

  const currentTitle = handoff.supported ? handoff.selectedTitle : '';

  const selectLevel = useCallback(
    (title: string) => {
      setSessionThinkingTitle(sessionId, title);
      // 跨会话持久化：按模型存档用户选择，重启后可恢复
      saveModelThinkingPref(providerId, modelId, title);
      setTitleEpoch((n) => n + 1);
      setOpen(false);
    },
    [sessionId, providerId, modelId]
  );

  const menuOptions = options.map((o) => ({
    id: o.title,
    label: o.title,
    onClick: () => {
      selectLevel(o.title);
    },
  }));

  return (
    <div
      className={styles.capsule}
      data-testid="composer-fused-trigger"
      data-catalog-tick={catalogVersion}
      data-live-model-id={liveModel?.id ?? ''}
      data-has-thinking={showThinking ? 'true' : 'false'}
    >
      {children ? <div className={styles.left}>{children}</div> : null}
      {showThinking && children ? (
        <span className={styles.divider} aria-hidden />
      ) : null}
      {showThinking ? (
        <div className={styles.right} data-testid="composer-thinking-slot">
          <Tooltip
            content={`思考档位：${currentTitle}`}
            disabled={open}
            side="top"
          >
            <button
              ref={btnRef}
              type="button"
              className={`${styles.thinkBtn} ${open ? styles.isOpen : ''}`}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`思考档位：${currentTitle}`}
              data-testid="composer-thinking-trigger"
              onClick={() => toggleExclusiveMenu(open, setOpen, btnRef.current)}
            >
              <span>{currentTitle}</span>
            </button>
          </Tooltip>
          {open ? (
            <Menu
              openState={{
                open,
                onOpenChange: (nextOpen) => {
                  if (!nextOpen) setOpen(false);
                },
              }}
              anchor={btnRef}
              options={menuOptions}
              position={{ side: 'top', align: 'end', sideOffset: 6 }}
              panel={{ contentClassName: styles.menu }}
              renderItem={(opt) => {
                const selected = opt.id === currentTitle;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`${styles.item} ${selected ? styles.isSelected : ''}`}
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      opt.onClick?.();
                    }}
                  >
                    <span>{opt.label}</span>
                    {selected ? (
                      <Lucide.Check
                        size={13}
                        className={styles.check}
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                );
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

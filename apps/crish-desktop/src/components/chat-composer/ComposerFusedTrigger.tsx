/**
 * 融合触发：一条弱分割胶囊，左真模型槽、右思考档。
 * 模型由宿主 rightActions（ModelBadgePicker）注入。
 * 档位能力 = yaml thinking 字典（listThinkingOptions）；标签 = 词表中文标签（别名键归一到规范档位）。
 * 选中 Title 写入会话 runtime.thinkingTitle，不写 yaml、不写全局 settings。
 * 原选档位不在当前模型声明中 → 视为未选，显示「请选择思考档位」引导（不降级）。
 * 无思考选项则物理卸载右侧槽。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './ComposerFusedTrigger.module.css';
import { Button, Menu, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  getActiveModelId,
  getActiveProfileId,
} from '../../api/provider-profiles/profileActiveSelection';
import { onUiEvent } from '../../api/uiEvents';
import {
  getLiveModel,
  listThinkingOptions,
  resolveThinkingHandoffSafe,
} from '../../api/modelsCatalogLive';
import {
  getSessionThinkingTitle,
  setSessionThinkingTitle,
  resolveEffectiveThinkingTitle,
  persistThinkingSelection,
} from '../../api/SessionRuntimeRegistry';
import { recordPendingContextState } from '../../api/provider-profiles/contextStatePending';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { useSessionStore } from '../../store/sessionStore';
import { AppIcon } from '../ui/icons/index';

export type ComposerFusedTriggerProps = {
  prefix?: React.ReactNode;
  children?: React.ReactNode;
};

export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
  prefix,
  children,
}) => {
  const catalogVersion = useModelsCatalogVersion();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState(() => ({
    providerId: (getActiveProfileId() ?? '').trim(),
    modelId: (getActiveModelId() ?? '').trim(),
  }));
  // titleEpoch：SessionRuntimeRegistry 的 thinkingTitle 存在模块级可变内存中，
  // 不是 React 状态源——外部写入口（Picker / 跨会话恢复）改档后本组件无法感知。
  // 用递增计数器作为「外部状态已变」的显式 re-read 信号（比强行把 registry
  // 改造成响应式 store 改动面小一个量级）；若未来 SessionRuntimeRegistry 接入
  // 订阅模型，应删掉本 epoch 并改用真实依赖。可选优化项，本轮跳过结构性改造。
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
    () => resolveEffectiveThinkingTitle(sessionId, providerId, modelId),
    [sessionId, titleEpoch, providerId, modelId]
  );

  const handoff = useMemo(
    () => resolveThinkingHandoffSafe(providerId, modelId, storedTitle),
    [providerId, modelId, storedTitle, catalogVersion]
  );

  const showThinking = options.length > 0;

  // 生效档位 = 原选档位命中当前模型 thinking 声明才保留；未选 / 未命中 → 空（视为未选）。
  // 不做「解析 → 写回 → 再解析」：档位只由用户显式选择（selectLevel）写入，
  // 解析结果不反向落盘，失效档也不会被静默改成其他档（U1：不替用户找）。
  const currentTitle = handoff.selectedTitle ?? '';
  const needsThinkingPick = showThinking && currentTitle === '';
  const thinkingLabel = needsThinkingPick ? '请选择思考档位' : currentTitle;

  const selectLevel = useCallback(
    (title: string) => {
      persistThinkingSelection(sessionId, providerId, modelId, title);
      recordPendingContextState(sessionId);
      setTitleEpoch((n) => n + 1);
      setOpen(false);
    },
    [sessionId, providerId, modelId]
  );

  const menuOptions = options.map((o) => ({
    id: o.title,
    label: o.label,
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
      data-has-prefix={prefix ? 'true' : 'false'}
      data-has-thinking={showThinking ? 'true' : 'false'}
    >
      {prefix ? <div className={styles.prefix}>{prefix}</div> : null}
      {prefix && children ? (
        <span className={styles.divider} aria-hidden />
      ) : null}
      {children ? <div className={styles.left}>{children}</div> : null}
      {showThinking && children ? (
        <span className={styles.divider} aria-hidden />
      ) : null}
      {showThinking ? (
        <div className={styles.right} data-testid="composer-thinking-slot">
          <Tooltip
            content={`思考档位：${thinkingLabel}`}
            disabled={open}
            side="top"
          >
            <Button
              ref={btnRef}
              type="button"
              variant="ghost"
              className={`${styles.thinkBtn} ${open ? styles.isOpen : ''}`}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`思考档位：${thinkingLabel}`}
              data-testid="composer-thinking-trigger"
              data-thinking-unset={needsThinkingPick ? 'true' : 'false'}
              onClick={() => toggleExclusiveMenu(open, setOpen, btnRef.current)}
            >
              <span>{thinkingLabel}</span>
            </Button>
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
                  <Button
                    key={opt.id}
                    bare
                    type="button"
                    className={`${styles.item} ${selected ? styles.isSelected : ''}`}
                    role="menuitem"
                    onClick={() => {
                      opt.onClick?.();
                    }}
                  >
                    <span>{opt.label}</span>
                    {selected ? (
                      <AppIcon name="check" size={13}
                        className={styles.check}
                        aria-hidden="true" />
                    ) : null}
                  </Button>
                );
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

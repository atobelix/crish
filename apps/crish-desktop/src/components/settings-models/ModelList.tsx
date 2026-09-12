import React from 'react';

import {
  getActiveModelId,
  getActiveProfileId,
  clearActiveModelId,
} from '../../api/providerProfiles';
import { formatContextLabel } from '../../api/modelCatalogPure';
import { getModelMeta } from '../../api/modelCatalog';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import { getLiveModel } from '../../api/modelsCatalogLive';
import { Button, Switch, Tooltip } from '../ui';
import { ModelConfigPanel } from './ModelConfigPanel';
import type { CfgDraft } from './useModelProfilesState';
import {
  defaultLocalMutation,
  prepareCatalogWrite,
} from './catalogWriteGate';
import styles from './ModelsSettingsTab.module.css';
import { AppIcon } from '../ui/icons';

const CONFIGURE_LABEL = '配置';
const DELETE_LABEL = '删除';

/**
 * 模型条目列表：启用/删除走 store yaml 核；展示读 getLiveModel。
 * lastTest 仍来自连通性探测（非配置真源）。
 */
export const ModelList: React.FC<{
  providerId: string;
  modelsList: string[];
  modelsCount: number;
  modelFilter: string;
  configOpenId: string | null;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  openConfigFor: (model: string) => void;
  closeConfig: () => void;
  saveConfig: () => void | Promise<void>;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
  refresh: () => void;
  notify?: (ok: boolean, msg: string) => void;
  runAsLocalMutation?: <T>(fn: () => Promise<T> | T) => Promise<T>;
}> = ({
  providerId,
  modelsList,
  modelsCount,
  modelFilter,
  configOpenId,
  cfgDraft,
  setCfgDraft,
  openConfigFor,
  closeConfig,
  saveConfig,
  runTest,
  testBusy,
  refresh: _refresh,
  notify = () => {},
  runAsLocalMutation = defaultLocalMutation,
}) => {
  return (
    <div className={`${styles.mrdModelList} mrd-model-list`}>
      {modelsList.map((m) => {
        const model = getLiveModel(providerId, m);
        // lastTest 是连通性探测结果，不是 modalities/thinking/pricing 真源
        const lastTest = getModelMeta(providerId, m).lastTest;
        const off = model?.enabled === false;
        const tKey = `${providerId}::${m}`;
        const isLive =
          getActiveProfileId() === providerId && getActiveModelId() === m;
        const expanded = configOpenId === m && !!cfgDraft;
        const display =
          expanded && cfgDraft?.displayName?.trim()
            ? cfgDraft.displayName.trim()
            : (model?.displayName?.trim() || m);
        const liveCtxVal =
          expanded && cfgDraft
            ? (() => {
                const n = parseInt(
                  cfgDraft.contextLength.replace(/[^\d]/g, ''),
                  10
                );
                return Number.isFinite(n) && n > 0 ? n : model?.contextWindow;
              })()
            : model?.contextWindow;
        const liveCtxLabel = formatContextLabel(liveCtxVal);
        const showCtx = liveCtxLabel && liveCtxLabel !== '—';
        const hasTools = Boolean(model?.capabilities?.tools);
        const hasImage = Boolean(
          model?.modalities?.input?.includes('image') ||
            model?.capabilities?.image
        );
        const hasVideo = Boolean(
          model?.modalities?.input?.includes('video') ||
            model?.capabilities?.video
        );
        const hasReasoning = Boolean(
          (model?.thinking && Object.keys(model.thinking).length > 0) ||
            model?.capabilities?.reasoning
        );

        return (
          <div
            key={m}
            className={`${styles.mrdModelRow} mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''} ${expanded ? 'is-expanded' : ''}`}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (
                target.closest('.mrd-model-toggle') ||
                target.closest('.mrd-delete-btn')
              ) {
                return;
              }
              if (expanded) closeConfig();
              else openConfigFor(m);
            }}
          >
            <div className={`${styles.mrdModelRowInner} mrd-model-row-inner`}>
              <div className={`${styles.mrdModelInfo} mrd-model-info`}>
                <span className={`${styles.mrdModelName} mrd-model-name`}>
                  {display}
                </span>
                <div className="mrd-model-meta">
                  {showCtx && (
                    <span className={`${styles.mrdCtxPill} mrd-ctx-pill`}>
                      {liveCtxLabel}
                    </span>
                  )}
                  {hasTools && (
                    <span
                      className={`${styles.mrdCapTag} mrd-cap-tag`}
                      aria-label="支持工具调用"
                    >
                      <AppIcon name="wrench" size={10} />
                    </span>
                  )}
                  {hasImage && (
                    <span
                      className={`${styles.mrdCapTag} mrd-cap-tag`}
                      aria-label="支持图片理解"
                    >
                      <AppIcon name="image" size={10} />
                    </span>
                  )}
                  {hasVideo && (
                    <span
                      className={`${styles.mrdCapTag} mrd-cap-tag`}
                      aria-label="支持视频理解"
                    >
                      <AppIcon name="video" size={10} />
                    </span>
                  )}
                  {hasReasoning && (
                    <span
                      className={`${styles.mrdCapTag} mrd-cap-tag`}
                      aria-label="支持思考"
                    >
                      <AppIcon name="brain-circuit" size={10} />
                    </span>
                  )}
                </div>
              </div>
              <div className={`${styles.mrdModelActions} mrd-model-actions`}>
                {lastTest && (
                  <Tooltip
                    content={
                      lastTest.error ||
                      (lastTest.ok ? '连通性正常' : '连通性异常')
                    }
                  >
                    <span
                      className={styles.mrdLatencyBadge}
                      data-latency={
                        !lastTest.ok
                          ? 'fail'
                          : (lastTest.latencyMs || 0) < 400
                            ? 'fast'
                            : (lastTest.latencyMs || 0) < 1200
                              ? 'mid'
                              : 'slow'
                      }
                    >
                      {lastTest.ok
                        ? `${lastTest.latencyMs}ms`
                        : lastTest.error?.includes('超时') ||
                            lastTest.error?.includes('timeout')
                          ? '超时'
                          : '失败'}
                    </span>
                  </Tooltip>
                )}

                <Tooltip content="检查网络连通性与延迟">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="检查连通性"
                    disabled={testBusy === `${providerId}::${m}`}
                    className={styles.mrdRowMiniBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runTest(m);
                    }}
                    icon={
                      testBusy === `${providerId}::${m}` ? (
                        <AppIcon name="loader" size={13} className={styles.loadingSpinner} />
                      ) : (
                        <AppIcon name="wifi" size={13} />
                      )
                    }
                  />
                </Tooltip>
                <Tooltip content={off ? '已停用，点击启用' : '点击停用'}>
                  <Switch
                    size="sm"
                    className="mrd-model-toggle"
                    checked={!off}
                    aria-label={off ? '启用模型' : '停用模型'}
                    onCheckedChange={(checked) => {
                      void runAsLocalMutation(async () => {
                        const ready = await prepareCatalogWrite();
                        if (!ready.ok) {
                          notify(false, ready.error);
                          return;
                        }
                        try {
                          const res = await modelsCatalogStore.updateModel(
                            providerId,
                            m,
                            { enabled: checked }
                          );
                          if (!res.ok) {
                            notify(false, res.error || '启用状态保存失败');
                          }
                        } catch (e) {
                          notify(
                            false,
                            e instanceof Error ? e.message : String(e)
                          );
                        }
                      });
                    }}
                  />
                </Tooltip>
                <Tooltip content={CONFIGURE_LABEL}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={CONFIGURE_LABEL}
                    className={
                      expanded
                        ? `${styles.mrdRowMiniBtn} ${styles.mrdRowMiniBtnActive}`
                        : styles.mrdRowMiniBtn
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (expanded) closeConfig();
                      else openConfigFor(m);
                    }}
                    icon={<AppIcon name="sliders" size={13} />}
                  />
                </Tooltip>
                <Tooltip content={DELETE_LABEL}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={DELETE_LABEL}
                    className={`mrd-delete-btn ${styles.mrdRowMiniBtn}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runAsLocalMutation(async () => {
                        const ready = await prepareCatalogWrite();
                        if (!ready.ok) {
                          notify(false, ready.error);
                          return;
                        }
                        try {
                          const res = await modelsCatalogStore.removeModel(
                            providerId,
                            m
                          );
                          if (!res.ok) {
                            notify(false, res.error || '删除失败');
                            return;
                          }
                          if (configOpenId === m) closeConfig();
                          if (
                            getActiveProfileId() === providerId &&
                            getActiveModelId() === m
                          ) {
                            clearActiveModelId();
                          }
                        } catch (err) {
                          notify(
                            false,
                            err instanceof Error ? err.message : String(err)
                          );
                        }
                      });
                    }}
                    icon={<AppIcon name="trash" size={13} />}
                  />
                </Tooltip>
              </div>
            </div>

            {expanded && cfgDraft && (
              <ModelConfigPanel
                modelId={m}
                cfgDraft={cfgDraft}
                setCfgDraft={setCfgDraft}
                closeConfig={closeConfig}
                saveConfig={saveConfig}
              />
            )}
          </div>
        );
      })}

      {modelsCount === 0 && (
        <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>
          暂无模型 · 点击右上角「+」手动添加
        </div>
      )}
      {modelsCount > 0 && modelsList.length === 0 && (
        <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>
          无匹配的「{modelFilter.trim()}」
        </div>
      )}
    </div>
  );
};

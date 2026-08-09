import React from 'react';
import * as Lucide from 'lucide-react';
import {
  getActiveModelId,
  getActiveProfileId,
  removeModelFromProfile,
} from '../../api/providerProfiles';
import {
  formatContextLabel,
  formatModelDisplayName,
  getModelMeta,
  setModelEnabled,
} from '../../api/modelCatalog';
import { Button, Tooltip } from '../ui';
import { ModelConfigPanel } from './ModelConfigPanel';
import type { CfgDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

// 无名称图标按钮文案（同源约定）：aria-label 与 Tooltip content 同引用，禁止两处各写
const CONFIGURE_LABEL = '配置';
const DELETE_LABEL = '删除';

/**
 * 模型条目列表：行内启用开关（私有 toggleThumb，T11 ui/Switch 合入后随替换消亡）、
 * 配置 / 删除、展开配置子面板与空态。
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
  saveConfig: () => void;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
  refresh: () => void;
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
  refresh,
}) => {
  return (
    <div className={`${styles.mrdModelList} mrd-model-list`}>
      {modelsList.map((m) => {
        const meta = getModelMeta(providerId, m);
        const off = meta.enabled === false;
        const tKey = `${providerId}::${m}`;
        const isLive =
          getActiveProfileId() === providerId &&
          getActiveModelId() === m;
        const expanded = configOpenId === m && !!cfgDraft;
        const display =
          expanded && cfgDraft?.displayName?.trim()
            ? cfgDraft.displayName.trim()
            : formatModelDisplayName(providerId, m, meta);
        const liveCtxVal =
          expanded && cfgDraft
            ? (() => {
                const n = parseInt(
                  cfgDraft.contextLength.replace(/[^\d]/g, ''),
                  10
                );
                return Number.isFinite(n) && n > 0
                  ? n
                  : meta.contextLength;
              })()
            : meta.contextLength;
        const liveCtxLabel = formatContextLabel(liveCtxVal);
        const showCtx = liveCtxLabel && liveCtxLabel !== '—';

        return (
          <div
            key={m}
            className={`${styles.mrdModelRow} mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''} ${expanded ? 'is-expanded' : ''}`}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (
                target.closest('.models-switch') ||
                target.closest('.mrd-delete-btn')
              ) {
                return;
              }
              if (expanded) closeConfig();
              else openConfigFor(m);
            }}
            style={{ cursor: 'pointer' }}
          >
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
                {meta.capabilities?.tools && (
                  <span
                    className={`${styles.mrdCapTag} mrd-cap-tag`}
                    aria-label="支持工具调用"
                  >
                    <Lucide.Wrench size={10} />
                  </span>
                )}
                {meta.capabilities?.vision && (
                  <span
                    className={`${styles.mrdCapTag} mrd-cap-tag`}
                    aria-label="支持视觉"
                  >
                    <Lucide.Eye size={10} />
                  </span>
                )}
                {meta.capabilities?.reasoning && (
                  <span
                    className={`${styles.mrdCapTag} mrd-cap-tag`}
                    aria-label="支持思考"
                  >
                    <Lucide.BrainCircuit size={10} />
                  </span>
                )}
              </div>
            </div>
            <div
              className={`${styles.mrdModelActions} mrd-model-actions`}
            >
              <Tooltip content={off ? '已停用，点击启用' : '点击停用'}>
                <button
                  type="button"
                  className={`${styles.modelRowToggle} ${!off ? styles.active : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setModelEnabled(providerId, m, off);
                    refresh();
                  }}
                  aria-label={off ? '启用模型' : '停用模型'}
                >
                  <span className={styles.toggleThumb} />
                </button>
              </Tooltip>
              <Tooltip content={CONFIGURE_LABEL}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={CONFIGURE_LABEL}
                  style={{
                    padding: '0 5px',
                    height: '26px',
                    color: expanded
                      ? 'var(--accent-primary)'
                      : 'var(--text-tertiary)',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (expanded) closeConfig();
                    else openConfigFor(m);
                  }}
                  icon={<Lucide.SlidersHorizontal size={13} />}
                />
              </Tooltip>
              <Tooltip content={DELETE_LABEL}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={DELETE_LABEL}
                  className="mrd-delete-btn"
                  style={{
                    padding: '0 5px',
                    height: '26px',
                    color: 'var(--text-tertiary)',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeModelFromProfile(providerId, m);
                    if (configOpenId === m) closeConfig();
                    refresh();
                  }}
                  icon={<Lucide.Trash2 size={13} />}
                />
              </Tooltip>
            </div>

            {/* Expanded config sub-panel */}
            {expanded && cfgDraft && (
              <ModelConfigPanel
                modelId={m}
                cfgDraft={cfgDraft}
                setCfgDraft={setCfgDraft}
                meta={meta}
                tKey={tKey}
                testBusy={testBusy}
                runTest={runTest}
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

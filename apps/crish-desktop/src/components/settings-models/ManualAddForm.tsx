import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Button, Input } from '../ui';
import { ModelModalitiesEditor } from './ModelModalitiesEditor';
import {
  ModelThinkingEditor,
  STANDARD_THINKING_PRESET,
} from './ModelThinkingEditor';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { getLiveModel } from '../../api/modelsCatalogLive';
import { formatContextLabel } from '../../api/modelCatalogPure';
import { calculateAutofillDraft } from './manualAddAutofill';
import type { AddDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

/**
 * 手动添加模型表单（与配置面板 1:1 对齐一等公民设计）：
 * - 模型 ID 行支持内联在线获取按钮（移除右上旧独立按钮）
 * - 下拉联想严格限定在线探测到的模型，杜绝猜测兜底
 * - 智能预填：当输入或选定模型 ID 时自动匹配最新官方参数（展示名/上下文/输出/多模态/思考档位/计费）
 * - 字段与 ModelConfigPanel 完全统一：展示名称 / 上下文长度 / 最大输出 / 多模态矩阵 / 思考档位表
 */
export const ManualAddForm: React.FC<{
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  handleManualAdd: () => void;
  setManualOpen: (val: boolean) => void;
  runScan?: () => Promise<void>;
  scanBusy?: boolean;
  providerVendor?: string;
  /** 探针在线模型列表（建议源，非内置字典） */
  scannedModels?: string[];
  /** 该供应商已配置模型（与探针并集） */
  existingModels?: string[];
}> = ({
  addDraft,
  setAddDraft,
  handleManualAdd,
  setManualOpen,
  runScan,
  scanBusy,
  providerVendor,
  scannedModels = [],
  existingModels = [],
}) => {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // 挂载即确保字典镜像就绪
  useEffect(() => {
    void ensureModelsCatalogLoaded();
  }, []);

  // 在线探测结果 ∪ 该供应商已配置模型
  const onlineIds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...scannedModels, ...existingModels]) {
      const k = id.trim().toLowerCase();
      if (id.trim() && !seen.has(k)) {
        seen.add(k);
        out.push(id.trim());
      }
    }
    return out;
  }, [scannedModels, existingModels]);

  // 用户裁决：下拉列表只展示在线获取模型列表的选项，不要展示猜测的模型
  const suggestions = useMemo(() => {
    const kw = addDraft.modelId.trim().toLowerCase();
    if (onlineIds.length > 0) {
      const matched = kw
        ? onlineIds.filter(
            (id) =>
              id.toLowerCase().includes(kw) ||
              (getLiveModel(providerVendor ?? '', id)?.displayName || '')
                .toLowerCase()
                .includes(kw)
          )
        : onlineIds;
      return matched.slice(0, 10);
    }
    return [];
  }, [addDraft.modelId, onlineIds, providerVendor]);

  // 更新浮层相对于视口的准确定位
  const updateDropdownPos = useCallback(() => {
    if (inputContainerRef.current) {
      const rect = inputContainerRef.current.getBoundingClientRect();
      setDropdownRect({
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 280),
      });
    }
  }, []);

  useEffect(() => {
    if (showSuggestions) {
      updateDropdownPos();
      window.addEventListener('app:window-resize-settled', updateDropdownPos, {
        passive: true,
      });
      window.addEventListener('scroll', updateDropdownPos, true);
      return () => {
        window.removeEventListener(
          'app:window-resize-settled',
          updateDropdownPos
        );
        window.removeEventListener('scroll', updateDropdownPos, true);
      };
    }
    return undefined;
  }, [showSuggestions, updateDropdownPos]);

  // 点击外部关闭下拉提示
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        inputContainerRef.current &&
        !inputContainerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const applyAutofill = useCallback(
    (id: string) => {
      setAddDraft((prev) => calculateAutofillDraft(id, providerVendor, prev));
    },
    [providerVendor, setAddDraft]
  );

  const handleSelectSuggestion = (id: string) => {
    setAddDraft((prev) =>
      calculateAutofillDraft(id, providerVendor, prev, { isSelection: true })
    );
    setShowSuggestions(false);
  };

  return (
    <div className={`${styles.mrdAddForm} mrd-add-form`}>
      <div className={styles.mrdAddHeaderRow}>
        <span className={styles.mrdAddHeaderLabel}>手动添加模型</span>
      </div>

      <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
        {/* 模型 ID 智能输入行（集成在线获取） */}
        <div ref={inputContainerRef} className={styles.mrdAddModelIdField}>
          <div className={styles.mrdAddModelIdHeader}>
            <span className={styles.mrdAddModelIdLabel}>模型 ID *</span>
            {runScan && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={scanBusy}
                onClick={() => void runScan()}
                aria-label="在线获取"
                className={styles.mrdAddScanBtn}
                icon={
                  scanBusy ? (
                    <Lucide.Loader2
                      size={11}
                      className={styles.loadingSpinner}
                    />
                  ) : (
                    <Lucide.RefreshCw size={11} />
                  )
                }
              >
                {scanBusy ? '探测中...' : '在线获取'}
              </Button>
            )}
          </div>
          <Input
            size="sm"
            placeholder="输入或选择，如 gpt-5.6-sol"
            value={addDraft.modelId}
            onChange={(e) => {
              const val = e.target.value;
              setAddDraft((d) => ({ ...d, modelId: val }));
              setShowSuggestions(true);
              updateDropdownPos();
            }}
            onFocus={() => {
              setShowSuggestions(true);
              updateDropdownPos();
            }}
            onBlur={() => {
              if (addDraft.modelId.trim()) {
                applyAutofill(addDraft.modelId.trim());
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowSuggestions(false);
            }}
            spellCheck={false}
          />
        </div>

        {/* 浮动智能补全菜单：仅渲染在线获取/已配置模型，无猜测 */}
        {showSuggestions &&
          suggestions.length > 0 &&
          dropdownRect &&
          createPortal(
            <div
              ref={dropdownRef}
              className={styles.mrdAddSuggestMenu}
              // 动态几何（视口定位）保留 style：静态视觉规则在 module CSS
              style={{
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {suggestions.map((id) => {
                const live = getLiveModel(providerVendor ?? '', id);
                const name = live?.displayName || id;
                return (
                  <div
                    key={id}
                    className={styles.mrdAddSuggestItem}
                    onClick={() => handleSelectSuggestion(id)}
                  >
                    <div className={styles.mrdAddSuggestMeta}>
                      <span className={styles.mrdAddSuggestId}>{id}</span>
                      <span className={styles.mrdAddSuggestName}>{name}</span>
                    </div>
                    <span className={styles.mrdAddSuggestCtx}>
                      {live?.contextWindow != null
                        ? formatContextLabel(live.contextWindow)
                        : ''}
                    </span>
                  </div>
                );
              })}
            </div>,
            document.body
          )}

        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>展示名称</span>
          <Input
            size="sm"
            placeholder="自定义展示名"
            value={addDraft.displayName}
            onChange={(e) =>
              setAddDraft((d) => ({ ...d, displayName: e.target.value }))
            }
          />
        </label>

        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>上下文长度</span>
          <Input
            size="sm"
            placeholder="如 128000"
            value={addDraft.contextLength}
            onChange={(e) =>
              setAddDraft((d) => ({ ...d, contextLength: e.target.value }))
            }
          />
        </label>

        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>最大输出</span>
          <Input
            size="sm"
            placeholder="如 4096 / 8192"
            value={addDraft.maxOutputTokens || ''}
            onChange={(e) =>
              setAddDraft((d) => ({ ...d, maxOutputTokens: e.target.value }))
            }
          />
        </label>
      </div>

      {/* 多模态矩阵编辑器（一等公民） */}
      <ModelModalitiesEditor
        modalities={
          addDraft.modalities || {
            input: ['text', 'image'],
            output: ['text'],
          }
        }
        onChange={(next) =>
          setAddDraft((d) => ({ ...d, modalities: next }))
        }
        onSyncCaps={(capsPatch) =>
          setAddDraft((d) => ({
            ...d,
            caps: { ...d.caps, ...capsPatch },
          }))
        }
      />

      {/* 思考推理档位编辑器 */}
      {addDraft.thinkingEnabled ? (
        <div className={styles.mrdAddThinkingWrap}>
          <div className={styles.mrdAddThinkingClose}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                setAddDraft((d) => ({
                  ...d,
                  thinkingEnabled: false,
                  caps: { ...d.caps, reasoning: false },
                }))
              }
              className={styles.mrdAddThinkingCloseBtn}
            >
              关闭思考
            </Button>
          </div>
          <ModelThinkingEditor
            enabled={true}
            thinkingMap={addDraft.thinkingMap || STANDARD_THINKING_PRESET}
            onChange={(map) =>
              setAddDraft((d) => ({ ...d, thinkingMap: map }))
            }
          />
        </div>
      ) : (
        <div className={styles.mrdAddThinkingOffRow}>
          <span className={styles.mrdAddThinkingOffLabel}>思考推理</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              setAddDraft((d) => ({
                ...d,
                thinkingEnabled: true,
                thinkingMap: { ...STANDARD_THINKING_PRESET },
                caps: { ...d.caps, reasoning: true },
              }))
            }
            icon={<Lucide.Plus size={11} />}
            className={styles.mrdAddThinkingOffBtn}
          >
            配置思考档位
          </Button>
        </div>
      )}

      {/* 底部操作区 */}
      <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
        <div className={styles.mrdAddFooterActions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setManualOpen(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!addDraft.modelId.trim()}
            onClick={handleManualAdd}
          >
            添加模型
          </Button>
        </div>
      </div>
    </div>
  );
};

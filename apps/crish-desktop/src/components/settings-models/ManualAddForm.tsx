import React, { useMemo, useRef, useState, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';

import { Button, Input } from '../ui';
import { ModelModalitiesEditor } from './ModelModalitiesEditor';
import { ModelThinkingSection } from './ModelThinkingSection';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { getLiveModel } from '../../api/modelsCatalogLive';
import { formatContextLabel } from '../../api/modelCatalogPure';
import { calculateAutofillDraft } from './manualAddAutofill';
import type { AddDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';
import { AppIcon } from '../ui/icons/index';

/**
 * 手动添加模型表单，字段与已有模型配置弹窗一致。
 * 模型标识行内联在线获取；联想只用来自探测和已配置列表。
 * 已知模型自动带出展示名、上下文、多模态和思考档位。
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
  /** 放进弹窗时去掉内嵌卡片和标题 */
  plain?: boolean;
  /** 弹窗底栏自己放按钮时关掉表单内按钮 */
  showActions?: boolean;
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
  plain = false,
  showActions = true,
}) => {
  const inputId = useId();
  const listboxId = useId();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
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
  const activeSuggestionIndex = activeSuggestionId
    ? suggestions.indexOf(activeSuggestionId)
    : -1;
  const activeOptionId =
    activeSuggestionIndex >= 0
      ? `${listboxId}-option-${activeSuggestionIndex}`
      : undefined;
  const isSuggestionMenuOpen =
    showSuggestions && suggestions.length > 0 && dropdownRect !== null;

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
        setActiveSuggestionId(null);
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
    setActiveSuggestionId(null);
    setShowSuggestions(false);
  };

  const handleModelIdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process') {
      return;
    }

    if (e.key === 'Escape') {
      if (showSuggestions) {
        e.preventDefault();
        setActiveSuggestionId(null);
        setShowSuggestions(false);
      }
      return;
    }

    if (suggestions.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setShowSuggestions(true);
      updateDropdownPos();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      const start = activeSuggestionIndex < 0 ? (direction > 0 ? -1 : 0) : activeSuggestionIndex;
      const nextIndex = (start + direction + suggestions.length) % suggestions.length;
      setActiveSuggestionId(suggestions[nextIndex] ?? null);
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      if (!isSuggestionMenuOpen) return;
      e.preventDefault();
      const nextIndex = e.key === 'Home' ? 0 : suggestions.length - 1;
      setActiveSuggestionId(suggestions[nextIndex] ?? null);
      return;
    }

    if (e.key === 'Enter' && isSuggestionMenuOpen && activeSuggestionIndex >= 0) {
      e.preventDefault();
      const selected = suggestions[activeSuggestionIndex];
      if (selected) handleSelectSuggestion(selected);
    }
  };

  return (
    <div
      className={
        plain
          ? `${styles.mrdAddForm} ${styles.mrdAddFormPlain} mrd-add-form`
          : `${styles.mrdAddForm} mrd-add-form`
      }
    >
      {plain ? null : (
        <div className={styles.mrdAddHeaderRow}>
          <span className={styles.mrdAddHeaderLabel}>手动添加模型</span>
        </div>
      )}

      <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
        {/* 模型 ID 智能输入行（集成在线获取） */}
        <div ref={inputContainerRef} className={styles.mrdAddModelIdField}>
          <div className={styles.mrdAddModelIdHeader}>
            <label
              htmlFor={inputId}
              className={styles.mrdAddModelIdLabel}
            >
              模型 ID *
            </label>
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
                    <AppIcon name="loader" size={11}
                      className={styles.loadingSpinner} />
                  ) : (
                    <AppIcon name="refresh" size={11} />
                  )
                }
              >
                {scanBusy ? '探测中...' : '在线获取'}
              </Button>
            )}
          </div>
          <Input
            id={inputId}
            size="sm"
            placeholder="输入或选择，如 gpt-5.6-sol"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isSuggestionMenuOpen}
            aria-controls={isSuggestionMenuOpen ? listboxId : undefined}
            aria-activedescendant={isSuggestionMenuOpen ? activeOptionId : undefined}
            value={addDraft.modelId}
            onChange={(e) => {
              const val = e.target.value;
              setAddDraft((d) => ({ ...d, modelId: val }));
              setActiveSuggestionId(null);
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
              setActiveSuggestionId(null);
              setShowSuggestions(false);
            }}
            onKeyDown={handleModelIdKeyDown}
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
              data-floating-layer=""
              id={listboxId}
              role="listbox"
              aria-label="模型建议"
              // 动态几何（视口定位）保留 style：静态视觉规则在 module CSS
              style={{
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {suggestions.map((id, index) => {
                const live = getLiveModel(providerVendor ?? '', id);
                const name = live?.displayName || id;
                const isActive = index === activeSuggestionIndex;
                return (
                  <div
                    key={id}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={isActive}
                    className={`${styles.mrdAddSuggestItem}${isActive ? ` ${styles.mrdAddSuggestItemActive}` : ''}`}
                    onMouseMove={() => setActiveSuggestionId(id)}
                    onMouseDown={(e) => e.preventDefault()}
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
            value={addDraft.contextWindow}
            onChange={(e) =>
              setAddDraft((d) => ({ ...d, contextWindow: e.target.value }))
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

      {/* 多模态矩阵编辑器（一等公民）；modalities 是能力唯一真源 */}
      <ModelModalitiesEditor
        modalities={
          addDraft.modalities || {
            input: ['text'],
            output: ['text'],
          }
        }
        onChange={(next) =>
          setAddDraft((d) => ({ ...d, modalities: next }))
        }
      />

      <ModelThinkingSection
        enabled={addDraft.thinkingEnabled === true}
        thinkingMap={addDraft.thinkingMap}
        onChange={({ enabled, thinkingMap }) =>
          setAddDraft((d) => ({
            ...d,
            thinkingEnabled: enabled,
            thinkingMap,
          }))
        }
      />

      {showActions ? (
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
      ) : null}
    </div>
  );
};

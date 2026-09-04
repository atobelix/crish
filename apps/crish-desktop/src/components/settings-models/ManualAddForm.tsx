import React, { useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Button, Input } from '../ui';
import { CapEditor } from './CapEditor';
import {
  searchCatalogModels,
  ensureModelsCatalogLoaded,
  type CatalogModelSpec,
} from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { formatContextLabel } from '../../api/modelCatalogPure';
import type { AddDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

/**
 * 手动添加模型表单
 * 支持：在线探测快捷拉起、模型 ID 智能输入补全（Portal 浮层设计，零容器内部撑开与滚动条）、能力与参数智能预填
 */
export const ManualAddForm: React.FC<{
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  handleManualAdd: () => void;
  setManualOpen: (val: boolean) => void;
  runScan?: () => Promise<void>;
  scanBusy?: boolean;
  providerVendor?: string;
}> = ({
  addDraft,
  setAddDraft,
  handleManualAdd,
  setManualOpen,
  runScan,
  scanBusy,
  providerVendor,
}) => {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // 挂载即确保字典镜像就绪（真源 = ~/.conex/models.yaml；幂等单飞）
  useEffect(() => {
    void ensureModelsCatalogLoaded();
  }, []);

  // 字典镜像版本变化（重载/重置）驱动联想重算
  const catalogVersion = useModelsCatalogVersion();

  // 搜索匹配字典模型（限定 8 条以保持紧凑）
  const suggestions = useMemo(() => {
    return searchCatalogModels(addDraft.modelId, providerVendor).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogVersion 仅作重算信号
  }, [addDraft.modelId, providerVendor, catalogVersion]);

  // 更新浮层相对于视口的准确定位
  const updateDropdownPos = () => {
    if (inputContainerRef.current) {
      const rect = inputContainerRef.current.getBoundingClientRect();
      setDropdownRect({
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 280),
      });
    }
  };

  useEffect(() => {
    if (showSuggestions) {
      updateDropdownPos();
      window.addEventListener('resize', updateDropdownPos);
      window.addEventListener('scroll', updateDropdownPos, true);
      return () => {
        window.removeEventListener('resize', updateDropdownPos);
        window.removeEventListener('scroll', updateDropdownPos, true);
      };
    }
    return undefined;
  }, [showSuggestions]);

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

  const handleSelectSuggestion = (spec: CatalogModelSpec) => {
    setAddDraft((prev) => ({
      ...prev,
      modelId: spec.model,
      displayName: spec.displayName ?? '',
      contextLength: spec.contextWindow != null ? String(spec.contextWindow) : prev.contextLength,
      maxOutputTokens:
        spec.maxOutputTokens != null ? String(spec.maxOutputTokens) : prev.maxOutputTokens,
      caps: {
        tools: Boolean(spec.capabilities?.tools ?? prev.caps.tools),
        image: Boolean(spec.capabilities?.image ?? prev.caps.image),
        video: Boolean(spec.capabilities?.video ?? prev.caps.video),
        reasoning: Boolean(spec.capabilities?.reasoning ?? prev.caps.reasoning),
      },
      protocol: spec.protocol,
    }));
    setShowSuggestions(false);
  };

  return (
    <div className={`${styles.mrdAddForm} mrd-add-form`}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-xs, 12px)', fontWeight: 500 }}>
          手动添加模型
        </span>
        {runScan && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={scanBusy}
            onClick={() => void runScan()}
            icon={
              scanBusy ? (
                <Lucide.Loader2 size={12} className={styles.loadingSpinner} />
              ) : (
                <Lucide.Sparkles size={12} style={{ color: 'var(--brand, #10b981)' }} />
              )
            }
          >
            在线获取模型列表
          </Button>
        )}
      </div>

      <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
        {/* 模型 ID 智能补全 Combobox */}
        <div ref={inputContainerRef} style={{ position: 'relative', flex: 1, minWidth: '160px' }}>
          <label className={`${styles.mrdAddLabel} mrd-add-label`}>
            <span>模型 ID *</span>
            <Input
              size="sm"
              placeholder="输入或选择，如 gpt-5.6-sol"
              value={addDraft.modelId}
              onChange={(e) => {
                setAddDraft((d) => ({ ...d, modelId: e.target.value }));
                setShowSuggestions(true);
                updateDropdownPos();
              }}
              onFocus={() => {
                setShowSuggestions(true);
                updateDropdownPos();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShowSuggestions(false);
              }}
              spellCheck={false}
              style={{ background: '#ffffff' }}
            />
          </label>
        </div>

        {/* 浮动智能补全菜单：采用 createPortal 逃逸挂载，杜绝撑开内部容器与诱发滚动条 */}
        {showSuggestions &&
          suggestions.length > 0 &&
          dropdownRect &&
          createPortal(
            <div
              ref={dropdownRef}
              style={{
                position: 'fixed',
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
                zIndex: 'var(--z-tooltip, 9000)',
                background: 'var(--bg-card, #ffffff)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md, 8px)',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
                maxHeight: '210px',
                overflowY: 'auto',
                padding: '4px',
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {suggestions.map((item) => (
                <div
                  key={item.model}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm, 6px)',
                    cursor: 'pointer',
                    gap: '8px',
                    fontSize: 'var(--font-size-xs, 12px)',
                    transition: 'background var(--duration-fast, 150ms) ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => handleSelectSuggestion(item)}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 500, color: 'var(--text-primary)' }}>
                      {item.model}
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.displayName}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: '4px',
                      background: 'var(--bg-subtle)',
                      color: 'var(--text-tertiary)',
                      border: '1px solid var(--border-subtle)',
                      flexShrink: 0,
                    }}
                  >
                    {item.contextWindow != null ? formatContextLabel(item.contextWindow) : ''}
                  </span>
                </div>
              ))}
            </div>,
            document.body
          )}

        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>展示名称</span>
          <Input
            size="sm"
            placeholder="自定义展示名"
            value={addDraft.displayName}
            onChange={(e) => setAddDraft((d) => ({ ...d, displayName: e.target.value }))}
            style={{ background: '#ffffff' }}
          />
        </label>

        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>上下文长度</span>
          <Input
            size="sm"
            placeholder="如 128000"
            value={addDraft.contextLength}
            onChange={(e) => setAddDraft((d) => ({ ...d, contextLength: e.target.value }))}
            style={{ background: '#ffffff' }}
          />
        </label>
      </div>

      <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
        <CapEditor
          caps={addDraft.caps}
          onCapChange={(key, checked) =>
            setAddDraft((d) => ({
              ...d,
              caps: { ...d.caps, [key]: checked },
            }))
          }
        />
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
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

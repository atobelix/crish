import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Button, Dialog, Input, Tooltip } from '@/components/ui';
import styles from './ScanResultsModal.module.css';
import { AppIcon } from '@/components/ui/icons';

export interface ScanResultsModalProps {
  open: boolean;
  onClose: () => void;
  providerName: string;
  scannedModels: string[];
  existingModels: string[];
  onConfirm: (selectedModels: string[]) => void;
}

export const ScanResultsModal: React.FC<ScanResultsModalProps> = ({
  open,
  onClose,
  providerName,
  scannedModels,
  existingModels,
  onConfirm,
}) => {
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [filterQuery, setFilterQuery] = useState('');

  // 多选手势与快捷键状态引用
  const lastSelectedIndexRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragTargetStateRef = useRef<boolean>(true);

  const existingSet = useMemo(() => new Set(existingModels), [existingModels]);

  // 打开时默认优先勾选尚未添加的新模型
  useEffect(() => {
    if (open) {
      const nextSet = new Set<string>();
      for (const m of scannedModels) {
        if (!existingSet.has(m)) {
          nextSet.add(m);
        }
      }
      setSelectedSet(nextSet);
      setFilterQuery('');
      lastSelectedIndexRef.current = null;
      isDraggingRef.current = false;
    }
  }, [open, scannedModels, existingSet]);

  // 全局鼠标松开监听，结束滑动选择
  useEffect(() => {
    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // 过滤后的模型列表
  const filteredModels = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return scannedModels;
    return scannedModels.filter((m) => m.toLowerCase().includes(q));
  }, [scannedModels, filterQuery]);

  // 快捷动作
  const handleSelectAll = () => {
    setSelectedSet(new Set(scannedModels));
  };

  const handleSelectNewOnly = () => {
    const nextSet = new Set<string>();
    for (const m of scannedModels) {
      if (!existingSet.has(m)) nextSet.add(m);
    }
    setSelectedSet(nextSet);
  };

  const handleClearAll = () => {
    setSelectedSet(new Set());
  };

  // 鼠标点击逻辑（支持 Shift 范围多选、Ctrl / Cmd 单选切换）
  const handleRowMouseDown = (
    e: React.MouseEvent,
    index: number,
    modelId: string
  ) => {
    if (e.button !== 0) return; // 仅限鼠标左键

    // 1. Shift 范围选择 (Range Select)
    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      e.preventDefault();
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      const rangeModels = filteredModels.slice(start, end + 1);

      setSelectedSet((prev) => {
        const next = new Set(prev);
        for (const m of rangeModels) {
          next.add(m);
        }
        return next;
      });
      lastSelectedIndexRef.current = index;
      return;
    }

    // 2. 正常点击或按住鼠标准备滑动多选
    const willSelect = !selectedSet.has(modelId);
    dragTargetStateRef.current = willSelect;
    isDraggingRef.current = true;
    lastSelectedIndexRef.current = index;

    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (willSelect) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  };

  // 鼠标滑入逻辑（按住鼠标滑动批量多选）
  const handleRowMouseEnter = (index: number, modelId: string) => {
    if (!isDraggingRef.current) return;
    const shouldAdd = dragTargetStateRef.current;

    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (shouldAdd) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
    lastSelectedIndexRef.current = index;
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selectedSet));
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={<span>模型列表 · {providerName}</span>}
      footer={
        <div className={styles.footerBar}>
          <span className={styles.footerCount}>
            共 {scannedModels.length} 个模型 · 已选 {selectedSet.size} 项
          </span>
          <div className={styles.footerActions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={selectedSet.size === 0}
              onClick={handleConfirm}
            >
              同步所选 ({selectedSet.size})
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.dialogContent}>
        {/* 顶部过滤搜索与快捷动作按钮 */}
        <div className={styles.topBar}>
          <Input
            variant="search"
            size="xs"
            placeholder="搜索模型…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            clearable
            onClear={() => setFilterQuery('')}
            className={styles.searchInputWrapper}
          />
          <div className={styles.quickActions}>
            <Button
              type="button"
              variant="plain"
              size="xs"
              onClick={handleSelectAll}
            >
              全选
            </Button>
            <Button
              type="button"
              variant="plain"
              size="xs"
              onClick={handleSelectNewOnly}
            >
              仅选新增
            </Button>
            <Button
              type="button"
              variant="plain"
              size="xs"
              onClick={handleClearAll}
            >
              清空
            </Button>
          </div>
        </div>

        {/* 模型列表 */}
        <div className={styles.listContainer}>
          {filteredModels.length === 0 ? (
            <div className={styles.emptyTip}>没有匹配的模型</div>
          ) : (
            filteredModels.map((m, index) => {
              const isChecked = selectedSet.has(m);
              const isExisting = existingSet.has(m);

              return (
                <div
                  key={m}
                  className={`${styles.modelRow} ${isChecked ? styles.modelRowSelected : ''}`}
                  onMouseDown={(e) => handleRowMouseDown(e, index, m)}
                  onMouseEnter={() => handleRowMouseEnter(index, m)}
                  role="checkbox"
                  aria-checked={isChecked}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      handleRowMouseDown({ button: 0 } as any, index, m);
                    }
                  }}
                >
                  <div className={styles.modelRowLeft}>
                    <div
                      className={`${styles.customCheckbox} ${
                        isChecked ? styles.customCheckboxChecked : ''
                      }`}
                    >
                      {isChecked && <AppIcon name="check" size={11} />}
                    </div>
                    <span className={styles.modelId}>{m}</span>
                  </div>

                  <div className={styles.modelRowRight}>
                    {isExisting && (
                      <Tooltip content="当前服务商中已存在该模型">
                        <span
                          className={styles.existingIcon}
                          aria-label="已存在"
                        >
                          <AppIcon name="check" size={14} />
                        </span>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Dialog>
  );
};

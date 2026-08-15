/**
 * 设置 · 用量：本会话统计、本机历史与模型单价；成功静默，仅错误提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsUsageTab.module.css';
import { loadPrices, type ModelPrice } from '../../api/pricingStore';
import {
  clearUsageHistory,
  loadUsageSnapshot,
  usageDaysForChart,
  type UsageSnapshot,
} from '../../api/usageStore';
import { SettingsPage, SettingsSection, SettingsCard } from './SettingsUI';
import { Button, ConfirmDialog } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { PriceConfigModal } from './PriceConfigModal';
import { UsageChart } from './UsageChart';
import { UsageModelTable } from './UsageModelTable';
import { formatTokenCount, formatUsd } from './usageFormat';

type Props = {
  onShowToast: (msg: string) => void;
};

function safeLoadPrices(): { list: ModelPrice[]; error: string | null } {
  try {
    return { list: loadPrices(), error: null };
  } catch (err) {
    return { list: [], error: String(err) };
  }
}

export const SettingsUsageTab: React.FC<Props> = ({ onShowToast }) => {
  const [pricesModalOpen, setPricesModalOpen] = useState(false);
  const [priceList, setPriceList] = useState<ModelPrice[]>(
    () => safeLoadPrices().list
  );
  const [_pricesError, setPricesError] = useState<string | null>(null);
  const [history, setHistory] = useState<UsageSnapshot | null>(null);
  const [chartDays, setChartDays] = useState<7 | 14>(7);
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const handleClearHistory = useCallback(async () => {
    const ok = await confirmGate({
      title: '清空用量',
      description: '确定清空本机用量历史？不可撤销！',
      confirmLabel: '确认清空',
      danger: true,
    });
    if (!ok) return;
    setHistory(clearUsageHistory());
  }, [confirmGate]);

  const reloadPrices = useCallback(
    (announceToast: boolean) => {
      const { list, error } = safeLoadPrices();
      setPriceList(list);
      if (error) {
        setPricesError('定价表读取失败');
        if (announceToast) onShowToast('定价表读取失败');
      } else {
        setPricesError(null);
      }
    },
    [onShowToast]
  );

  useEffect(() => {
    reloadPrices(true);
  }, [reloadPrices]);

  // DEEPCHECK-02 P0：设置页加载时拉取运行时模型目录快照（catalog_get →
  // pricingStore 快照注入；版本号幂等 + 失败内部降级静态表，无需通知用户）
  useEffect(() => {
    let cancelled = false;
    void import('../../api/modelCatalog').then(({ fetchCatalogSnapshot }) => {
      if (!cancelled) void fetchCatalogSnapshot();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setHistory(loadUsageSnapshot());
  }, []);

  useEffect(() => {
    if (!pricesModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPricesModalOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pricesModalOpen]);

  const dayBars = useMemo(
    () => (history ? usageDaysForChart(chartDays, history) : []),
    [chartDays, history]
  );
  const dayMax = useMemo(() => {
    let m = 0;
    for (const d of dayBars) m = Math.max(m, d.input + d.output);
    return m || 1;
  }, [dayBars]);

  const headerMeta = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={styles.configBtn}
      onClick={() => setPricesModalOpen(true)}
      icon={<Lucide.DollarSign size={14} />}
    >
      配置单价
    </Button>
  );

  return (
    <SettingsPage title="用量" meta={headerMeta}>
      <SettingsSection title="历史统计">
        <SettingsCard>
          {history === null ? (
            <div className={styles.skeletonSection}>
              <div className={styles.skeletonBar} />
              <div className={styles.skeletonBar} />
              <div className={styles.skeletonBar} />
            </div>
          ) : (
            <>
              {/* Summary Cards */}
              <div className={styles.statsGrid}>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计输入</span>
                  <span className={styles.statValue}>
                    {formatTokenCount(history.totalInput)}{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计输出</span>
                  <span className={styles.statValue}>
                    {formatTokenCount(history.totalOutput)}{' '}
                    <span className={styles.statUnit}>tokens</span>
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>累计费用</span>
                  <span className={styles.statValueCost}>
                    {formatUsd(history.totalCost)}
                  </span>
                </div>
                {/* T-48：缓存列（P5 S7）——命中读取 / 缓存节省；无数据时隐藏 */}
                {history.totalCacheRead > 0 && (
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>缓存命中读取</span>
                    <span className={styles.statValue}>
                      {formatTokenCount(history.totalCacheRead)}{' '}
                      <span className={styles.statUnit}>tokens</span>
                    </span>
                  </div>
                )}
                {history.totalSavedCost > 0 && (
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>缓存节省</span>
                    <span className={styles.statValueCost}>
                      {formatUsd(history.totalSavedCost)}
                    </span>
                  </div>
                )}
              </div>

              {/* Daily Trend Chart */}
              <UsageChart
                chartDays={chartDays}
                dayBars={dayBars}
                dayMax={dayMax}
                onChartDays={setChartDays}
              />

              {/* Model Breakdown */}
              <UsageModelTable history={history} />

              {/* Bottom Actions */}
              <div className={styles.actionsBar}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.actionBtn}
                  onClick={() => setHistory(loadUsageSnapshot())}
                  icon={<Lucide.RefreshCw size={12} />}
                >
                  刷新数据
                </Button>
                {(history.totalInput > 0 || history.totalOutput > 0) && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className={styles.actionBtn}
                    icon={<Lucide.Trash2 size={12} />}
                    onClick={() => void handleClearHistory()}
                  >
                    清空历史
                  </Button>
                )}
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>
      <PriceConfigModal
        open={pricesModalOpen}
        priceList={priceList}
        onListChange={setPriceList}
        onClose={() => setPricesModalOpen(false)}
        onToast={onShowToast}
      />
      {/* 清空用量确认（Promise 桥渲染点） */}
      {renderConfirmGate(<ConfirmDialog />)}
    </SettingsPage>
  );
};

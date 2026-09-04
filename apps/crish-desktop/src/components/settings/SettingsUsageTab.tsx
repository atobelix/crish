import React, { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { loadPrices, type ModelPrice } from '../../api/pricingStore';
import {
  clearUsageHistory,
  getUsageDashboardData,
} from '../../api/usageApi';
import type { UsageDashboardDto } from '../../api/usageContracts';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { useToast } from '../../services/toast/ToastContext';
import { ConfirmDialog } from '../ui';
import { PriceConfigModal } from './PriceConfigModal';
import { SettingsPage } from './SettingsUI';
import { ActivityMatrixHeatmap } from './usage/ActivityMatrixHeatmap';
import { ModelDistributionSection } from './usage/ModelDistributionSection';
import { UsageSummaryHero } from './usage/UsageSummaryHero';
import { UsageTrendChart } from './usage/UsageTrendChart';
import styles from './SettingsUsageTab.module.css';

interface Props {
  _onBlockingOverlayChange?: (open: boolean) => void;
}

function safeLoadPrices(): { list: ModelPrice[]; error: string | null } {
  try {
    return { list: loadPrices(), error: null };
  } catch (err) {
    return { list: [], error: String(err) };
  }
}

export const SettingsUsageTab: React.FC<Props> = () => {
  const { showToast } = useToast();
  const [globalRange, setGlobalRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [dashboardData, setDashboardData] = useState<UsageDashboardDto | null>(null);
  const [loading, setLoading] = useState(true);

  const [pricesModalOpen, setPricesModalOpen] = useState(false);
  const [priceList, setPriceList] = useState<ModelPrice[]>(
    () => safeLoadPrices().list
  );

  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const loadData = useCallback(async (range: '24h' | '7d' | '30d') => {
    setLoading(true);
    try {
      const data = await getUsageDashboardData(range);
      setDashboardData(data);
    } catch {
      showToast('获取用量数据失败');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadData(globalRange);
  }, [globalRange, loadData]);

  const handleClearHistory = useCallback(async () => {
    const ok = await confirmGate({
      title: '清空用量历史',
      description: '确定清空本机所有用量历史记录？此操作不可撤销！',
      confirmLabel: '确认清空',
      danger: true,
    });
    if (!ok) return;

    const cleared = await clearUsageHistory();
    if (cleared) {
      showToast('用量历史已清空');
      void loadData(globalRange);
    } else {
      showToast('清空历史失败');
    }
  }, [confirmGate, globalRange, loadData, showToast]);

  const headerMeta = (
    <div className={styles.headerTools}>
      <div className={styles.segmented}>
        <button
          type="button"
          className={`${styles.segmentedBtn} ${globalRange === '24h' ? styles.segmentedBtnActive : ''}`}
          onClick={() => setGlobalRange('24h')}
        >
          近 24 小时
        </button>
        <button
          type="button"
          className={`${styles.segmentedBtn} ${globalRange === '7d' ? styles.segmentedBtnActive : ''}`}
          onClick={() => setGlobalRange('7d')}
        >
          近 7 日
        </button>
        <button
          type="button"
          className={`${styles.segmentedBtn} ${globalRange === '30d' ? styles.segmentedBtnActive : ''}`}
          onClick={() => setGlobalRange('30d')}
        >
          近 30 日
        </button>
      </div>

      <button
        type="button"
        className={styles.configBtn}
        onClick={() => setPricesModalOpen(true)}
      >
        <Lucide.DollarSign size={14} />
        配置单价
      </button>
    </div>
  );

  return (
    <SettingsPage title="用量" meta={headerMeta}>
      <div className={styles.usageDashboardCard}>
        {loading && !dashboardData ? (
          <div className={styles.skeletonContainer}>
            <div className={styles.skeletonHeader} />
            <div className={styles.skeletonChart} />
            <div className={styles.skeletonSection} />
          </div>
        ) : (
          dashboardData && (
            <>
              {/* 1. 顶部核心指标 */}
              <UsageSummaryHero
                totalTokens={dashboardData.totalInput + dashboardData.totalOutput}
                totalCost={dashboardData.totalCost}
                totalInput={dashboardData.totalInput}
                totalOutput={dashboardData.totalOutput}
                totalCacheRead={dashboardData.totalCacheRead}
                dailyAverageTokens={dashboardData.hero.dailyAverageTokens}
                dailyAverageCost={dashboardData.hero.dailyAverageCost}
              />

              {/* 2. 连续时钟吞吐趋势折线图 */}
              <UsageTrendChart
                points={dashboardData.points}
                maxTokens={dashboardData.maxTokens}
                maxCost={dashboardData.maxCost}
                models={dashboardData.models}
              />

              {/* 3. 模型用量占比圆环与同心圆角进度条 */}
              <ModelDistributionSection
                models={dashboardData.models}
                totalTokens={dashboardData.totalInput + dashboardData.totalOutput}
              />

              {/* 4. 独立周期切换的热力图矩阵与偏好网格 */}
              <ActivityMatrixHeatmap heroStats={dashboardData.hero} />

              {/* 5. 底栏操作区 */}
              <div className={styles.actionsBar}>
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.actionBtnRefresh}`}
                  onClick={() => void loadData(globalRange)}
                >
                  <Lucide.RefreshCw size={13} />
                  刷新数据
                </button>
                {(dashboardData.totalInput > 0 || dashboardData.totalOutput > 0) && (
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${styles.actionBtnClear}`}
                    onClick={() => void handleClearHistory()}
                  >
                    <Lucide.Trash2 size={13} />
                    清空历史
                  </button>
                )}
              </div>
            </>
          )
        )}
      </div>

      <PriceConfigModal
        open={pricesModalOpen}
        priceList={priceList}
        onListChange={setPriceList}
        onClose={() => setPricesModalOpen(false)}
      />

      {renderConfirmGate(<ConfirmDialog />)}
    </SettingsPage>
  );
};

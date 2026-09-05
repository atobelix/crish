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
import { Button, ConfirmDialog, SegmentedControl } from '../ui';
import { PriceConfigModal } from './PriceConfigModal';
import { SettingsHeadTools, SettingsPage } from './SettingsUI';
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

const RANGE_OPTIONS = [
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
];

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

  const [refreshTick, setRefreshTick] = useState(0);

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
      setDashboardData(null);
      setRefreshTick((t) => t + 1);
      void loadData(globalRange);
    } else {
      showToast('清空历史失败');
    }
  }, [confirmGate, globalRange, loadData, showToast]);

  const hasUsageData = Boolean(
    dashboardData && (dashboardData.totalInput > 0 || dashboardData.totalOutput > 0)
  );

  const headerMeta = (
    <SettingsHeadTools className={styles.headerTools}>
      <SegmentedControl
        size="sm"
        value={globalRange}
        onChange={(val) => setGlobalRange(val as '24h' | '7d' | '30d')}
        options={RANGE_OPTIONS}
      />

      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={<Lucide.DollarSign size={14} />}
        onClick={() => setPricesModalOpen(true)}
      >
        配置单价
      </Button>
    </SettingsHeadTools>
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
              {/* 1. 顶部核心指标：对齐真机截图 2 极简单行仪表盘 */}
              <UsageSummaryHero
                totalTokens={dashboardData.totalInput + dashboardData.totalOutput}
                totalCost={dashboardData.totalCost}
              />

              {/* 2. 连续时钟吞吐趋势折线图：显式 range 契约，清退均线 */}
              <UsageTrendChart
                points={dashboardData.points}
                maxTokens={dashboardData.maxTokens}
                maxCost={dashboardData.maxCost}
                models={dashboardData.models}
                range={globalRange}
              />

              {/* 3. 模型用量占比圆环与同心圆角进度条 */}
              <ModelDistributionSection
                models={dashboardData.models}
                totalTokens={dashboardData.totalInput + dashboardData.totalOutput}
              />

              {/* 4. 独立周期切换的热力图矩阵与偏好网格：接入 refreshKey 保证严格同步 */}
              <ActivityMatrixHeatmap
                heroStats={dashboardData.hero}
                refreshKey={refreshTick}
              />

              {/* 5. 底栏操作区 */}
              <div className={styles.actionsBar}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={<Lucide.RefreshCw size={14} />}
                  onClick={() => {
                    setRefreshTick((t) => t + 1);
                    void loadData(globalRange);
                  }}
                >
                  刷新数据
                </Button>
                {hasUsageData && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    icon={<Lucide.Trash2 size={14} />}
                    onClick={() => void handleClearHistory()}
                  >
                    清空历史
                  </Button>
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

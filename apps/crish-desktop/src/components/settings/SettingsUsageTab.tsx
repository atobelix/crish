import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { migrateLegacyLsPrices } from '../../api/modelPricingSource';
import { clearUsageHistory, getUsageDashboardData } from '../../api/usageApi';
import type { UsageDashboardDto } from '../../api/usageContracts';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { useToast } from '../../services/toast/ToastContext';
import { Button, ConfirmDialog, SegmentedControl, Tooltip } from '../ui';
import { PriceConfigModal } from './PriceConfigModal';
import { SettingsHeadTools, SettingsPage } from './SettingsUI';
import { ActivityMatrixHeatmap } from './usage/ActivityMatrixHeatmap';
import { ModelDistributionSection } from './usage/ModelDistributionSection';
import { UsageSummaryHero } from './usage/UsageSummaryHero';
import { UsageTrendChart } from './usage/UsageTrendChart';
import styles from './SettingsUsageTab.module.css';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

interface Props {
  _onBlockingOverlayChange?: (open: boolean) => void;
}

export const SettingsUsageTab: React.FC<Props> = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [globalRange, setGlobalRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [dashboardData, setDashboardData] = useState<UsageDashboardDto | null>(
    null
  );
  const [loading, setLoading] = useState(true);

  const [pricesModalOpen, setPricesModalOpen] = useState(false);

  const rangeOptions = useMemo(
    () => [
      { value: '24h', label: t('settings.usage.range24h', '近 24 小时') },
      { value: '7d', label: t('settings.usage.range7d', '近 7 日') },
      { value: '30d', label: t('settings.usage.range30d', '近 30 日') },
    ],
    [t]
  );

  /**
   * 退役价表一次性迁移（幂等；树未加载则跳过且不动 LS）。
   * 失败不阻断用量页渲染——显式提示，由用户重试。
   */
  useEffect(() => {
    void migrateLegacyLsPrices()
      .then((r) => {
        if (r.migrated > 0)
          showToast(
            t(
              'settings.usage.migratedPrices',
              `已迁移 ${r.migrated} 条旧单价到模型配置`,
              {
                count: r.migrated,
              }
            )
          );
      })
      .catch((err) =>
        showToast(
          t('settings.usage.migrateFailed', `旧单价迁移失败：${String(err)}`, {
            error: String(err),
          })
        )
      );
  }, [showToast, t]);

  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const [refreshTick, setRefreshTick] = useState(0);

  const loadData = useCallback(
    async (range: '24h' | '7d' | '30d') => {
      setLoading(true);
      try {
        const data = await getUsageDashboardData(range);
        setDashboardData(data);
      } catch {
        showToast(t('settings.usage.fetchFailed', '获取用量数据失败'));
      } finally {
        setLoading(false);
      }
    },
    [showToast, t]
  );

  useEffect(() => {
    void loadData(globalRange);
  }, [globalRange, loadData]);

  const handleClearHistory = useCallback(async () => {
    const ok = await confirmGate({
      title: t('settings.usage.clearHistoryTitle', '清空用量历史'),
      description: t(
        'settings.usage.clearHistoryDesc',
        '确定清空本机所有用量历史记录？此操作不可撤销！'
      ),
      confirmLabel: t('settings.usage.clearHistoryConfirm', '确认清空'),
      danger: true,
    });
    if (!ok) return;

    const cleared = await clearUsageHistory();
    if (cleared) {
      showToast(t('settings.usage.clearSuccess', '用量历史已清空'));
      setDashboardData(null);
      setRefreshTick((t) => t + 1);
      void loadData(globalRange);
    } else {
      showToast(t('settings.usage.clearFailed', '清空历史失败'));
    }
  }, [confirmGate, globalRange, loadData, showToast, t]);

  const hasUsageData = Boolean(
    dashboardData &&
    (dashboardData.totalInput > 0 || dashboardData.totalOutput > 0)
  );

  const headerMeta = (
    <SettingsHeadTools className={styles.headerTools}>
      <SegmentedControl
        size="sm"
        value={globalRange}
        onChange={(val) => setGlobalRange(val as '24h' | '7d' | '30d')}
        options={rangeOptions}
      />

      <Tooltip
        content={t(
          'settings.usage.configurePricingTooltip',
          '配置模型 Token 输入输出与调用单价'
        )}
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<AppIcon name="dollar" size={14} />}
          onClick={() => setPricesModalOpen(true)}
          aria-label={t('settings.usage.configurePricing', '配置单价')}
        >
          {t('settings.usage.configurePricing', '配置单价')}
        </Button>
      </Tooltip>
    </SettingsHeadTools>
  );

  return (
    <SettingsPage title={t('settings.usage.title', '用量')} meta={headerMeta}>
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
                totalTokens={
                  dashboardData.totalInput + dashboardData.totalOutput
                }
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
                totalTokens={
                  dashboardData.totalInput + dashboardData.totalOutput
                }
              />

              {/* 4. 独立周期切换的热力图矩阵与偏好网格：接入 refreshKey 保证严格同步 */}
              <ActivityMatrixHeatmap
                heroStats={dashboardData.hero}
                refreshKey={refreshTick}
              />

              {/* 5. 底栏操作区 */}
              <div className={styles.actionsBar}>
                <Tooltip
                  content={t(
                    'settings.usage.refreshTooltip',
                    '重新拉取用量吞吐与成本统计'
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={<AppIcon name="refresh" size={14} />}
                    onClick={() => {
                      setRefreshTick((t) => t + 1);
                      void loadData(globalRange);
                    }}
                    aria-label={t('settings.usage.refreshData', '刷新数据')}
                  >
                    {t('settings.usage.refreshData', '刷新数据')}
                  </Button>
                </Tooltip>
                {hasUsageData && (
                  <Tooltip
                    content={t(
                      'settings.usage.clearHistoryTooltip',
                      '清空本地存储的所有历史用量指标'
                    )}
                  >
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      icon={<AppIcon name="trash" size={14} />}
                      onClick={() => void handleClearHistory()}
                      aria-label={t('settings.usage.clearHistory', '清空历史')}
                    >
                      {t('settings.usage.clearHistory', '清空历史')}
                    </Button>
                  </Tooltip>
                )}
              </div>
            </>
          )
        )}
      </div>

      <PriceConfigModal
        open={pricesModalOpen}
        onClose={() => setPricesModalOpen(false)}
      />

      {renderConfirmGate(<ConfirmDialog />)}
    </SettingsPage>
  );
};

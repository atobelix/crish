import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { migrateLegacyLsPrices } from '../../api/modelPricingSource';
import { clearUsageHistory, getUsageDashboardData } from '../../api/usageApi';
import type { UsageDashboardDto } from '../../api/usageContracts';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import { useToast } from '../../services/toast/ToastContext';
import {
  Button,
  ConfirmDialog,
  SegmentedControl,
  Tooltip,
} from '@/components/ui';
import { PriceConfigModal } from './PriceConfigModal';
import {
  SettingsCard,
  SettingsHeadTools,
  SettingsPage,
  SettingsSection,
} from './SettingsUI';
import { ActivityMatrixHeatmap } from './usage/ActivityMatrixHeatmap';
import { ModelDistributionSection } from './usage/ModelDistributionSection';
import { UsageSummaryHero } from './usage/UsageSummaryHero';
import { UsageTrendChart } from './usage/UsageTrendChart';
import styles from './SettingsUsageTab.module.css';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

interface Props {
  _onBlockingOverlayChange?: (open: boolean) => void;
}

type UsageRange = '24h' | '7d' | '30d';

export const SettingsUsageTab: React.FC<Props> = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  // 全页唯一时间口径（页头全局范围）；默认近 7 日（R3/D10，原默认 24h 数据易显空）
  const [globalRange, setGlobalRange] = useState<UsageRange>('7d');
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
    async (range: UsageRange) => {
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
        onChange={(val) => setGlobalRange(val as UsageRange)}
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
      {loading && !dashboardData ? (
        /* 骨架按新分区结构：四段「标题 + 卡面」占位，与加载后版式同构 */
        <div className={styles.skeletonContainer} aria-hidden="true">
          <div className={styles.skeletonGroup}>
            <div className={styles.skeletonTitle} />
            <div
              className={`${styles.skeletonCard} ${styles.skeletonOverview}`}
            />
          </div>
          <div className={styles.skeletonGroup}>
            <div className={styles.skeletonTitle} />
            <div className={`${styles.skeletonCard} ${styles.skeletonChart}`} />
          </div>
          <div className={styles.skeletonGroup}>
            <div className={styles.skeletonTitle} />
            <div className={`${styles.skeletonCard} ${styles.skeletonBlock}`} />
          </div>
          <div className={styles.skeletonGroup}>
            <div className={styles.skeletonTitle} />
            <div className={`${styles.skeletonCard} ${styles.skeletonBlock}`} />
          </div>
        </div>
      ) : (
        dashboardData && (
          <>
            {/* 1. 概览：4 格 KPI + 一行洞察 */}
            <SettingsSection
              title={t('settings.usage.sectionOverview', '概览')}
            >
              <SettingsCard>
                <UsageSummaryHero
                  totalTokens={
                    dashboardData.totalInput + dashboardData.totalOutput
                  }
                  totalCost={dashboardData.totalCost}
                  heroStats={dashboardData.hero}
                />
              </SettingsCard>
            </SettingsSection>

            {/* 2. 趋势：原图表整块移入独立卡，逻辑零改动 */}
            <SettingsSection title={t('settings.usage.sectionTrend', '趋势')}>
              <SettingsCard>
                <UsageTrendChart
                  points={dashboardData.points}
                  maxTokens={dashboardData.maxTokens}
                  maxCost={dashboardData.maxCost}
                  models={dashboardData.models}
                  range={globalRange}
                />
              </SettingsCard>
            </SettingsSection>

            {/* 3. 分布：模型行式列表（费用 / 缓存率 / 调用次数三列） */}
            <SettingsSection
              title={t('settings.usage.sectionDistribution', '分布')}
            >
              <SettingsCard>
                <ModelDistributionSection
                  models={dashboardData.models}
                  totalTokens={
                    dashboardData.totalInput + dashboardData.totalOutput
                  }
                />
              </SettingsCard>
            </SettingsSection>

            {/* 4. 活动：热力图跟随全局范围，无自有切换器 */}
            <SettingsSection
              title={t('settings.usage.sectionActivity', '活动')}
            >
              <SettingsCard>
                <ActivityMatrixHeatmap
                  range={globalRange}
                  refreshKey={refreshTick}
                />
              </SettingsCard>
            </SettingsSection>

            {/* 5. 页尾操作行（卡外，与其他设置页一致） */}
            <div className={styles.actionsBar}>
              <Tooltip
                content={t(
                  'settings.usage.refreshTooltip',
                  '重新拉取用量吞吐与成本统计'
                )}
              >
                <Button
                  type="button"
                  variant="secondary"
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

      <PriceConfigModal
        open={pricesModalOpen}
        onClose={() => setPricesModalOpen(false)}
      />

      {renderConfirmGate(<ConfirmDialog />)}
    </SettingsPage>
  );
};

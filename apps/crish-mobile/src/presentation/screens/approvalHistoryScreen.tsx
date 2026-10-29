// 审批历史：按日期分组的已处理记录。
import { useMemo } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import type { ApprovalRecord } from '@/domain/types/domain';
import {
  AppHeader,
  EmptyState,
  Screen,
  SectionHeader,
} from '@/presentation/ui';
import { ApprovalHistoryRow } from '@/presentation/components/approval/ApprovalHistoryRow';

export function groupHistoryByDay(
  history: readonly ApprovalRecord[],
  nowMs = Date.now()
): { title: string; data: ApprovalRecord[] }[] {
  const today = new Date(nowMs);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  const groups = new Map<string, ApprovalRecord[]>();
  const ordered = [...history].sort((a, b) => b.resolvedAtMs - a.resolvedAtMs);
  for (const record of ordered) {
    const recordDate = new Date(record.resolvedAtMs);
    const start = new Date(
      recordDate.getFullYear(),
      recordDate.getMonth(),
      recordDate.getDate()
    ).getTime();
    const diffDays = Math.round((startOfToday - start) / 86_400_000);
    const title =
      diffDays === 0
        ? '今天'
        : diffDays === 1
          ? '昨天'
          : `${recordDate.getFullYear()}/${String(recordDate.getMonth() + 1).padStart(2, '0')}/${String(recordDate.getDate()).padStart(2, '0')}`;
    const bucket = groups.get(title) ?? [];
    bucket.push(record);
    groups.set(title, bucket);
  }
  return [...groups.entries()].map(([title, data]) => ({ title, data }));
}

export interface ApprovalHistoryScreenProps {
  onBack: () => void;
}

export default function ApprovalHistoryScreen({
  onBack,
}: ApprovalHistoryScreenProps) {
  const history = useApprovalStore((s) => s.history);
  const sections = useMemo(() => groupHistoryByDay(history), [history]);

  return (
    <Screen>
      <AppHeader title="已处理" onBack={onBack} />
      {sections.length === 0 ? (
        <EmptyState icon="clock" title="暂无已处理记录" />
      ) : (
        <SectionList
          testID="approval-history-list"
          sections={sections}
          keyExtractor={(record) => record.toolCallId}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <SectionHeader title={section.title} />
            </View>
          )}
          renderItem={({ item, index, section }) => (
            <ApprovalHistoryRow
              record={item}
              testID={`history-row-${item.toolCallId}`}
              divider={index < section.data.length - 1}
            />
          )}
          contentContainerStyle={styles.content}
          stickySectionHeadersEnabled={false}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 8,
    paddingBottom: 32,
  },
  sectionHeader: {
    backgroundColor: 'transparent',
  },
});

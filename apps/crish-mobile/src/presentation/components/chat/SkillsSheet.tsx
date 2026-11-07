// 技能目录 Sheet（G7）：桌面宿主技能目录的只读浏览。
// 数据面来自 useSkillsVm（C44 listSkills，skillsWiring 注入）——读宿主
// 技能发现，与桌面「设置 → 扩展 → 技能」页同一真源同一目录。
// 只读边界（诚实呈现）：技能启停的生效值是桌面 webview 本地状态
// （localStorage），宿主侧没有可远程读写的数据面——本 Sheet 只有
// 浏览：不渲染开关/勾选/「已启用」计数，启停引导去桌面端管理；
// fileActivation（文件声明缺省）不作状态呈现。状态分开呈现：
// 未连接 / 加载中 / 列表失败（可重试）/ 空列表 / 目录列表。
import { StyleSheet, View } from 'react-native';
import type { SkillEntry } from '@crish/shared-types';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, ErrorState, LoadingState, Sheet } from '@/presentation/ui';
import {
  skillScopeLabel,
  skillScopeOrder,
} from '@/domain/repositories/skillCommands';

export interface SkillsSheetProps {
  visible: boolean;
  onClose: () => void;
  onCloseComplete?: () => void;
  /** 是否已连接桌面（未连接与命令失败分开呈现） */
  connected: boolean;
  /** 技能目录（未拉取为 null；宿主投影顺序：作用域序 + 名称序） */
  skills: readonly SkillEntry[] | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  /** 最近一次命令错误码（列表失败时呈现） */
  errorCode: string | null;
  onRetry: () => void;
  testID?: string;
}

/** 连续同作用域分组（宿主投影已按作用域排序，此处只做分段呈现） */
function groupByScope(
  skills: readonly SkillEntry[]
): { scope: string; items: SkillEntry[] }[] {
  const groups: { scope: string; items: SkillEntry[] }[] = [];
  for (const skill of skills) {
    const last = groups[groups.length - 1];
    if (last && last.scope === skill.scope) {
      last.items.push(skill);
    } else {
      groups.push({ scope: skill.scope, items: [skill] });
    }
  }
  return groups.sort(
    (a, b) => skillScopeOrder(a.scope) - skillScopeOrder(b.scope)
  );
}

export function SkillsSheet({
  visible,
  onClose,
  onCloseComplete,
  connected,
  skills,
  status,
  errorCode,
  onRetry,
  testID = 'skills-sheet',
}: SkillsSheetProps) {
  const theme = useTheme();
  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      onCloseComplete={onCloseComplete}
      title="技能"
      size="large"
      testID={testID}
      measureKey={testID}
      contentKey={`${connected ? 'on' : 'off'}:${status}:${skills?.length ?? 0}`}
    >
      {!connected ? (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            未连接桌面
          </AppText>
          <AppText
            variant="caption"
            color="textTertiary"
            style={styles.centerText}
          >
            连接桌面后可查看其技能目录
          </AppText>
        </View>
      ) : status === 'loading' || status === 'idle' ? (
        <LoadingState compact />
      ) : status === 'error' ? (
        <ErrorState
          compact
          title={`无法获取技能列表${errorCode ? `（${errorCode}）` : ''}`}
          onRetry={onRetry}
        />
      ) : skills && skills.length > 0 ? (
        <View style={{ gap: theme.space.lg }}>
          {groupByScope(skills).map((group) => (
            <View key={group.scope} style={{ gap: theme.space.sm }}>
              <AppText variant="caption" color="textTertiary">
                {skillScopeLabel(group.scope)}
              </AppText>
              {group.items.map((skill) => (
                <View
                  key={skill.id}
                  testID={`${testID}-skill-${skill.id}`}
                  style={{ gap: theme.space.xxs }}
                >
                  <View style={styles.rowHead}>
                    <AppText variant="body" style={styles.rowName}>
                      {skill.name}
                    </AppText>
                    {skill.system ? (
                      <AppText variant="caption" color="textTertiary">
                        系统
                      </AppText>
                    ) : null}
                    {skill.disableModelInvocation ? (
                      <AppText variant="caption" color="textTertiary">
                        不自动调用
                      </AppText>
                    ) : null}
                  </View>
                  {skill.description ? (
                    <AppText variant="footnote" color="textSecondary">
                      {skill.description}
                    </AppText>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            桌面端暂无技能
          </AppText>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  centerText: {
    textAlign: 'center',
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  rowName: {
    flexShrink: 1,
  },
});

export default SkillsSheet;

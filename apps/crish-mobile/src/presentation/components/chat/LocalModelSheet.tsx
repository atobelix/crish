// 对话模型选择 Sheet（IA §3.1/§3.2、任务四 L3 后置项）：本地对话里
// 模型钮的数据面，标题「选择模型」——与设置里「默认模型」页分工：
// 设置页管全局默认，本 Sheet 是对话内的快速选择面。
// - 真源只有一个：全局默认 = localChatStore 的 config.activeModel；
//   线程覆盖 = localChatSessionStore 线程的 modelRef，不新增字段。
// - 选择行为：无线程上下文（主页）点行即设为默认（写 activeModel）；
//   线程内先选作用域——「仅此对话」写 setThreadModel、「设为默认」
//   写 setActiveModel；「跟随默认」清线程覆盖（modelRef 置 null）。
// - 分组：本机模型（config 里 'ondevice' 同步条目——同步只写管理器
//   已校验就绪的模型，列出的即可用；状态真源在管理器，本面不臆造）
//   与各供应商的启用模型。停用供应商/模型不进可选列表（与
//   resolveActiveSelection 的可选口径一致）。
// - 当前默认如实呈现：有效报「供应商 · 模型」；activeModel 在但
//   解析失效时给与默认模型页同一句失效说明，明示没有自动改投；
//   未设置就写未设置。线程已有覆盖时另行呈现本对话的选择。
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useStore } from 'zustand';
import { useTheme } from '@/adapters/platform/theme';
import { useLocalChatStore } from '@/adapters/hooks/useAppStore';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { resolveActiveSelection } from '@/domain/pure/localChatProtocol';
import {
  ON_DEVICE_PROVIDER_ID,
  ON_DEVICE_PROVIDER_NAME,
} from '@/adapters/onDevice/onDeviceProviderSync';
import { AppText, Button, Sheet, SheetOptionRow } from '@/presentation/ui';
import type { LocalVendorKey } from '@/domain/types/localChat';
import { VendorLogo } from '@/presentation/components/localChat/ui/VendorLogo';
import { isLocalVendorKey } from '@/presentation/components/localChat/ui/vendorLogosData';
import {
  SegmentedBar,
  type SegmentedOption,
} from '@/presentation/components/localChat/ui/SegmentedBar';

function resolveVendorKey(providerId?: string | null): LocalVendorKey {
  if (!providerId) return 'custom';
  const normalized = providerId.toLowerCase().trim();
  if (isLocalVendorKey(normalized)) return normalized;
  if (normalized.includes('openai')) return 'openai';
  if (normalized.includes('anthropic') || normalized.includes('claude'))
    return 'anthropic';
  if (normalized.includes('google') || normalized.includes('gemini'))
    return 'google';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('ollama')) return 'ollama';
  if (normalized.includes('siliconflow')) return 'siliconflow';
  return 'custom';
}

export interface LocalModelSheetProps {
  visible: boolean;
  onClose: () => void;
  onCloseComplete?: () => void;
  /** 未配置时的去向：打开供应商配置（设置内的本地供应商页） */
  onOpenProviders: () => void;
  /**
   * 线程上下文（对话内挂载时传入）：在场时选择多一道作用域——
   * 「仅此对话」写该线程 modelRef、「设为默认」写全局 activeModel；
   * 不传（主页）时点行即设为默认。
   */
  threadId?: string | null;
  testID?: string;
}

type SelectionScope = 'thread' | 'default';

const SCOPE_OPTIONS: readonly SegmentedOption<SelectionScope>[] = [
  { key: 'thread', label: '仅此对话' },
  { key: 'default', label: '设为默认' },
];

/** 与默认模型页（useDefaultModelVm）同一句失效说明，不另造文案 */
const INVALID_DEFAULT_REASON =
  '当前默认已失效（模型被删除、停用，或供应商不可用），系统没有自动改用其他模型。请在下方重新选择。';

interface LocalModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface LocalModelGroup {
  providerId: string;
  providerName: string;
  options: LocalModelOption[];
}

export function LocalModelSheet({
  visible,
  onClose,
  onCloseComplete,
  onOpenProviders,
  threadId = null,
  testID = 'local-model-sheet',
}: LocalModelSheetProps) {
  const theme = useTheme();
  const config = useLocalChatStore((s) => s.config);
  const threadMeta = useStore(localChatSessionStore, (s) =>
    threadId ? s.threads.find((t) => t.id === threadId) : undefined
  );
  const [scope, setScope] = useState<SelectionScope>('thread');
  useEffect(() => {
    if (visible) setScope('thread');
  }, [visible, threadId]);

  const active = config.activeModel;

  // 当前默认（全局）：有效才报名称；失效给说明，未设置如实写未设置。
  const defaultSelection = useMemo(
    () => resolveActiveSelection(config),
    [config]
  );
  const currentDefaultText = defaultSelection
    ? `${defaultSelection.provider.displayName ?? defaultSelection.providerId} · ${
        defaultSelection.model.displayName ?? defaultSelection.modelId
      }`
    : '未设置';
  const invalidReasonText =
    active !== null && defaultSelection === null
      ? INVALID_DEFAULT_REASON
      : null;

  // 本对话的选择：线程覆盖优先（与引擎 resolveThreadSelection 同口径，
  // 经纯函数 resolveActiveSelection 以覆盖引用代入 activeModel 实现）。
  const threadRef = threadMeta?.modelRef ?? null;
  const threadSelection = useMemo(
    () =>
      threadRef
        ? resolveActiveSelection({ ...config, activeModel: threadRef })
        : null,
    [config, threadRef]
  );
  const threadOverrideText =
    threadId && threadRef
      ? threadSelection
        ? `${threadSelection.provider.displayName ?? threadSelection.providerId} · ${
            threadSelection.model.displayName ?? threadSelection.modelId
          }`
        : '已失效（模型不可用）'
      : null;
  // 列表对号所指 = 本上下文实际生效的选择（线程覆盖 ?? 全局默认）。
  const effective =
    threadId && threadRef ? threadSelection : defaultSelection;

  const { onDeviceGroup, providerGroups } = useMemo(() => {
    let onDevice: LocalModelGroup | null = null;
    const providers: LocalModelGroup[] = [];
    for (const [providerId, provider] of Object.entries(config.providers)) {
      if (provider.enabled === false) continue;
      const providerName =
        providerId === ON_DEVICE_PROVIDER_ID
          ? ON_DEVICE_PROVIDER_NAME
          : (provider.displayName ?? providerId);
      const options: LocalModelOption[] = [];
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        options.push({
          providerId,
          providerName,
          modelId: model.id,
          modelName: model.displayName ?? model.id,
        });
      }
      if (providerId === ON_DEVICE_PROVIDER_ID) {
        onDevice = { providerId, providerName, options };
      } else if (options.length > 0) {
        providers.push({ providerId, providerName, options });
      }
    }
    return { onDeviceGroup: onDevice, providerGroups: providers };
  }, [config]);

  const totalOptions =
    (onDeviceGroup?.options.length ?? 0) +
    providerGroups.reduce((sum, g) => sum + g.options.length, 0);
  const hasProviders = Object.keys(config.providers).length > 0;

  const applySelection = (option: LocalModelOption) => {
    if (threadId && scope === 'thread') {
      localChatSessionStore.getState().setThreadModel(threadId, {
        providerId: option.providerId,
        modelId: option.modelId,
      });
    } else {
      localChatStore
        .getState()
        .setActiveModel(option.providerId, option.modelId);
    }
    onClose();
  };

  const followDefault = () => {
    if (threadId) {
      localChatSessionStore.getState().setThreadModel(threadId, null);
    }
    onClose();
  };

  const renderOption = (option: LocalModelOption) => {
    const isEffective =
      effective?.providerId === option.providerId &&
      effective?.modelId === option.modelId;
    const isDefault =
      active?.providerId === option.providerId &&
      active?.modelId === option.modelId;
    return (
      <SheetOptionRow
        key={`${option.providerId}::${option.modelId}`}
        testID={`${testID}-option-${option.providerId}-${option.modelId}`}
        leading={
          <VendorLogo
            vendor={resolveVendorKey(option.providerId)}
            size={28}
            borderRadius={7}
          />
        }
        label={option.modelName}
        hint={threadId && isDefault && !isEffective ? '默认' : undefined}
        selected={isEffective}
        onPress={() => applySelection(option)}
      />
    );
  };

  const renderGroup = (group: LocalModelGroup) => (
    <View key={group.providerId}>
      <AppText
        variant="caption"
        color="textTertiary"
        style={{
          paddingHorizontal: theme.space.sm,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.xxs,
        }}
      >
        {group.providerName}
      </AppText>
      {group.options.length > 0 ? (
        group.options.map(renderOption)
      ) : (
        <AppText
          variant="footnote"
          color="textTertiary"
          style={{ paddingHorizontal: theme.space.sm }}
        >
          暂无已校验的本机模型
        </AppText>
      )}
    </View>
  );

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      onCloseComplete={onCloseComplete}
      title="选择模型"
      size="large"
      testID={testID}
    >
      <View style={[styles.list, { gap: theme.space.xxs }]}>
        <View
          style={{
            paddingHorizontal: theme.space.sm,
            gap: theme.space.xxs,
          }}
        >
          <AppText variant="caption" color="textTertiary">
            当前默认
          </AppText>
          <AppText variant="body" color="textPrimary">
            {currentDefaultText}
          </AppText>
          {invalidReasonText ? (
            <AppText variant="footnote" color="textSecondary">
              {invalidReasonText}
            </AppText>
          ) : null}
          {threadOverrideText ? (
            <>
              <AppText
                variant="caption"
                color="textTertiary"
                style={{ paddingTop: theme.space.xs }}
              >
                本对话
              </AppText>
              <AppText variant="body" color="textPrimary">
                {threadOverrideText}
              </AppText>
            </>
          ) : null}
        </View>

        {threadId ? (
          <SegmentedBar
            options={SCOPE_OPTIONS}
            selectedKey={scope}
            onSelect={setScope}
            testID={`${testID}-scope`}
          />
        ) : null}

        {threadId && scope === 'thread' ? (
          <SheetOptionRow
            testID={`${testID}-follow-default`}
            label="跟随默认"
            selected={threadRef === null}
            onPress={followDefault}
          />
        ) : null}

        {totalOptions > 0 ? (
          <>
            {onDeviceGroup ? renderGroup(onDeviceGroup) : null}
            {providerGroups.map(renderGroup)}
          </>
        ) : (
          <View style={styles.center}>
            <AppText variant="body" color="textSecondary">
              {hasProviders ? '暂无可用模型' : '尚未配置本地供应商'}
            </AppText>
            <Button
              label="去配置供应商"
              variant="secondary"
              onPress={onOpenProviders}
            />
          </View>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    flexDirection: 'column',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
});

export default LocalModelSheet;

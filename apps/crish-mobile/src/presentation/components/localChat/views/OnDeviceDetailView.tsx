// 本机模型 · 单模型详情（L2 / IA §3.6）：首屏是名称/量化/状态/
// 真实占用与一个随状态变的主动作（下载、继续、重新下载、校验、
// 取消、重试、加载、设为默认、释放、删除）；许可、来源、sha256、
// 配置生效值都在后部——首页与列表行不放这些。未知 id 是诚实空态：
// 说明不在目录中，没有下载按钮。无凭据的未完成不显示「继续」：
// 主动作是「重新下载」，点下先确认会覆盖半成品（IA §3.5）。
// 配置只读展示当前客户端固定生效值，不提供假保存（IA §3.7）。
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { formatBytes } from '@/adapters/onDevice/onDeviceModelManager';
import {
  useOnDeviceModelDetailVm,
  type OnDeviceModelDetailVm,
} from '@/adapters/viewmodels/useOnDeviceModelDetailVm';
import { AppHeader, AppText, Dialog, ListRow, Screen } from '@/presentation/ui';
import {
  OnDeviceGroup,
  onDeviceDeleteConfirmText,
  onDeviceIaStatusText,
} from './OnDeviceShared';

export interface OnDeviceDetailViewProps {
  modelId: string;
  vm?: OnDeviceModelDetailVm;
  onBack: () => void;
  testID?: string;
}

export default function OnDeviceDetailView({
  modelId,
  vm: customVm,
  onBack,
  testID = 'ondevice-detail-view',
}: OnDeviceDetailViewProps) {
  const defaultVm = useOnDeviceModelDetailVm(modelId);
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRedownload, setConfirmRedownload] = useState(false);
  const [confirmRemoveIncomplete, setConfirmRemoveIncomplete] =
    useState(false);

  const spec = vm.spec;
  const state = vm.state;
  const kind = state?.kind;

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="模型详情" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        {!vm.found || spec === null ? (
          <OnDeviceGroup label="模型">
            <ListRow
              title="该模型不在目录中"
              subtitle="目录里没有这个 id，无法下载或加载。"
              divider={false}
            />
          </OnDeviceGroup>
        ) : (
          <>
            <OnDeviceGroup label="模型">
              <ListRow
                testID="ondevice-detail-name"
                title={spec.displayName}
                subtitle={[
                  vm.quantLabel,
                  kind === 'ready' || vm.usageBytes > 0
                    ? `占用 ${vm.usageText}`
                    : `完整文件 ${vm.sizeText}`,
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    {vm.loading && kind === 'ready'
                      ? '加载中'
                      : onDeviceIaStatusText(state, vm.loaded)}
                  </AppText>
                }
                divider={false}
              />
              {kind === 'downloading' && state?.kind === 'downloading' ? (
                <ListRow
                  title={state.progressText ?? '下载中'}
                  subtitle={
                    state.speedBytesPerSec !== undefined
                      ? `速度 ${formatBytes(state.speedBytesPerSec)}/s`
                      : undefined
                  }
                  divider={false}
                />
              ) : null}
              {kind === 'error' && state?.kind === 'error' ? (
                <ListRow
                  title="失败原因"
                  subtitle={state.message}
                  divider={false}
                />
              ) : null}
              {kind === 'unverified' ? (
                <ListRow
                  title="若校验不通过需重新下载"
                  subtitle={`峰值约需 ${formatBytes(spec.size * 2)}（新旧两份同时在盘）`}
                  divider={false}
                />
              ) : null}
            </OnDeviceGroup>

            {vm.actionErrorText !== null ? (
              <View style={{ paddingHorizontal: theme.space.xs + 2 }}>
                <AppText variant="footnote" color="warning">
                  {vm.actionErrorText}
                </AppText>
              </View>
            ) : null}

            <OnDeviceGroup label="操作">
              {kind === 'missing' || kind === 'cancelled' ? (
                <ListRow
                  testID="ondevice-detail-download"
                  title="下载"
                  showChevron
                  onPress={() => vm.download()}
                />
              ) : null}
              {kind === 'partial' && vm.resumeAvailable ? (
                <ListRow
                  testID="ondevice-detail-resume"
                  title="继续下载"
                  showChevron
                  onPress={() => vm.download()}
                />
              ) : null}
              {kind === 'partial' && !vm.resumeAvailable ? (
                <ListRow
                  testID="ondevice-detail-redownload"
                  title="重新下载"
                  showChevron
                  onPress={() => setConfirmRedownload(true)}
                />
              ) : null}
              {kind === 'unverified' ? (
                <ListRow
                  testID="ondevice-detail-verify"
                  title="校验"
                  showChevron
                  onPress={() => vm.download()}
                />
              ) : null}
              {kind === 'downloading' ? (
                <ListRow
                  testID="ondevice-detail-cancel"
                  title="取消下载"
                  destructive
                  onPress={() => void vm.cancelDownload()}
                />
              ) : null}
              {kind === 'verifying' ? (
                <ListRow title="校验中" divider={false} />
              ) : null}
              {kind === 'cancelling' ? (
                <ListRow title="取消中" divider={false} />
              ) : null}
              {kind === 'error' ? (
                <ListRow
                  testID="ondevice-detail-retry"
                  title="重试"
                  showChevron
                  onPress={() => vm.download()}
                />
              ) : null}
              {kind === 'ready' && !vm.loaded ? (
                <ListRow
                  testID="ondevice-detail-load"
                  title="加载"
                  showChevron
                  onPress={() => void vm.load()}
                />
              ) : null}
              {kind === 'ready' && vm.loaded ? (
                <ListRow
                  testID="ondevice-detail-release"
                  title="释放"
                  showChevron
                  onPress={() => void vm.release()}
                />
              ) : null}
              {kind === 'ready' && !vm.isDefault ? (
                <ListRow
                  testID="ondevice-detail-set-default"
                  title="设为默认"
                  showChevron
                  onPress={() => vm.setAsDefault()}
                />
              ) : null}
              {kind === 'ready' && vm.isDefault ? (
                <ListRow title="当前默认" divider={false} />
              ) : null}
              {kind === 'partial' || kind === 'error' || kind === 'cancelled' ? (
                <ListRow
                  testID="ondevice-detail-remove-incomplete"
                  title="删除未完成文件"
                  destructive
                  divider={false}
                  onPress={() => setConfirmRemoveIncomplete(true)}
                />
              ) : null}
              {kind === 'ready' ? (
                <ListRow
                  testID="ondevice-detail-remove"
                  title="删除"
                  destructive
                  divider={false}
                  onPress={() => setConfirmRemove(true)}
                />
              ) : null}
            </OnDeviceGroup>

            <OnDeviceGroup label="配置（当前生效值）">
              <ListRow
                title="上下文长度"
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    {`${vm.contextSize}`}
                  </AppText>
                }
              />
              <ListRow
                title="GPU 层"
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    0
                  </AppText>
                }
              />
              <ListRow
                title="内存锁定"
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    开启
                  </AppText>
                }
              />
              <ListRow
                title="线程数"
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    由运行时决定
                  </AppText>
                }
                divider={false}
              />
            </OnDeviceGroup>

            <OnDeviceGroup label="来源与许可">
              <ListRow
                title="来源仓库"
                subtitle={vm.sourceRepo ?? undefined}
              />
              <ListRow title="文件名" subtitle={spec.fileName} />
              <ListRow
                title="许可"
                subtitle={spec.license.label}
                divider={spec.license.warning === undefined}
              />
              {spec.license.warning ? (
                <View
                  style={{
                    paddingHorizontal: theme.space.md,
                    paddingBottom: theme.space.sm,
                  }}
                >
                  <AppText variant="footnote" color="warning">
                    {spec.license.warning}
                  </AppText>
                </View>
              ) : null}
              <ListRow
                title="用途限制"
                subtitle="纯文本对话：工具调用不会传给端侧模型"
              />
              {spec.inference?.enableThinking === false ? (
                <ListRow title="目录设定" subtitle="关闭思考模式" />
              ) : null}
              {spec.inference?.stop && spec.inference.stop.length > 0 ? (
                <ListRow title="目录设定" subtitle="带停止词" />
              ) : null}
              <ListRow
                title="校验（SHA-256）"
                subtitle={spec.sha256}
                divider={false}
              />
            </OnDeviceGroup>
          </>
        )}
      </ScrollView>

      <Dialog
        visible={confirmRemove}
        title="删除本机模型"
        description={
          spec
            ? onDeviceDeleteConfirmText({
                name: spec.displayName,
                state,
                usageText: vm.usageText,
                loaded: vm.loaded,
                isDefault: vm.isDefault,
              })
            : undefined
        }
        onDismiss={() => setConfirmRemove(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setConfirmRemove(false),
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: () => {
              setConfirmRemove(false);
              void vm.removeModel();
            },
          },
        ]}
      />
      <Dialog
        visible={confirmRedownload}
        title="重新下载"
        description="没有可用的续传凭据，重新下载会覆盖未完成文件并从头开始。"
        onDismiss={() => setConfirmRedownload(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setConfirmRedownload(false),
          },
          {
            label: '重新下载',
            variant: 'danger',
            onPress: () => {
              setConfirmRedownload(false);
              vm.download();
            },
          },
        ]}
      />
      <Dialog
        visible={confirmRemoveIncomplete}
        title="删除未完成文件"
        description={
          spec
            ? `删除 ${spec.displayName} 的未完成文件（${vm.usageText}）？进度不能恢复。`
            : undefined
        }
        onDismiss={() => setConfirmRemoveIncomplete(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setConfirmRemoveIncomplete(false),
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: () => {
              setConfirmRemoveIncomplete(false);
              void vm.removeIncomplete();
            },
          },
        ]}
      />
    </Screen>
  );
}

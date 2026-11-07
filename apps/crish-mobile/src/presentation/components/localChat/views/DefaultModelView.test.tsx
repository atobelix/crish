// 默认模型页视图测试（L3）：当前默认如实呈现、失效给说明；点可选
// 行才落位；本机未就绪行去详情；无可用模型时给去向。
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import type { DefaultModelVm } from '@/adapters/viewmodels/useDefaultModelVm';
import DefaultModelView from './DefaultModelView';

jest.mock('@/adapters/viewmodels/useDefaultModelVm', () => ({
  useDefaultModelVm: () => ({
    currentText: '未设置',
    invalidReasonText: null,
    groups: [],
    hasAnySelectable: false,
    select: jest.fn(),
    refresh: jest.fn(async () => {}),
  }),
}));

afterEach(() => {
  cleanup();
});

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

async function renderView(element: ReactElement) {
  return render(element, { wrapper: Providers });
}

function makeVm(overrides: Partial<DefaultModelVm> = {}): DefaultModelVm {
  return {
    currentText: '云厂商 · 模型一',
    invalidReasonText: null,
    groups: [
      {
        providerId: 'cloud-a',
        providerName: '云厂商',
        selectable: [
          {
            providerId: 'cloud-a',
            modelId: 'm1',
            name: '模型一',
            isCurrent: true,
          },
          {
            providerId: 'cloud-a',
            modelId: 'm2',
            name: '模型二',
            isCurrent: false,
          },
        ],
        unavailable: [
          {
            modelId: 'm3',
            name: '模型三',
            reasonText: '已停用',
            onDeviceDetailId: null,
          },
        ],
      },
      {
        providerId: 'ondevice',
        providerName: '本机模型',
        selectable: [],
        unavailable: [
          {
            modelId: 'qwen2.5-1.5b-instruct-q4_k_m',
            name: 'Qwen2.5-1.5B',
            reasonText: '未完成',
            onDeviceDetailId: 'qwen2.5-1.5b-instruct-q4_k_m',
          },
        ],
      },
    ],
    hasAnySelectable: true,
    select: jest.fn(),
    refresh: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('DefaultModelView（默认模型页）', () => {
  it('当前默认为有效选择时如实呈现，当前行带「当前默认」', async () => {
    const view = await renderView(
      <DefaultModelView vm={makeVm()} onBack={jest.fn()} />
    );
    expect(view.getByText('云厂商 · 模型一')).toBeTruthy();
    // 「当前默认」两处：分组名 + 当前行标记
    expect(view.getAllByText('当前默认')).toHaveLength(2);
    expect(view.queryByText(/没有自动改用/)).toBeNull();
  });

  it('点可选行才落位：select 收到供应商与模型二元组', async () => {
    const vm = makeVm();
    const view = await renderView(
      <DefaultModelView vm={vm} onBack={jest.fn()} />
    );
    fireEvent.press(view.getByTestId('default-model-select-cloud-a-m2'));
    expect(vm.select).toHaveBeenCalledWith('cloud-a', 'm2');
  });

  it('失效时给说明：明示没有自动改用其他模型', async () => {
    const view = await renderView(
      <DefaultModelView
        vm={makeVm({
          currentText: '未设置',
          invalidReasonText:
            '当前默认已失效（模型被删除、停用，或供应商不可用），系统没有自动改用其他模型。请在下方重新选择。',
        })}
        onBack={jest.fn()}
      />
    );
    expect(view.getByText('未设置')).toBeTruthy();
    expect(view.getByText(/没有自动改用其他模型/)).toBeTruthy();
  });

  it('本机未就绪行：带状态词原因，点行去详情而非在本页下载', async () => {
    const onOpenOnDeviceDetail = jest.fn();
    const vm = makeVm();
    const view = await renderView(
      <DefaultModelView
        vm={vm}
        onBack={jest.fn()}
        onOpenOnDeviceDetail={onOpenOnDeviceDetail}
      />
    );
    expect(view.getByText('未完成')).toBeTruthy();
    fireEvent.press(
      view.getByTestId(
        'default-model-unavailable-ondevice-qwen2.5-1.5b-instruct-q4_k_m'
      )
    );
    expect(onOpenOnDeviceDetail).toHaveBeenCalledWith(
      'qwen2.5-1.5b-instruct-q4_k_m'
    );
    expect(vm.select).not.toHaveBeenCalled();
  });

  it('没有可用模型：空态给出去配置供应商与下载本机模型两条去向', async () => {
    const onOpenProviders = jest.fn();
    const onOpenOnDevice = jest.fn();
    const view = await renderView(
      <DefaultModelView
        vm={makeVm({ currentText: '未设置', groups: [], hasAnySelectable: false })}
        onBack={jest.fn()}
        onOpenProviders={onOpenProviders}
        onOpenOnDevice={onOpenOnDevice}
      />
    );
    expect(view.getByText('还没有可用的模型')).toBeTruthy();
    fireEvent.press(view.getByTestId('default-model-open-providers'));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByTestId('default-model-open-ondevice'));
    expect(onOpenOnDevice).toHaveBeenCalledTimes(1);
  });
});

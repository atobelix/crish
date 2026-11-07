// 本地供应商列表（设置子页兼容代理）：重定向至全新 ProvidersListView 视图
import ProvidersListView, {
  type ProvidersListViewProps,
} from './views/ProvidersListView';
import type { LocalProvidersVm } from '@/adapters/viewmodels/useLocalProvidersVm';

export interface LocalProvidersViewProps {
  vm?: LocalProvidersVm;
  onBack?: () => void;
  onAdd?: () => void;
  onEdit?: (providerId: string) => void;
}

export default function LocalProvidersView({
  vm,
  onBack,
  onAdd,
  onEdit,
}: LocalProvidersViewProps) {
  return (
    <ProvidersListView
      vm={vm}
      onBack={onBack}
      onAddProvider={onAdd}
      onSelectProvider={onEdit}
    />
  );
}

export { ProvidersListView, type ProvidersListViewProps };

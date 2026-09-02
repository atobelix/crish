import { ToastStore } from './ToastStore';

export const toast = {
  show: ToastStore.show,
  success: ToastStore.success,
  error: ToastStore.error,
  warning: ToastStore.warning,
  info: ToastStore.info,
  loading: ToastStore.loading,
  promise: ToastStore.promise,
  dismiss: ToastStore.dismiss,
  clear: ToastStore.clear,
};

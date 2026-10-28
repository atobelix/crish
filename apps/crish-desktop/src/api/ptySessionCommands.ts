import { invokeResult, type InvokeResult } from './tauriInvoke';

export type PtyInvokeOk<T> = { status: 'ok'; data: T };
export type PtyInvokeMissing = { status: 'missing' };
export type PtyInvokeErr = { status: 'error'; message: string };
export type PtyInvokeResult<T> =
  PtyInvokeOk<T> | PtyInvokeMissing | PtyInvokeErr;

export function mapPtyInvoke<T>(res: InvokeResult<T>): PtyInvokeResult<T> {
  if (res.status === 'ok') return { status: 'ok', data: res.data };
  if (res.status === 'missing') return { status: 'missing' };
  return { status: 'error', message: res.message };
}

export async function ptyWrite(
  ptyId: string,
  data: string
): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const res = await invokeResult<unknown>('workbench_pty_write', {
    ptyId: id,
    data: data ?? '',
  });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

export async function ptyResize(
  ptyId: string,
  cols: number,
  rows: number
): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const res = await invokeResult<unknown>('workbench_pty_resize', {
    ptyId: id,
    cols: Math.max(1, Math.floor(Number(cols) || 1)),
    rows: Math.max(1, Math.floor(Number(rows) || 1)),
  });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

export async function ptyDetach(ptyId: string): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const res = await invokeResult<unknown>('workbench_pty_detach', {
    ptyId: id,
  });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

export async function ptyAttach(ptyId: string): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const res = await invokeResult<unknown>('workbench_pty_attach', {
    ptyId: id,
  });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

export async function ptyPing(ptyId: string): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  const res = await invokeResult<unknown>('workbench_pty_ping', { ptyId: id });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

export async function killPty(
  ptyId: string,
  clearOutputHistory: (id: string) => void
): Promise<PtyInvokeResult<void>> {
  const id = (ptyId || '').trim();
  if (!id) return { status: 'error', message: 'ptyId is empty' };
  clearOutputHistory(id);
  const res = await invokeResult<unknown>('workbench_pty_kill', { ptyId: id });
  return res.status === 'ok'
    ? { status: 'ok', data: undefined }
    : mapPtyInvoke(res);
}

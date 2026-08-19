/**
 * 展开互斥 / 四击守卫：trigger 写绝对值，禁止 !prev 与外点对打。
 */
import { layerStackService } from '../internal/layer-stack/LayerStackService';

/** 外点已关后，同一 pointer 落到本 trigger 不得再打开 */
export function shouldSuppressMenuReopen(
  triggerEl: HTMLElement | null
): boolean {
  return layerStackService.wasTriggerClickAfterDismiss(triggerEl);
}

/** 与加号同构：开着则写死 false，关着才写 true */
export function toggleExclusiveMenu(
  open: boolean,
  setOpen: (next: boolean) => void,
  triggerEl: HTMLElement | null
): void {
  if (shouldSuppressMenuReopen(triggerEl)) return;
  if (open) setOpen(false);
  else setOpen(true);
}

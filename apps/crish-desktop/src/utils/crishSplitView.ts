export interface IViewConstraint {
  minimumSize: number;
  maximumSize: number;
  priority: 'high' | 'normal' | 'low';
  snap?: number[];
}

export interface ISplitViewItem {
  ratio: number;
  constraint: IViewConstraint;
}

export interface ISplitViewState {
  items: ISplitViewItem[];
  direction: 'horizontal' | 'vertical';
}

export function computeResize(
  items: ISplitViewItem[],
  resizeIndex: number,
  delta: number,
  totalSize: number,
): number[] {
  const count = items.length;
  if (count < 2 || resizeIndex < 0 || resizeIndex >= count - 1) {
    return items.map((i) => i.ratio);
  }

  const ratios = items.map((i) => i.ratio);
  const deltaRatio = totalSize > 0 ? delta / totalSize : 0;

  const leftItem = items[resizeIndex]!;
  const rightItem = items[resizeIndex + 1]!;
  let leftRatio = ratios[resizeIndex]! + deltaRatio;
  let rightRatio = ratios[resizeIndex + 1]! - deltaRatio;

  const leftMin = leftItem.constraint.minimumSize;
  const leftMax = leftItem.constraint.maximumSize;
  const rightMin = rightItem.constraint.minimumSize;
  const rightMax = rightItem.constraint.maximumSize;

  if (leftRatio < leftMin) {
    leftRatio = leftMin;
    rightRatio = 1 - leftRatio;
  } else if (leftRatio > leftMax) {
    leftRatio = leftMax;
    rightRatio = 1 - leftRatio;
  }

  if (rightRatio < rightMin) {
    rightRatio = rightMin;
    leftRatio = 1 - rightRatio;
  } else if (rightRatio > rightMax) {
    rightRatio = rightMax;
    leftRatio = 1 - rightRatio;
  }

  ratios[resizeIndex] = leftRatio;
  ratios[resizeIndex + 1] = rightRatio;

  return ratios;
}

export function checkSnap(
  ratio: number,
  snaps: number[],
  totalSize: number,
  threshold = 10,
): number | null {
  const currentPx = ratio * totalSize;
  for (const snap of snaps) {
    const snapPx = snap * totalSize;
    if (Math.abs(currentPx - snapPx) < threshold) {
      return snap;
    }
  }
  return null;
}

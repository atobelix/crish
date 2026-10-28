/**
 * apps/crish-desktop/src/components/ui/internal/cn.ts
 * 全局统一 className 组合与特异度归一化工具函数
 *
 * 核心设计：
 * 1. 集成 clsx：高效拍平条件对象、数组与空值；
 * 2. 集成 tailwind-merge 并扩展 Conex Design Tokens 体系；
 * 3. 保证外部传入的 className 在冲突时具备确定的后置覆盖优先级；
 * 4. 导出 cva 与 VariantProps，作为系统统一的变体矩阵定义基座。
 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { cva, type VariantProps } from 'class-variance-authority';

type CustomClassGroups = 'control-size';

/** 扩展 tailwind-merge 配置，对齐 Conex 桌面端设计 Token 体系 */
const customTwMerge = extendTailwindMerge<CustomClassGroups>({
  extend: {
    theme: {
      spacing: [
        '0_5',
        '1',
        '1_5',
        '2',
        '2_5',
        '3',
        '4',
        '5',
        '6',
        '8',
        '10',
        '12',
      ],
      radius: [
        'none',
        'row',
        'control',
        'card',
        'menu-inner',
        'menu-outer',
        'pill',
      ],
      color: [
        'bg-card',
        'surface-raised',
        'text-primary',
        'text-secondary',
        'border-color',
        'state-hover',
        'state-active',
        'state-focus-ring',
        'accent',
      ],
    },
    classGroups: {
      // 保证 Conex 专有尺寸档位原子类（若后续引入原子类）具备互斥性
      'control-size': [{ size: ['xs', 'sm', 'md', 'lg'] }],
    },
  },
});

/**
 * 统一 ClassName 组装函数（SSOT）
 */
export function cn(...inputs: ClassValue[]): string {
  return customTwMerge(clsx(inputs));
}

export { cva };
export type { VariantProps, ClassValue };

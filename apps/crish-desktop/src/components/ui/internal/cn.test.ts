import { describe, it, expect } from 'vitest';
import { cn, cva, type VariantProps } from './cn';
import { cn as cnFromUtils, cva as cvaFromUtils } from '../utils/cn';
import { cn as cnFromBarrel, cva as cvaFromBarrel } from '../index';

describe('cn utility and CVA base', () => {
  it('correctly merges class names and filters falsy values', () => {
    const hidden = Boolean(0);
    expect(cn('base', hidden && 'hidden', undefined, null, 'active')).toBe(
      'base active'
    );
  });

  it('resolves tailwind spacing conflicts in favor of latter classes', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('px-2', 'px-6', 'py-1')).toBe('px-6 py-1');
  });

  it('correctly recognizes custom Conex design tokens in tailwind-merge', () => {
    // Custom radius token conflict
    expect(cn('rounded-card', 'rounded-pill')).toBe('rounded-pill');
    // Custom control-size conflict
    expect(cn('size-sm', 'size-md')).toBe('size-md');
  });

  it('creates typed variant matrices with cva', () => {
    const buttonVariants = cva('btn-base', {
      variants: {
        variant: {
          primary: 'btn-primary',
          secondary: 'btn-secondary',
        },
        size: {
          sm: 'size-sm',
          md: 'size-md',
        },
      },
      defaultVariants: {
        variant: 'secondary',
        size: 'md',
      },
    });

    type ButtonProps = VariantProps<typeof buttonVariants>;
    const defaultClasses = buttonVariants();
    expect(defaultClasses).toBe('btn-base btn-secondary size-md');

    const primarySmall = buttonVariants({ variant: 'primary', size: 'sm' });
    expect(primarySmall).toBe('btn-base btn-primary size-sm');

    // Combination with cn for external overrides
    const overridden = cn(buttonVariants({ size: 'sm' }), 'size-lg');
    expect(overridden).toBe('btn-base btn-secondary size-lg');
  });

  it('re-exports seamlessly from @/components/ui/utils/cn and @/components/ui', () => {
    expect(cnFromUtils('foo', 'bar')).toBe('foo bar');
    expect(typeof cvaFromUtils).toBe('function');
    expect(cnFromBarrel('foo', 'bar')).toBe('foo bar');
    expect(typeof cvaFromBarrel).toBe('function');
  });
});

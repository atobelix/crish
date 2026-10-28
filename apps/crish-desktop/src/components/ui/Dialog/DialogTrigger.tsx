import React from 'react';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogTrigger 触发器                                            */
/* -------------------------------------------------------------------------- */
export interface DialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: React.Ref<HTMLButtonElement>;
}

export function DialogTrigger({
  onClick,
  children,
  ref,
  ...props
}: DialogTriggerProps) {
  return (
    <button ref={ref} type="button" onClick={onClick} {...props}>
      {children}
    </button>
  );
}

import React from 'react';

export interface FieldContextValue {
  id?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const FieldContext = React.createContext<FieldContextValue>({});
export const useFieldContext = () => React.useContext(FieldContext);

export type FieldSize = 'sm' | 'md' | 'lg';
export type FieldLayout = 'vertical' | 'horizontal';

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: FieldSize;
  layout?: FieldLayout;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
}

export const Field: React.FC<FieldProps> = ({
  children,
  className,
  ...props
}) => {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  );
};

export const FormItem = Field;
export const FieldRoot = Field;

export type FormItemProps = FieldProps;
export type FieldRootProps = FieldProps;
export type FieldLabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;
export type FieldControlProps = React.HTMLAttributes<HTMLDivElement>;
export type FieldDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;
export type FieldHintProps = React.HTMLAttributes<HTMLSpanElement>;
export type FieldErrorProps = React.HTMLAttributes<HTMLParagraphElement>;
export type FieldRequiredIndicatorProps = React.HTMLAttributes<HTMLSpanElement>;

export const FieldLabel: React.FC<FieldLabelProps> = ({
  children,
  ...props
}) => <label {...props}>{children}</label>;
export const FieldControl: React.FC<FieldControlProps> = ({
  children,
  ...props
}) => <div {...props}>{children}</div>;
export const FieldDescription: React.FC<FieldDescriptionProps> = ({
  children,
  ...props
}) => <p {...props}>{children}</p>;
export const FieldHint: React.FC<FieldHintProps> = ({ children, ...props }) => (
  <span {...props}>{children}</span>
);
export const FieldError: React.FC<FieldErrorProps> = ({
  children,
  ...props
}) => <p {...props}>{children}</p>;
export const FieldRequiredIndicator: React.FC<FieldRequiredIndicatorProps> = ({
  children = '*',
  ...props
}) => <span {...props}>{children}</span>;

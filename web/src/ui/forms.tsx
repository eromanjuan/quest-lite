import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * Field is the only place label/required/hint/error wiring lives, so every
 * form in the app presents validation the same way and stays keyboard
 * reachable (the control is associated with its label and error text).
 */
export function Field({
  label,
  required,
  hint,
  error,
  children,
  className = '',
  htmlFor,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="req" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? <div className="hint">{hint}</div> : null}
      {error ? (
        <div className="err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  wrapClassName?: string;
}

export function Input({ label, hint, error, required, className = '', wrapClassName, ...rest }: InputProps) {
  const auto = useId();
  const id = rest.id ?? auto;
  const control = (
    <input
      id={id}
      className={`input ${className}`}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
      required={required}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id} className={wrapClassName}>
      <div id={`${id}-err`} className="sr-only" />
      {control}
    </Field>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export function Select({
  label,
  hint,
  error,
  required,
  options,
  placeholder,
  className = '',
  children,
  ...rest
}: SelectProps) {
  const auto = useId();
  const id = rest.id ?? auto;
  const control = (
    <select
      id={id}
      className={`select ${className}`}
      aria-invalid={error ? 'true' : undefined}
      required={required}
      {...rest}
    >
      {placeholder ? (
        <option value="">
          {placeholder}
        </option>
      ) : null}
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))
        : children}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      {control}
    </Field>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextArea({ label, hint, error, required, className = '', ...rest }: TextAreaProps) {
  const auto = useId();
  const id = rest.id ?? auto;
  const control = (
    <textarea
      id={id}
      className={`textarea ${className}`}
      aria-invalid={error ? 'true' : undefined}
      required={required}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      {control}
    </Field>
  );
}

export function Checkbox({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {hint ? <span className="hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
    </label>
  );
}

/** Standard footer for dialogs and forms. */
export function FormActions({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' | 'between' }) {
  const justify = align === 'start' ? 'flex-start' : align === 'between' ? 'space-between' : 'flex-end';
  return (
    <div className="row wrap" style={{ justifyContent: justify, marginTop: 4 }}>
      {children}
    </div>
  );
}

import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useText } from '../i18n'
import { cn } from './cn'

/** Control look without width; inputs add `w-full`. */
export const controlClasses =
  'block rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 shadow-xs transition-colors placeholder:text-stone-400 hover:border-stone-400 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500 aria-invalid:border-bad aria-invalid:focus-visible:outline-bad'

/** `${id}-error` when invalid, else `${id}-hint`; Field renders those ids. */
const describedBy = (id: string | undefined, invalid: boolean | undefined) => (id ? `${id}-${invalid ? 'error' : 'hint'}` : undefined)

/**
 * Labelled control. The control itself gets `id`; hint and error are rendered
 * with ids `${id}-hint` / `${id}-error`, which TextInput / TextArea wire through
 * aria-describedby from their own `id`. `aside` sits right of the label (a character count).
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  aside,
  className,
  children,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  const { t } = useText()
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-stone-800">
          {label}
          {required ? <span className="rounded bg-stone-100 px-1.5 py-px text-[11px] font-medium text-stone-500">{t('contacts.common.required')}</span> : null}
        </label>
        {aside ? <span className="text-xs text-stone-500 tabular-nums">{aside}</span> : null}
      </div>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-bad-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-stone-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function TextInput({
  invalid,
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(rest.id, invalid)}
      className={cn(controlClasses, 'h-10 w-full md:h-9', className)}
      {...rest}
    />
  )
}

/** Multi-line text; wires `${id}-hint` / `${id}-error` like TextInput. */
export function TextArea({ invalid, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy(rest.id, invalid)}
      className={cn(controlClasses, 'min-h-24 w-full resize-y py-2 leading-relaxed', className)}
      {...rest}
    />
  )
}

/** Native select (keyboard and mobile pickers for free); wires `${id}-hint` / `${id}-error` like TextInput. */
export function Select({ invalid, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select aria-invalid={invalid || undefined} aria-describedby={describedBy(rest.id, invalid)} className={cn(controlClasses, 'h-10 w-full pr-8 md:h-9', className)} {...rest}>
      {children}
    </select>
  )
}

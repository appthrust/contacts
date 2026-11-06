import { Loader2 } from 'lucide-react'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from './cn'
import { HrefLink } from './link'

export type ButtonTone = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

const TONE: Record<ButtonTone, string> = {
  primary: 'bg-accent text-white shadow-sm hover:bg-accent-strong disabled:bg-stone-300 disabled:shadow-none',
  secondary: 'border border-stone-300 bg-white text-stone-800 shadow-xs hover:bg-stone-50 hover:border-stone-400 disabled:text-stone-400 disabled:hover:bg-white',
  danger: 'bg-bad text-white shadow-sm hover:bg-bad-ink disabled:bg-stone-300 disabled:shadow-none',
  ghost: 'text-stone-700 hover:bg-stone-100 hover:text-stone-900 disabled:text-stone-400 disabled:hover:bg-transparent',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-10 gap-1.5 px-2.5 text-xs md:h-8',
  md: 'h-10 gap-2 px-3.5 text-sm md:h-9',
}

/** Shared by <Button> and <LinkButton> so buttons and button-styled links look and focus the same. */
export function buttonClasses(tone: ButtonTone = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:shrink-0',
    TONE[tone],
    SIZE[size],
    className
  )
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone
  size?: ButtonSize
  /** Shows a spinner, disables the button and sets aria-busy; the label stays so the width does not jump. */
  loading?: boolean
  /** Leading 16px lucide icon; always paired with the visible label. */
  icon?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function Button({ tone = 'secondary', size = 'md', loading = false, icon, className, type = 'button', disabled, children, ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={buttonClasses(tone, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 aria-hidden className="animate-spin" /> : icon ? <span aria-hidden className="contents">{icon}</span> : null}
      {children}
    </button>
  )
}

/** Compact row action with an accessible name and a 40px mobile target. */
export function IconButton({ label, size = 'sm', tone = 'ghost', className, ...rest }: Omit<ButtonProps, 'children' | 'aria-label'> & { label: string }) {
  return <Button {...rest} aria-label={label} title={label} tone={tone} size={size} className={cn('w-10 px-0', size === 'sm' ? 'md:w-8' : 'md:w-9', className)} />
}

export type LinkButtonProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  tone?: ButtonTone
  size?: ButtonSize
  icon?: ReactNode
  /** Contacts URL (`paths.*`); navigates inside the SPA. */
  href: string
}

/** A router link that looks like a button. */
export function LinkButton({ tone = 'secondary', size = 'md', icon, href, className, children, ...rest }: LinkButtonProps) {
  return (
    <HrefLink href={href} className={buttonClasses(tone, size, className)} {...rest}>
      {icon ? <span aria-hidden className="contents">{icon}</span> : null}
      {children}
    </HrefLink>
  )
}

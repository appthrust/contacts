import type { ReactNode } from 'react'
import { cn } from './cn'

const AVATAR_SIZE = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-16 text-xl' } as const

/**
 * Up to two initials: the first letters of the first two words of a Latin name
 * ("Ada Lovelace" → "AL"), else the first character ("山田 太郎" → "山").
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = Array.from(words[0] ?? '')[0]
  if (!first) return '?'
  const second = Array.from(words[1] ?? '')[0]
  return /^[A-Za-z]$/.test(first) && second && /^[A-Za-z]$/.test(second) ? `${first}${second}`.toUpperCase() : first.toUpperCase()
}

/**
 * A member's initials in a neutral circle. No image is fetched (a Directory
 * photo is cross-origin and would hit the OIDC edge). Decorative; the name is
 * always shown next to it.
 */
export function Avatar({ name, size = 'md' }: { name: string; size?: keyof typeof AVATAR_SIZE }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong ring-1 ring-accent-line ring-inset', AVATAR_SIZE[size])}
    >
      {initialsOf(name)}
    </span>
  )
}

const BADGE_TONE = {
  neutral: 'bg-stone-100 text-stone-600 ring-stone-200',
  accent: 'bg-accent-soft text-accent-strong ring-accent-line',
  warning: 'bg-busy-soft text-busy-ink ring-amber-200',
  danger: 'bg-bad-soft text-bad-ink ring-red-200',
} as const

export type BadgeTone = keyof typeof BADGE_TONE

/** Small label next to a title or name (「下書き」, 「あなた」); `icon` is a leading 12px lucide icon. */
export function Badge({ children, tone = 'neutral', icon, title }: { children: ReactNode; tone?: BadgeTone; icon?: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset [&_svg]:size-3 [&_svg]:shrink-0', BADGE_TONE[tone])}
    >
      {icon ? <span aria-hidden className="contents">{icon}</span> : null}
      {children}
    </span>
  )
}

/** "2026年10月16日" / "Oct 16, 2026" for an ISO timestamp, in the reader's time zone. */
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso))
}

/** "2026年10月16日 14:05" / "Oct 16, 2026, 2:05 PM". */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

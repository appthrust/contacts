import { AlertTriangle, CheckCircle2, Info, Loader2, RotateCw, X, XCircle } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { isContactsError } from '../api/contacts'
import type { MessageId } from '../copy'
import { useText } from '../i18n'
import { Button } from './button'
import { cn } from './cn'

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

const NOTICE: Record<NoticeTone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-stone-200 bg-white text-stone-700', icon: <Info className="text-accent" /> },
  success: { box: 'border-accent-line bg-accent-soft text-accent-strong', icon: <CheckCircle2 /> },
  warning: { box: 'border-amber-200 bg-busy-soft text-busy-ink', icon: <AlertTriangle /> },
  error: { box: 'border-red-200 bg-bad-soft text-bad-ink', icon: <XCircle /> },
}

export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const style = NOTICE[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0', style.box, className)}
    >
      {style.icon}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title ? 'mt-0.5 opacity-90' : undefined)}>{children}</div> : null}
        {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, body, action, heading = 'p' }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; heading?: 'p' | 'h1' }) {
  const Heading = heading
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-stone-300 bg-white px-6 py-12 text-center">
      {icon ? (
        <span aria-hidden className="mb-3 flex size-10 items-center justify-center rounded-full bg-stone-100 text-stone-500 [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <Heading className={cn('font-medium text-stone-800', heading === 'h1' ? 'text-xl' : 'text-sm')}>{title}</Heading>
      {body ? <div className="mt-1 max-w-sm text-sm text-stone-500">{body}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Loading({ className }: { className?: string }) {
  const { t } = useText()
  return (
    <p role="status" className={cn('flex items-center gap-2 py-6 text-sm text-stone-500', className)}>
      <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
      {t('contacts.common.loading')}
    </p>
  )
}

/** A 401 cannot be fixed by retrying, so it gets the access-denied text and no retry button. */
export function LoadFailed({ error, onRetry }: { error?: unknown; onRetry: () => void }) {
  const { t } = useText()
  if (isContactsError(error) && error.status === 401) return <Notice tone="error">{t('contacts.common.accessDenied')}</Notice>
  const known = errorMessageId(error)
  return (
    <Notice
      tone="error"
      title={t('contacts.common.loadFailed')}
      actions={
        <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
          {t('contacts.common.retry')}
        </Button>
      }
    >
      {known ? t(known) : null}
    </Notice>
  )
}

/** The localized explanation for a known contacts error, else undefined. */
export function errorMessageId(error: unknown): MessageId | undefined {
  if (!isContactsError(error)) return undefined
  if (error.transient) return 'contacts.errors.transient'
  if (error.status === 401) return 'contacts.common.accessDenied'
  if (error.code === 'contacts_store_unavailable') return 'contacts.errors.storeUnavailable'
  if (error.code === 'identity_unavailable') return 'contacts.errors.identityUnavailable'
  if (error.code === 'version_conflict') return 'contacts.errors.versionConflict'
  if (error.code === 'ocr_unavailable') return 'contacts.errors.ocrUnavailable'
  if (error.code === 'image_too_large') return 'contacts.errors.imageTooLarge'
  if (error.code === 'unsupported_image') return 'contacts.errors.unsupportedImage'
  if (error.status === 403) return 'contacts.errors.forbidden'
  if (error.status === 404) return 'contacts.errors.notFound'
  if (error.status === 400) return 'contacts.errors.invalid'
  return undefined
}

/**
 * Failed mutation: the localized explanation first; the server's message (not
 * localized) as a secondary hint for 400s, whose cause the summary cannot name.
 */
export function ActionError({ error, className }: { error: unknown; className?: string }) {
  const { t } = useText()
  const known = errorMessageId(error)
  const detail = isContactsError(error) && error.status === 400 && error.code === 'invalid_request' ? error.message : undefined
  return (
    <Notice tone="error" title={known ? undefined : t('contacts.common.actionFailed')} className={className}>
      {known ? t(known) : null}
      {detail ? <span className="mt-0.5 block text-xs opacity-80">{detail}</span> : null}
    </Notice>
  )
}

/**
 * A short success confirmation pinned to the bottom of the viewport (after a save that leaves the
 * user on the same screen). Announced politely; hides after `durationMs` or on its close button.
 */
export function Toast({ children, onDismiss, durationMs = 4000 }: { children: ReactNode; onDismiss: () => void; durationMs?: number }) {
  const { t } = useText()
  // The timer starts once per toast; a parent re-render with a new callback does not restart it.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), durationMs)
    return () => clearTimeout(timer)
  }, [durationMs])
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex max-w-md items-center gap-2 rounded-lg bg-stone-900 py-2 pr-2 pl-4 text-sm text-white shadow-lg animate-pop-in [&>svg]:size-4 [&>svg]:shrink-0"
      >
        <CheckCircle2 aria-hidden className="text-accent-line" />
        <span className="min-w-0 flex-1">{children}</span>
        <button
          type="button"
          aria-label={t('contacts.common.close')}
          onClick={() => dismiss.current()}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-stone-300 hover:bg-white/10 hover:text-white focus-visible:outline-white"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  )
}

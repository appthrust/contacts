import { X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { useText } from '../i18n'
import { Button, type ButtonTone } from './button'
import { cn } from './cn'
import { ActionError } from './feedback'
import { useReturnFocus } from './focus'

/** Modal dialog (Radix): focus trap, Escape closes, focus returns to the trigger. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  onEscapeKeyDown,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** `lg` for editors with rows of controls; `xl` for the card confirm panel (image, form and candidates side by side). */
  size?: 'md' | 'lg' | 'xl'
  /** Lets an open popup inside the dialog (a listbox) take Escape first: call `preventDefault()` to keep the dialog open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void
}) {
  const { t } = useText()
  const focus = useReturnFocus(open)
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-stone-900/40 animate-fade-in" />
        <RDialog.Content
          {...focus}
          onEscapeKeyDown={onEscapeKeyDown}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-xl bg-white shadow-xl animate-pop-in focus:outline-none',
            'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            size === 'xl' ? 'sm:max-w-5xl' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold text-stone-900">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-stone-500">{description}</RDialog.Description> : null}
            </div>
            <RDialog.Close
              aria-label={t('contacts.common.close')}
              className="-mt-1 -mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800 md:size-8"
            >
              <X aria-hidden className="size-4" />
            </RDialog.Close>
          </div>
          {children ? <div className="px-5 pt-4 pb-5 text-sm text-stone-700">{children}</div> : <div className="pb-5" />}
          {footer ? (
            <div className="flex flex-col-reverse gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-3 sm:flex-row sm:justify-end">{footer}</div>
          ) : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

/** Confirmation for irreversible actions; the failure stays inside the dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  pending = false,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  body: ReactNode
  confirmLabel: string
  tone?: Extract<ButtonTone, 'primary' | 'danger'>
  onConfirm: () => void
  pending?: boolean
  error?: unknown
}) {
  const { t } = useText()
  const change = (next: boolean) => {
    if (!pending) onOpenChange(next)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={title}
      footer={
        <>
          <Button onClick={() => change(false)} disabled={pending}>
            {t('contacts.common.cancel')}
          </Button>
          <Button tone={tone} onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>{body}</div>
        {error ? <ActionError error={error} /> : null}
      </div>
    </Dialog>
  )
}

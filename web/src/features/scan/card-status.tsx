import { AlertTriangle, CheckCircle2, CircleAlert, Keyboard, Loader2, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BusinessCard } from '../../api/contacts'
import type { MessageId } from '../../copy'
import { useText, type Translate } from '../../i18n'
import { cardName } from '../../model/contact'
import { cardFields, parseReviewReason, type CardStatus, type ReviewReasonCode } from '../../model/registration'
import { cn } from '../../ui'

/** Form labels for the fields a `missing_field:<field>` reason can name; an unknown field shows its raw name. */
const FIELD_LABELS: Record<string, MessageId> = {
  fullName: 'contacts.form.fullName',
  kana: 'contacts.form.kana',
  company: 'contacts.form.company',
  department: 'contacts.form.department',
  title: 'contacts.form.title',
  emails: 'contacts.form.emails',
  phones: 'contacts.form.phones',
  address: 'contacts.form.address',
}

const REASON_TEXT: Record<ReviewReasonCode | 'other', MessageId> = {
  ambiguous_match: 'contacts.reason.ambiguousMatch',
  low_confidence: 'contacts.reason.lowConfidence',
  policy: 'contacts.reason.policy',
  unlinked: 'contacts.reason.unlinked',
  other: 'contacts.reason.other',
}

/** Why a card waits for review, in words; null when no reason was recorded. */
export function reviewReasonText(t: Translate, reason: string | null): string | null {
  if (!reason) return null
  const parsed = parseReviewReason(reason)
  if (parsed.kind === 'missing_field') {
    const label = FIELD_LABELS[parsed.field]
    return t('contacts.reason.missingField', { field: label ? t(label) : parsed.field })
  }
  return t(REASON_TEXT[parsed.kind])
}

/** "Needs review: <reason>" (or just "Needs review"). */
export function reviewTitle(t: Translate, reason: string | null): string {
  const text = reviewReasonText(t, reason)
  return text ? t('contacts.scan.review', { reason: text }) : t('contacts.scan.reviewNoReason')
}

const TONE = {
  neutral: 'bg-stone-100 text-stone-700 ring-stone-200',
  accent: 'bg-accent-soft text-accent-strong ring-accent-line',
  warning: 'bg-busy-soft text-busy-ink ring-amber-200',
  danger: 'bg-bad-soft text-bad-ink ring-red-200',
} as const

/** The chip's words, tone and icon for a status. */
export function cardStatusLabel(t: Translate, status: CardStatus, card: Pick<BusinessCard, 'extraction'>): { text: string; tone: keyof typeof TONE; icon: ReactNode } {
  switch (status.kind) {
    case 'registered': {
      const name = cardName(card) ?? t('contacts.scan.unnamed')
      const company = cardFields(card)?.company?.trim()
      return {
        text: company ? t('contacts.scan.registered', { name, company }) : t('contacts.scan.registeredNoCompany', { name }),
        tone: 'accent',
        icon: <Sparkles />,
      }
    }
    case 'linked':
      return { text: t('contacts.scan.linked'), tone: 'accent', icon: <CheckCircle2 /> }
    case 'reading':
      return { text: t('contacts.ocr.pending'), tone: 'neutral', icon: <Loader2 className="animate-spin" /> }
    case 'failed':
      return { text: t('contacts.ocr.failed'), tone: 'danger', icon: <AlertTriangle /> }
    case 'unavailable':
      return { text: t('contacts.ocr.unavailable'), tone: 'warning', icon: <Keyboard /> }
    case 'review':
      return { text: reviewTitle(t, status.reason), tone: 'warning', icon: <CircleAlert /> }
  }
}

/**
 * A card's status on the scan screen: reading → registered (name / company) /
 * needs review (why) / OCR unavailable / failed. Unlike a Badge it wraps, since
 * "registered" carries the name and company.
 */
export function CardStatusChip({ status, card, className }: { status: CardStatus; card: Pick<BusinessCard, 'extraction'>; className?: string }) {
  const { t } = useText()
  const { text, tone, icon } = cardStatusLabel(t, status, card)
  return (
    <p
      className={cn(
        'inline-flex max-w-full items-start gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0',
        TONE[tone],
        className
      )}
    >
      <span aria-hidden className="contents">
        {icon}
      </span>
      <span className="min-w-0 break-words">{text}</span>
    </p>
  )
}

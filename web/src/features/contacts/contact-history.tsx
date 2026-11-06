import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import type { ContactChange } from '../../api/contacts'
import { companyOptionsQuery, tagsQuery } from '../../api/queries'
import type { MessageId } from '../../copy'
import { useText } from '../../i18n'
import { Badge, formatDateTime } from '../../ui'

const FIELD_LABELS: Record<string, MessageId> = {
  fullName: 'contacts.form.fullName',
  kana: 'contacts.form.kana',
  company: 'contacts.form.company',
  companyId: 'contacts.form.company',
  companyName: 'contacts.form.company',
  department: 'contacts.form.department',
  title: 'contacts.form.title',
  emails: 'contacts.form.emails',
  phones: 'contacts.form.phones',
  address: 'contacts.form.address',
  notes: 'contacts.form.notes',
  visibility: 'contacts.form.visibility',
  state: 'contacts.history.state',
  tags: 'contacts.tags.title',
  cards: 'contacts.history.cards',
  // The server records a card joining or leaving a contact under these keys.
  addedCard: 'contacts.history.cards',
  removedCard: 'contacts.history.cards',
  mergedFrom: 'contacts.history.mergedFrom',
  mergedInto: 'contacts.history.mergedInto',
}

/**
 * Who changed what, newest first (C2); changes automatic registration made are tagged. Ids in a diff
 * (tags, company) show as names when this member can see them.
 */
export function ContactHistory({ changes }: { changes: ContactChange[] }) {
  const { t, locale } = useText()
  const tags = useQuery(tagsQuery)
  const companies = useQuery(companyOptionsQuery)
  const names = new Map<string, string>([...(tags.data ?? []).map((tag) => [tag.id, tag.name] as const), ...(companies.data ?? []).map((company) => [company.id, company.name] as const)])

  const show = (value: unknown): string => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return '—'
    if (Array.isArray(value)) return value.map(show).join(', ')
    if (typeof value === 'string') {
      if (value === 'shared') return t('contacts.form.shared')
      if (value === 'private') return t('contacts.form.private')
      return names.get(value) ?? value
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }

  if (changes.length === 0) return <p className="text-sm text-stone-500">{t('contacts.history.none')}</p>
  return (
    <ol className="grid gap-3">
      {changes.map((change) => (
        <li key={change.id} className="rounded-lg border border-line bg-white px-4 py-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
            <span className="font-medium text-stone-800">{change.actor.displayName || t('contacts.common.unknownMember')}</span>
            {change.source === 'auto' ? (
              <Badge tone="accent" icon={<Sparkles />} title={t('contacts.history.autoTitle')}>
                {t('contacts.history.auto')}
              </Badge>
            ) : null}
            <time dateTime={change.at}>{formatDateTime(change.at, locale)}</time>
          </p>
          <dl className="mt-1.5 grid gap-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            {Object.entries(change.diff).map(([field, { from, to }]) => (
              <div key={field} className="contents">
                <dt className="text-stone-500">{FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field}</dt>
                <dd className="min-w-0 break-words text-stone-800">
                  {from === null || from === undefined ? (
                    show(to)
                  ) : (
                    <>
                      <span className="text-stone-500 line-through decoration-stone-300">{show(from)}</span>
                      <span aria-hidden className="mx-1.5 text-stone-400">
                        →
                      </span>
                      <span className="sr-only">{t('contacts.history.to')}</span>
                      {show(to)}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  )
}

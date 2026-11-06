import { useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { Building2, CheckCircle2, ChevronDown, Lock, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ContactSummary } from '../../api/contacts'
import { contactsQuery, type ContactFilters } from '../../api/queries'
import { useText } from '../../i18n'
import { groupByCompany } from '../../model/contact'
import { paths } from '../../routes/paths'
import { ActionError, Badge, Button, formatDate, HrefLink } from '../../ui'

/** Contacts matching `filters`, grouped by company (or flat inside one company's page), one more cursor page per もっと見る. */
export function ContactList({ filters, empty, grouped = true }: { filters: ContactFilters; empty: ReactNode; grouped?: boolean }) {
  const { t } = useText()
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, error } = useSuspenseInfiniteQuery(contactsQuery(filters))
  const contacts = data.pages.flatMap((page) => page.items)
  if (contacts.length === 0) return <>{empty}</>
  const groups = grouped ? groupByCompany(contacts) : [{ company: null, contacts }]
  return (
    <div>
      <div className="grid gap-6">
        {groups.map((group) => (
          <section key={group.company?.id ?? ''} aria-label={grouped ? (group.company?.name ?? t('contacts.list.noCompany')) : undefined}>
            {grouped ? (
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-stone-700 [&_svg]:size-4">
                <Building2 aria-hidden className="text-stone-400" />
                {group.company ? (
                  <HrefLink href={paths.company(group.company.id)} className="hover:text-accent-strong hover:underline">
                    {group.company.name}
                  </HrefLink>
                ) : (
                  t('contacts.list.noCompany')
                )}
                <span className="font-normal text-stone-400 tabular-nums">{group.contacts.length}</span>
              </h2>
            ) : null}
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
              {group.contacts.map((contact) => (
                <li key={contact.id}>
                  <ContactRow contact={contact} showCompany={!grouped} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {isFetchNextPageError ? <ActionError error={error} className="mt-4" /> : null}
      {hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button icon={<ChevronDown />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t('contacts.common.loadMore')}
          </Button>
        </div>
      ) : data.pages.length > 1 ? (
        <p className="mt-6 text-center text-xs text-stone-500">{t('contacts.common.end')}</p>
      ) : null}
    </div>
  )
}

/** One contact: name (the link covers the row), role, tags, "met by N" and whether the caller met them. */
export function ContactRow({ contact, showCompany = false }: { contact: ContactSummary; showCompany?: boolean }) {
  const { t, locale } = useText()
  const role = [showCompany ? contact.company?.name : undefined, contact.department, contact.title].filter(Boolean).join(' · ')
  return (
    <div className="group relative flex flex-col gap-2 px-4 py-3 hover:bg-stone-50 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <HrefLink
            href={paths.contact(contact.id)}
            className="font-semibold text-stone-900 group-hover:text-accent-strong after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
          >
            {contact.fullName}
          </HrefLink>
          {contact.kana ? <span className="text-xs text-stone-500">{contact.kana}</span> : null}
          {contact.visibility === 'private' ? (
            <Badge icon={<Lock />}>{t('contacts.contact.private')}</Badge>
          ) : null}
          {contact.state !== 'active' ? <Badge tone="warning">{t(contact.state === 'draft' ? 'contacts.contact.draft' : 'contacts.contact.archived')}</Badge> : null}
        </p>
        {role ? <p className="mt-0.5 truncate text-xs text-stone-600">{role}</p> : null}
        {contact.tags.length > 0 ? (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {contact.tags.map((tag) => (
              <Badge key={tag.id}>{tag.name}</Badge>
            ))}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-stone-500 sm:justify-end">
        {contact.knownByMe ? (
          <Badge tone="accent" icon={<CheckCircle2 />}>
            {t('contacts.list.knownByMe')}
          </Badge>
        ) : null}
        <Badge icon={<Users />} title={t('contacts.list.metByTitle')}>
          {t('contacts.list.metBy', { count: contact.encounterCount })}
        </Badge>
        {contact.lastMetAt ? <time dateTime={contact.lastMetAt}>{t('contacts.list.lastMet', { date: formatDate(contact.lastMetAt, locale) })}</time> : null}
      </div>
    </div>
  )
}

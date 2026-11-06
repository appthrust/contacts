import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Search, Users, X } from 'lucide-react'
import { Suspense, useEffect, useId, useRef, useState } from 'react'
import { companyOptionsQuery, tagsQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { paths, type ContactsSearch } from '../../routes/paths'
import { Button, controlClasses, cn, EmptyState, LinkButton, Loading, PageHeader, Select, useDocumentTitle } from '../../ui'
import { ContactList } from './contact-list'

/**
 * `/contacts`: search (name, kana, company, email), filters (company, tag,
 * known by me) and the result grouped by company. Every filter lives in the
 * URL so a filtered list can be shared and survives reloads.
 */
export function ContactsPage({ search }: { search: ContactsSearch }) {
  const { t } = useText()
  const id = useId()
  const navigate = useNavigate()
  const companies = useQuery(companyOptionsQuery)
  const tags = useQuery(tagsQuery)
  const [q, setQ] = useState(search.q ?? '')
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(typing.current), [])
  useDocumentTitle(t('contacts.nav.contacts'))

  const go = (next: ContactsSearch) => void navigate({ to: '/contacts', search: next, replace: true })
  // The query reaches the URL (and the server) once typing pauses; other filters apply at once.
  const type = (value: string) => {
    setQ(value)
    clearTimeout(typing.current)
    typing.current = setTimeout(() => {
      const next = value.trim() || undefined
      void navigate({ to: '/contacts', search: (current: ContactsSearch) => ({ ...current, q: next }), replace: true })
    }, 300)
  }

  const filtered = Boolean(search.q || search.company || search.tag || search.known)
  return (
    <div>
      <PageHeader
        title={t('contacts.nav.contacts')}
        lead={t('contacts.list.lead')}
        actions={
          <LinkButton href={paths.scan} tone="primary">
            {t('contacts.nav.scan')}
          </LinkButton>
        }
      >
        <form role="search" onSubmit={(event) => event.preventDefault()} className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div>
            <label htmlFor={`${id}-q`} className="sr-only">
              {t('contacts.common.search')}
            </label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <input
                id={`${id}-q`}
                type="search"
                value={q}
                onChange={(event) => type(event.target.value)}
                placeholder={t('contacts.list.searchPlaceholder')}
                className={cn(controlClasses, 'h-10 w-full pl-9 md:h-9')}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-company`} className="sr-only">
              {t('contacts.form.company')}
            </label>
            <Select id={`${id}-company`} value={search.company ?? ''} onChange={(event) => go({ ...search, company: event.target.value || undefined })}>
              <option value="">{t('contacts.list.allCompanies')}</option>
              {(companies.data ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor={`${id}-tag`} className="sr-only">
              {t('contacts.list.filterTag')}
            </label>
            <Select id={`${id}-tag`} value={search.tag ?? ''} onChange={(event) => go({ ...search, tag: event.target.value || undefined })}>
              <option value="">{t('contacts.list.allTags')}</option>
              {(tags.data ?? []).map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-stone-700 md:min-h-9">
            <input
              type="checkbox"
              checked={search.known === 'me'}
              onChange={(event) => go({ ...search, known: event.target.checked ? 'me' : undefined })}
              className="size-4 accent-[var(--color-accent)]"
            />
            {t('contacts.list.knownByMeFilter')}
          </label>
        </form>
        {filtered ? (
          <Button
            size="sm"
            tone="ghost"
            icon={<X />}
            className="mt-2"
            onClick={() => {
              clearTimeout(typing.current)
              setQ('')
              go({})
            }}
          >
            {t('contacts.list.clear')}
          </Button>
        ) : null}
      </PageHeader>
      {/* A new filter set suspends only the list, never the controls above it. */}
      <Suspense fallback={<Loading />}>
        <ContactList
          filters={{ q: search.q, companyId: search.company, tag: search.tag, knownBy: search.known }}
          empty={
            <EmptyState
              icon={<Users />}
              title={t(filtered ? 'contacts.list.noMatchTitle' : 'contacts.list.emptyTitle')}
              body={t(filtered ? 'contacts.list.noMatchBody' : 'contacts.list.emptyBody')}
              action={
                filtered ? undefined : (
                  <LinkButton href={paths.scan} tone="primary">
                    {t('contacts.nav.scan')}
                  </LinkButton>
                )
              }
            />
          }
        />
      </Suspense>
    </div>
  )
}

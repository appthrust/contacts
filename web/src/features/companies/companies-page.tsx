import { useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Building2, ChevronDown, Search } from 'lucide-react'
import { Suspense, useEffect, useId, useRef, useState } from 'react'
import { companiesQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { ActionError, Button, cn, controlClasses, EmptyState, HrefLink, Loading, PageHeader, useDocumentTitle } from '../../ui'

/** `/companies`: every (unmerged) company with its contact count, searchable by name or domain. */
export function CompaniesPage({ q }: { q?: string }) {
  const { t } = useText()
  const id = useId()
  const navigate = useNavigate()
  const [text, setText] = useState(q ?? '')
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(typing.current), [])
  useDocumentTitle(t('contacts.nav.companies'))
  const type = (value: string) => {
    setText(value)
    clearTimeout(typing.current)
    typing.current = setTimeout(() => void navigate({ to: '/companies', search: value.trim() ? { q: value.trim() } : {}, replace: true }), 300)
  }
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t('contacts.nav.companies')} lead={t('contacts.companies.lead')}>
        <form role="search" onSubmit={(event) => event.preventDefault()} className="max-w-md">
          <label htmlFor={`${id}-q`} className="sr-only">
            {t('contacts.common.search')}
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <input
              id={`${id}-q`}
              type="search"
              value={text}
              onChange={(event) => type(event.target.value)}
              placeholder={t('contacts.companies.searchPlaceholder')}
              className={cn(controlClasses, 'h-10 w-full pl-9 md:h-9')}
            />
          </div>
        </form>
      </PageHeader>
      <Suspense fallback={<Loading />}>
        <CompanyList q={q} />
      </Suspense>
    </div>
  )
}

function CompanyList({ q }: { q?: string }) {
  const { t } = useText()
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, error } = useSuspenseInfiniteQuery(companiesQuery({ q }))
  const companies = data.pages.flatMap((page) => page.items)
  if (companies.length === 0) {
    return <EmptyState icon={<Building2 />} title={t(q ? 'contacts.companies.noMatch' : 'contacts.companies.empty')} />
  }
  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
        {companies.map((company) => (
          <li key={company.id} className="group relative flex items-center gap-3 px-4 py-3 hover:bg-stone-50">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-500 [&_svg]:size-4">
              <Building2 />
            </span>
            <span className="min-w-0 flex-1">
              <HrefLink
                href={paths.company(company.id)}
                className="block truncate font-semibold text-stone-900 group-hover:text-accent-strong after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {company.name}
              </HrefLink>
              {company.domain ? <span className="block truncate text-xs text-stone-500">{company.domain}</span> : null}
            </span>
            <span className="shrink-0 text-xs text-stone-500 tabular-nums">{t('contacts.companies.contactCount', { count: company.contactCount })}</span>
          </li>
        ))}
      </ul>
      {isFetchNextPageError ? <ActionError error={error} className="mt-4" /> : null}
      {hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button icon={<ChevronDown />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t('contacts.common.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

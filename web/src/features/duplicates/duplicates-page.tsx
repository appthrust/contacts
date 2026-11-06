import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Mail, Users } from 'lucide-react'
import { contactsApi, type ContactSummary, type DuplicateCandidate } from '../../api/contacts'
import { contactQuery, duplicatesQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { ActionError, Badge, Button, EmptyState, HrefLink, PageHeader, useDocumentTitle } from '../../ui'

/**
 * `/duplicates`: pairs the server proposes (same normalised name and email
 * domain, or name and company; C4), side by side. Merging keeps one side's
 * profile and moves the other's cards and tags into it; nothing merges on its own.
 */
export function DuplicatesPage() {
  const { t } = useText()
  const { data: pairs } = useSuspenseQuery(duplicatesQuery)
  useDocumentTitle(t('contacts.duplicates.title'))
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t('contacts.duplicates.title')} lead={t('contacts.duplicates.lead')} />
      {pairs.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title={t('contacts.duplicates.emptyTitle')} body={t('contacts.duplicates.emptyBody')} />
      ) : (
        <ul className="grid gap-4">
          {pairs.map((pair) => (
            <li key={`${pair.contacts[0].id}:${pair.contacts[1].id}`}>
              <Pair pair={pair} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Pair({ pair }: { pair: DuplicateCandidate }) {
  const { t } = useText()
  const client = useQueryClient()
  const [left, right] = pair.contacts
  const merge = useMutation({
    mutationFn: async ({ target, source }: { target: string; source: string }) => {
      // The merge is guarded by the kept contact's current version.
      const latest = await client.fetchQuery({ ...contactQuery(target), staleTime: 0 })
      return contactsApi.contacts.merge(target, latest.version, source)
    },
    onSuccess: () => invalidateContacts(client),
  })
  const pending = merge.isPending ? merge.variables : undefined
  return (
    <article className="rounded-lg border border-line bg-white p-4">
      <p className="mb-3">
        <Badge tone="warning">{t(pair.reason === 'name_domain' ? 'contacts.duplicates.nameDomain' : 'contacts.duplicates.nameCompany')}</Badge>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Side contact={left} />
        <Side contact={right} />
      </div>
      {merge.isError ? <ActionError error={merge.error} className="mt-3" /> : null}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button
          icon={<ArrowLeft />}
          loading={pending?.target === left.id}
          disabled={merge.isPending}
          onClick={() => merge.mutate({ target: left.id, source: right.id })}
        >
          {t('contacts.duplicates.keepLeft')}
        </Button>
        <Button
          icon={<ArrowRight />}
          loading={pending?.target === right.id}
          disabled={merge.isPending}
          onClick={() => merge.mutate({ target: right.id, source: left.id })}
          className="sm:flex-row-reverse"
        >
          {t('contacts.duplicates.keepRight')}
        </Button>
      </div>
    </article>
  )
}

function Side({ contact }: { contact: ContactSummary }) {
  const { t } = useText()
  const role = [contact.department, contact.title].filter(Boolean).join(' · ')
  return (
    <div className="rounded-md border border-line bg-stone-50/60 px-3.5 py-3 text-sm">
      <HrefLink href={paths.contact(contact.id)} className="font-semibold text-stone-900 hover:text-accent-strong hover:underline">
        {contact.fullName}
      </HrefLink>
      {contact.kana ? <span className="ml-2 text-xs text-stone-500">{contact.kana}</span> : null}
      <dl className="mt-2 grid gap-1 text-xs text-stone-600 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-stone-400">
        <div className="flex items-center gap-1.5">
          <dt>
            <Building2 aria-hidden />
            <span className="sr-only">{t('contacts.form.company')}</span>
          </dt>
          <dd className="truncate">{[contact.company?.name, role].filter(Boolean).join(' · ') || '—'}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>
            <Mail aria-hidden />
            <span className="sr-only">{t('contacts.form.emails')}</span>
          </dt>
          <dd className="truncate">{contact.primaryEmail ?? '—'}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>
            <Users aria-hidden />
            <span className="sr-only">{t('contacts.list.metByTitle')}</span>
          </dt>
          <dd>{t('contacts.list.metBy', { count: contact.encounterCount })}</dd>
        </div>
      </dl>
    </div>
  )
}

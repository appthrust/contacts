import { useInfiniteQuery, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Combine, ExternalLink, Globe, MapPin, Pencil, Search, Users } from 'lucide-react'
import { Suspense, useId, useState } from 'react'
import { contactsApi, type Company } from '../../api/contacts'
import { companiesQuery, companyQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { ActionError, Button, cn, controlClasses, Dialog, EmptyState, Field, Loading, PageHeader, Section, TextInput, useDebouncedValue, useDocumentTitle } from '../../ui'
import { ContactList } from '../contacts/contact-list'

/** `/companies/<id>`: the company's fields (editable), its contacts, and — for admins — merging another company into it (C3). */
export function CompanyPage({ companyId }: { companyId: string }) {
  const { t } = useText()
  const { me } = useSession()
  const { data: company } = useSuspenseQuery(companyQuery(companyId))
  const [editing, setEditing] = useState(false)
  useDocumentTitle(company.name)
  const url = company.url && /^https?:\/\//i.test(company.url) ? company.url : undefined
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: t('contacts.nav.companies'), href: paths.companies() }]}
        title={company.name}
        lead={t('contacts.companies.contactCount', { count: company.contactCount })}
        actions={
          <>
            <Button icon={<Pencil />} onClick={() => setEditing(true)}>
              {t('contacts.common.edit')}
            </Button>
            {me.roles.contactsAdmin ? <MergeCompany company={company} /> : null}
          </>
        }
      >
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-stone-600 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-400">
          {company.domain ? (
            <li className="flex items-center gap-1.5">
              <Globe aria-hidden />
              <span className="sr-only">{t('contacts.companies.domain')}: </span>
              {company.domain}
            </li>
          ) : null}
          {company.address ? (
            <li className="flex items-center gap-1.5">
              <MapPin aria-hidden />
              <span className="sr-only">{t('contacts.form.address')}: </span>
              {company.address}
            </li>
          ) : null}
          {url ? (
            <li>
              <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-accent-strong hover:underline">
                <ExternalLink aria-hidden />
                {company.url}
              </a>
            </li>
          ) : null}
        </ul>
      </PageHeader>
      <Section title={t('contacts.companies.people')}>
        <Suspense fallback={<Loading />}>
          <ContactList filters={{ companyId: company.id }} grouped={false} empty={<EmptyState icon={<Users />} title={t('contacts.companies.noPeople')} />} />
        </Suspense>
      </Section>
      <EditCompany key={company.updatedAt} company={company} open={editing} onOpenChange={setEditing} />
    </div>
  )
}

function EditCompany({ company, open, onOpenChange }: { company: Company; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useText()
  const id = useId()
  const client = useQueryClient()
  const [form, setForm] = useState({ name: company.name, domain: company.domain ?? '', address: company.address ?? '', url: company.url ?? '' })
  const save = useMutation({
    mutationFn: () =>
      contactsApi.companies.update(company.id, { name: form.name.trim(), domain: form.domain.trim() || null, address: form.address.trim() || null, url: form.url.trim() || null }),
    onSuccess: async (saved) => {
      client.setQueryData(companyQuery(company.id).queryKey, saved)
      onOpenChange(false)
      await invalidateContacts(client)
    },
  })
  const set = (field: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value })
  const nameMissing = !form.name.trim()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return
        onOpenChange(next)
        if (!next) save.reset()
      }}
      title={t('contacts.companies.editTitle')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t('contacts.common.cancel')}
          </Button>
          <Button tone="primary" loading={save.isPending} disabled={nameMissing} onClick={() => save.mutate()}>
            {t('contacts.common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field id={`${id}-name`} label={t('contacts.companies.name')} required error={nameMissing ? t('contacts.companies.nameRequired') : undefined}>
          <TextInput id={`${id}-name`} value={form.name} onChange={set('name')} invalid={nameMissing} />
        </Field>
        <Field id={`${id}-domain`} label={t('contacts.companies.domain')}>
          <TextInput id={`${id}-domain`} value={form.domain} onChange={set('domain')} placeholder="example.co.jp" />
        </Field>
        <Field id={`${id}-address`} label={t('contacts.form.address')}>
          <TextInput id={`${id}-address`} value={form.address} onChange={set('address')} />
        </Field>
        <Field id={`${id}-url`} label={t('contacts.companies.url')}>
          <TextInput id={`${id}-url`} type="url" value={form.url} onChange={set('url')} placeholder="https://" />
        </Field>
        {save.isError ? <ActionError error={save.error} /> : null}
      </div>
    </Dialog>
  )
}

/** Admin: pick another company to fold into this one. Its contacts keep their company id; reads redirect here (C3). */
function MergeCompany({ company }: { company: Company }) {
  const { t } = useText()
  const id = useId()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sourceId, setSourceId] = useState<string | null>(null)
  const query = useDebouncedValue(q.trim(), 300)
  const results = useInfiniteQuery({ ...companiesQuery({ q: query || undefined }), enabled: open })
  const merge = useMutation({
    mutationFn: (source: string) => contactsApi.companies.merge(company.id, source),
    onSuccess: async (merged) => {
      client.setQueryData(companyQuery(company.id).queryKey, merged)
      setOpen(false)
      setSourceId(null)
      await invalidateContacts(client)
    },
  })
  const options = (results.data?.pages.flatMap((page) => page.items) ?? []).filter((candidate) => candidate.id !== company.id)
  return (
    <>
      <Button icon={<Combine />} onClick={() => setOpen(true)}>
        {t('contacts.companies.merge')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (merge.isPending) return
          setOpen(next)
          if (!next) merge.reset()
        }}
        title={t('contacts.companies.mergeTitle', { name: company.name })}
        description={t('contacts.companies.mergeDescription')}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={merge.isPending}>
              {t('contacts.common.cancel')}
            </Button>
            <Button tone="primary" icon={<Combine />} disabled={!sourceId} loading={merge.isPending} onClick={() => sourceId && merge.mutate(sourceId)}>
              {t('contacts.merge.confirm')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <label htmlFor={`${id}-q`} className="text-sm font-medium text-stone-800">
            {t('contacts.companies.mergeSearch')}
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <input id={`${id}-q`} type="search" value={q} onChange={(event) => setQ(event.target.value)} className={cn(controlClasses, 'h-10 w-full pl-9 md:h-9')} />
          </div>
          {results.isPending ? (
            <Loading />
          ) : options.length === 0 ? (
            <p className="text-sm text-stone-500">{t('contacts.companies.noMatch')}</p>
          ) : (
            <fieldset className="grid max-h-72 gap-2 overflow-y-auto">
              <legend className="sr-only">{t('contacts.companies.mergeSource')}</legend>
              {options.map((candidate) => (
                <label
                  key={candidate.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5',
                    sourceId === candidate.id ? 'border-accent bg-accent-soft' : 'border-line bg-white hover:border-stone-300'
                  )}
                >
                  <input type="radio" name={`${id}-source`} checked={sourceId === candidate.id} onChange={() => setSourceId(candidate.id)} className="size-4 accent-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{candidate.name}</span>
                  <span className="shrink-0 text-xs text-stone-500">{t('contacts.companies.contactCount', { count: candidate.contactCount })}</span>
                </label>
              ))}
            </fieldset>
          )}
          {merge.isError ? <ActionError error={merge.error} /> : null}
        </div>
      </Dialog>
    </>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, Combine, Search } from 'lucide-react'
import { useId, useState } from 'react'
import { contactsApi, type Contact } from '../../api/contacts'
import { contactQuery, contactSearchQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { ActionError, Button, cn, ConfirmDialog, controlClasses, Dialog, Loading, useDebouncedValue } from '../../ui'

/** Archive (admin or creator) with a confirmation; the contact stays readable as archived. */
export function ArchiveContact({ contact }: { contact: Contact }) {
  const { t } = useText()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const archive = useMutation({
    mutationFn: () => contactsApi.contacts.archive(contact.id, contact.version),
    onSuccess: async () => {
      setOpen(false)
      await invalidateContacts(client)
    },
  })
  return (
    <>
      <Button tone="ghost" icon={<Archive />} className="text-bad-ink hover:bg-bad-soft hover:text-bad-ink" onClick={() => setOpen(true)}>
        {t('contacts.contact.archive')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) archive.reset()
        }}
        title={t('contacts.contact.archiveTitle')}
        body={t('contacts.contact.archiveBody', { name: contact.fullName })}
        confirmLabel={t('contacts.contact.archive')}
        tone="danger"
        onConfirm={() => archive.mutate()}
        pending={archive.isPending}
        error={archive.error}
      />
    </>
  )
}

/**
 * Admin: merge this contact into another one. The target keeps its profile
 * and gains this contact's cards and tags; this contact is archived. The
 * target's current version guards the merge, so it is read right before.
 */
export function MergeContact({ contact }: { contact: Contact }) {
  const { t } = useText()
  const id = useId()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState(contact.fullName)
  const [targetId, setTargetId] = useState<string | null>(null)
  const query = useDebouncedValue(q.trim(), 300)
  const results = useQuery({ ...contactSearchQuery(query), enabled: open && query !== '' })
  const merge = useMutation({
    mutationFn: async (target: string) => {
      const latest = await client.fetchQuery({ ...contactQuery(target), staleTime: 0 })
      return contactsApi.contacts.merge(target, latest.version, contact.id)
    },
    onSuccess: async (merged) => {
      client.setQueryData(contactQuery(merged.id).queryKey, merged)
      setOpen(false)
      await navigate({ to: '/contacts/$contactId', params: { contactId: merged.id } })
      await invalidateContacts(client)
    },
  })
  const options = (results.data ?? []).filter((candidate) => candidate.id !== contact.id)
  return (
    <>
      <Button tone="ghost" icon={<Combine />} onClick={() => setOpen(true)}>
        {t('contacts.merge.open')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (merge.isPending) return
          setOpen(next)
          if (!next) merge.reset()
        }}
        title={t('contacts.merge.title', { name: contact.fullName })}
        description={t('contacts.merge.description')}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={merge.isPending}>
              {t('contacts.common.cancel')}
            </Button>
            <Button tone="primary" icon={<Combine />} disabled={!targetId} loading={merge.isPending} onClick={() => targetId && merge.mutate(targetId)}>
              {t('contacts.merge.confirm')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <label htmlFor={`${id}-q`} className="text-sm font-medium text-stone-800">
            {t('contacts.merge.search')}
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <input id={`${id}-q`} type="search" value={q} onChange={(event) => setQ(event.target.value)} className={cn(controlClasses, 'h-10 w-full pl-9 md:h-9')} />
          </div>
          {results.isFetching && !results.data ? (
            <Loading />
          ) : options.length === 0 ? (
            <p className="text-sm text-stone-500">{t('contacts.merge.noResults')}</p>
          ) : (
            <fieldset className="grid gap-2">
              <legend className="sr-only">{t('contacts.merge.target')}</legend>
              {options.map((candidate) => (
                <label
                  key={candidate.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
                    targetId === candidate.id ? 'border-accent bg-accent-soft' : 'border-line bg-white hover:border-stone-300'
                  )}
                >
                  <input type="radio" name={`${id}-target`} checked={targetId === candidate.id} onChange={() => setTargetId(candidate.id)} className="mt-1 size-4 accent-[var(--color-accent)]" />
                  <span className="min-w-0">
                    <span className="block font-medium text-stone-900">{candidate.fullName}</span>
                    <span className="block truncate text-xs text-stone-600">
                      {[candidate.company?.name, candidate.department, candidate.title, candidate.primaryEmail].filter(Boolean).join(' · ')}
                    </span>
                  </span>
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

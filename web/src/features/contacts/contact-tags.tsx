import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { contactsApi, type Contact } from '../../api/contacts'
import { invalidateContacts, tagsQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { normalizeName } from '../../model/contact'
import { useSession } from '../../shell/use-session'
import { ActionError, Button, cn, controlClasses } from '../../ui'

/**
 * The contact's tags with a remove button each, and an add box that picks an
 * existing tag or creates a new one (shared for admins who tick it, else
 * personal). Each change is a contact mutation guarded by the version.
 */
export function ContactTags({ contact }: { contact: Contact }) {
  const { t } = useText()
  const id = useId()
  const { me } = useSession()
  const client = useQueryClient()
  const tags = useQuery(tagsQuery)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const change = useMutation({
    mutationFn: async (action: { add: string } | { remove: string } | { create: string; shared: boolean }) => {
      if ('remove' in action) return contactsApi.contacts.removeTag(contact.id, contact.version, action.remove)
      const tagId = 'add' in action ? action.add : (await contactsApi.tags.create(action.create, action.shared)).id
      return contactsApi.contacts.addTag(contact.id, contact.version, tagId)
    },
    onSuccess: async () => {
      setName('')
      await invalidateContacts(client)
    },
  })

  const add = () => {
    const wanted = name.trim()
    if (!wanted) return
    const existing = tags.data?.find((tag) => normalizeName(tag.name) === normalizeName(wanted))
    if (existing && contact.tags.some((tag) => tag.id === existing.id)) {
      setName('')
      return
    }
    change.mutate(existing ? { add: existing.id } : { create: wanted, shared: me.roles.contactsAdmin && shared })
  }
  const unused = (tags.data ?? []).filter((tag) => !contact.tags.some((own) => own.id === tag.id))

  return (
    <div>
      {contact.tags.length > 0 ? (
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {contact.tags.map((tag) => (
            <li key={tag.id} className="inline-flex items-center gap-0.5 rounded-full bg-stone-100 py-0.5 pr-0.5 pl-2.5 text-xs font-medium text-stone-700 ring-1 ring-stone-200 ring-inset">
              {tag.name}
              <button
                type="button"
                aria-label={t('contacts.tags.remove', { name: tag.name })}
                title={t('contacts.tags.remove', { name: tag.name })}
                disabled={change.isPending}
                onClick={() => change.mutate({ remove: tag.id })}
                className="flex size-6 items-center justify-center rounded-full text-stone-500 hover:bg-stone-200 hover:text-stone-800 disabled:opacity-50"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-stone-500">{t('contacts.tags.none')}</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <label htmlFor={`${id}-tag`} className="sr-only">
          {t('contacts.tags.add')}
        </label>
        <input
          id={`${id}-tag`}
          list={`${id}-tags`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('contacts.tags.placeholder')}
          className={cn(controlClasses, 'h-10 w-48 md:h-8')}
        />
        <datalist id={`${id}-tags`}>
          {unused.map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
        </datalist>
        {me.roles.contactsAdmin ? (
          <label className="flex items-center gap-1.5 text-xs text-stone-600">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            {t('contacts.tags.shared')}
          </label>
        ) : null}
        <Button type="submit" size="sm" icon={<Plus />} loading={change.isPending} disabled={!name.trim()}>
          {t('contacts.tags.add')}
        </Button>
      </form>
      {change.isError ? <ActionError error={change.error} className="mt-3" /> : null}
    </div>
  )
}

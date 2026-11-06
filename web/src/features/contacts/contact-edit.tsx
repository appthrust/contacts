import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useState } from 'react'
import { contactsApi, isContactsError, type Contact } from '../../api/contacts'
import { contactQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { contactPatch, formFromContact, formProblems, type ContactForm } from '../../model/contact'
import { ActionError, Button, Notice } from '../../ui'
import { ContactFields } from './contact-fields'

/**
 * Inline edit of a contact. The form edits the version it was opened on and
 * sends only the changed fields with `If-Match: <version>` (C2). When someone
 * else saved first (409 `version_conflict`) the member reloads the latest
 * contact, which replaces the form.
 */
export function ContactEdit({ contact, onDone }: { contact: Contact; onDone: () => void }) {
  const { t } = useText()
  const client = useQueryClient()
  const [base, setBase] = useState(contact)
  const [form, setForm] = useState<ContactForm>(() => formFromContact(contact))
  const [attempted, setAttempted] = useState(false)
  const save = useMutation({
    mutationFn: () => contactsApi.contacts.update(base.id, base.version, contactPatch(base, form)),
    onSuccess: async (saved) => {
      client.setQueryData(contactQuery(saved.id).queryKey, saved)
      onDone()
      await invalidateContacts(client)
    },
  })
  const reload = useMutation({
    mutationFn: () => client.fetchQuery({ ...contactQuery(base.id), staleTime: 0 }),
    onSuccess: (latest) => {
      setBase(latest)
      setForm(formFromContact(latest))
      setAttempted(false)
      save.reset()
    },
  })
  const conflict = isContactsError(save.error, 'version_conflict')

  const submit = () => {
    setAttempted(true)
    const problems = formProblems(form)
    if (problems.fullName || problems.emails) return
    if (Object.keys(contactPatch(base, form)).length === 0) {
      onDone()
      return
    }
    save.mutate()
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="grid gap-4 rounded-lg border border-line bg-white p-4 sm:p-5"
    >
      <ContactFields form={form} onChange={setForm} showProblems={attempted} autoFocus />
      {save.isError && !conflict ? <ActionError error={save.error} /> : null}
      {/* Next to Save, where the member is looking when it fails. */}
      {conflict ? (
        <Notice
          tone="warning"
          title={t('contacts.errors.versionConflict')}
          actions={
            <Button size="sm" icon={<RotateCw />} loading={reload.isPending} onClick={() => reload.mutate()}>
              {t('contacts.edit.reload')}
            </Button>
          }
        >
          {t('contacts.edit.conflictBody')}
        </Notice>
      ) : null}
      {reload.isError ? <ActionError error={reload.error} /> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-stone-100 pt-4 sm:flex-row sm:justify-end">
        <Button onClick={onDone} disabled={save.isPending}>
          {t('contacts.common.cancel')}
        </Button>
        <Button type="submit" tone="primary" loading={save.isPending} disabled={conflict}>
          {t('contacts.common.save')}
        </Button>
      </div>
    </form>
  )
}

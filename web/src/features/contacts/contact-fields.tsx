import { useId } from 'react'
import type { MessageId } from '../../copy'
import { useText } from '../../i18n'
import { formProblems, MAX_NAME_LENGTH, type ContactForm, type FormProblem } from '../../model/contact'
import { Field, Select, TextArea, TextInput } from '../../ui'

const PROBLEM_TEXT: Record<FormProblem, MessageId> = {
  nameRequired: 'contacts.form.nameRequired',
  nameTooLong: 'contacts.form.nameTooLong',
  emailInvalid: 'contacts.form.emailInvalid',
}

/**
 * The contact fields the confirm panel and the edit form share. Controlled:
 * `onChange` receives the whole next form. Problems show once `showProblems`
 * (after the first submit attempt).
 */
export function ContactFields({
  form,
  onChange,
  showProblems,
  autoFocus = false,
  notes = true,
}: {
  form: ContactForm
  onChange: (next: ContactForm) => void
  showProblems: boolean
  autoFocus?: boolean
  /** Notes are part of editing, not of reading a card. */
  notes?: boolean
}) {
  const { t } = useText()
  const id = useId()
  const problems = showProblems ? formProblems(form) : {}
  const set = (field: keyof ContactForm) => (event: { target: { value: string } }) => onChange({ ...form, [field]: event.target.value })
  const nameError = problems.fullName ? t(PROBLEM_TEXT[problems.fullName], { max: MAX_NAME_LENGTH }) : undefined
  const emailError = problems.emails ? t(PROBLEM_TEXT[problems.emails]) : undefined
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={`${id}-name`} label={t('contacts.form.fullName')} required error={nameError}>
        <TextInput id={`${id}-name`} value={form.fullName} onChange={set('fullName')} invalid={Boolean(nameError)} autoFocus={autoFocus} autoComplete="off" />
      </Field>
      <Field id={`${id}-kana`} label={t('contacts.form.kana')}>
        <TextInput id={`${id}-kana`} value={form.kana} onChange={set('kana')} autoComplete="off" />
      </Field>
      <Field id={`${id}-company`} label={t('contacts.form.company')} hint={t('contacts.form.companyHint')} className="sm:col-span-2">
        <TextInput id={`${id}-company`} value={form.companyName} onChange={set('companyName')} autoComplete="off" />
      </Field>
      <Field id={`${id}-department`} label={t('contacts.form.department')}>
        <TextInput id={`${id}-department`} value={form.department} onChange={set('department')} autoComplete="off" />
      </Field>
      <Field id={`${id}-title`} label={t('contacts.form.title')}>
        <TextInput id={`${id}-title`} value={form.title} onChange={set('title')} autoComplete="off" />
      </Field>
      <Field id={`${id}-emails`} label={t('contacts.form.emails')} hint={t('contacts.form.onePerLine')} error={emailError}>
        <TextArea id={`${id}-emails`} value={form.emails} onChange={set('emails')} invalid={Boolean(emailError)} rows={2} className="min-h-16" spellCheck={false} />
      </Field>
      <Field id={`${id}-phones`} label={t('contacts.form.phones')} hint={t('contacts.form.onePerLine')}>
        <TextArea id={`${id}-phones`} value={form.phones} onChange={set('phones')} rows={2} className="min-h-16" spellCheck={false} />
      </Field>
      <Field id={`${id}-address`} label={t('contacts.form.address')} className="sm:col-span-2">
        <TextInput id={`${id}-address`} value={form.address} onChange={set('address')} autoComplete="off" />
      </Field>
      {notes ? (
        <Field id={`${id}-notes`} label={t('contacts.form.notes')} className="sm:col-span-2">
          <TextArea id={`${id}-notes`} value={form.notes} onChange={set('notes')} rows={3} />
        </Field>
      ) : null}
      <Field id={`${id}-visibility`} label={t('contacts.form.visibility')} className="sm:col-span-2">
        <Select id={`${id}-visibility`} value={form.visibility} onChange={(event) => onChange({ ...form, visibility: event.target.value === 'private' ? 'private' : 'shared' })}>
          <option value="shared">{t('contacts.form.shared')}</option>
          <option value="private">{t('contacts.form.private')}</option>
        </Select>
      </Field>
    </div>
  )
}

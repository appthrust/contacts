import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Link2, Loader2, RotateCw, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { contactsApi, type BusinessCard, type Contact, type ConfirmInput, type ContactSummary } from '../../api/contacts'
import { contactQuery, contactSearchQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { confirmCreateBody, formFromOcr, formProblems, LOW_CONFIDENCE, type ContactForm } from '../../model/contact'
import { cardFields } from '../../model/registration'
import { ActionError, Badge, Button, Notice, useDebouncedValue } from '../../ui'
import { ContactFields } from '../contacts/contact-fields'
import { reviewTitle } from './card-status'
import { SheetLink } from './sheet'

/**
 * Confirm one card: its image, a form pre-filled from its extraction (empty
 * when the card could not be read; D3) and, beside it, contacts with a similar
 * name (`GET /contacts?q=<fullName>`). "Link to this contact" files the card
 * under an existing person; "Create contact" registers the form. Either way the
 * card's owner now counts as having met that contact (C7). This is where cards
 * automatic registration sent to review land (R4), with the reason on top.
 *
 * The parent keys this by card id, OCR state and decision, so a card that
 * finishes reading while open starts over with what was read.
 */
export function ConfirmPanel({
  card,
  ocrAvailable,
  onConfirmed,
  onCancel,
}: {
  card: BusinessCard
  /** `me.ocr.available`: whether this Project has a gateway at all. */
  ocrAvailable: boolean
  onConfirmed: (contact: Contact) => void
  onCancel: () => void
}) {
  const { t } = useText()
  const client = useQueryClient()
  const [form, setForm] = useState<ContactForm>(() => formFromOcr(cardFields(card)))
  const [attempted, setAttempted] = useState(false)
  const query = useDebouncedValue(form.fullName.trim(), 300)
  const candidates = useQuery(contactSearchQuery(query))

  const confirm = useMutation({
    mutationFn: (input: ConfirmInput) => contactsApi.cards.confirm(card.id, input),
    onSuccess: async (contact) => {
      client.setQueryData(contactQuery(contact.id).queryKey, contact)
      onConfirmed(contact)
      await invalidateContacts(client)
    },
  })
  const retry = useMutation({ mutationFn: () => contactsApi.cards.retryOcr(card.id), onSuccess: () => invalidateContacts(client) })

  const create = () => {
    setAttempted(true)
    const problems = formProblems(form)
    if (problems.fullName || problems.emails) return
    confirm.mutate(confirmCreateBody(form))
  }
  const pending = confirm.isPending ? confirm.variables : undefined
  const canRetry = ocrAvailable && (card.ocrState === 'failed' || card.ocrState === 'unavailable')

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="grid content-start gap-4">
        <figure>
          <img src={card.imageUrl} alt={t('contacts.scan.cardImage')} className="w-full rounded-lg border border-line bg-stone-100 object-contain" />
          {card.sheetId ? (
            <figcaption className="mt-1.5">
              <SheetLink sheetId={card.sheetId} />
            </figcaption>
          ) : null}
        </figure>
        <OcrNotice card={card} ocrAvailable={ocrAvailable} />
        {canRetry ? (
          <div>
            <Button size="sm" icon={<RotateCw />} loading={retry.isPending} onClick={() => retry.mutate()}>
              {t('contacts.ocr.retry')}
            </Button>
            {retry.isError ? <ActionError error={retry.error} className="mt-2" /> : null}
          </div>
        ) : null}
        <section aria-labelledby={`candidates-${card.id}`} className="rounded-lg border border-line bg-stone-50/60 p-3">
          <h3 id={`candidates-${card.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-stone-900 [&_svg]:size-4">
            <Users aria-hidden />
            {t('contacts.confirm.candidates')}
          </h3>
          <p className="mt-0.5 text-xs text-stone-500">{t('contacts.confirm.candidatesLead')}</p>
          <div className="mt-3">
            {!query ? (
              <p className="text-sm text-stone-500">{t('contacts.confirm.typeName')}</p>
            ) : candidates.isPending ? (
              <p className="flex items-center gap-2 text-sm text-stone-500">
                <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
                {t('contacts.common.loading')}
              </p>
            ) : candidates.isError ? (
              <ActionError error={candidates.error} />
            ) : candidates.data.length === 0 ? (
              <p className="text-sm text-stone-500">{t('contacts.confirm.noCandidates')}</p>
            ) : (
              <ul className="grid gap-2">
                {candidates.data.map((candidate) => (
                  <Candidate
                    key={candidate.id}
                    contact={candidate}
                    current={candidate.id === card.contactId}
                    pending={pending !== undefined && 'contactId' in pending && pending.contactId === candidate.id}
                    disabled={confirm.isPending}
                    onLink={() => confirm.mutate({ contactId: candidate.id })}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
        className="grid content-start gap-4"
      >
        {card.contactId ? <Notice>{t('contacts.confirm.alreadyLinked')}</Notice> : null}
        <ContactFields form={form} onChange={setForm} showProblems={attempted} notes={false} autoFocus={!card.extraction} />
        {confirm.isError ? <ActionError error={confirm.error} /> : null}
        <div className="flex flex-col-reverse gap-2 border-t border-stone-100 pt-4 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} disabled={confirm.isPending}>
            {t('contacts.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" icon={<UserPlus />} loading={pending !== undefined && 'contact' in pending} disabled={confirm.isPending}>
            {t('contacts.confirm.create')}
          </Button>
        </div>
      </form>
    </div>
  )
}

/** Why the form is (or is not) pre-filled, and why automatic registration left this card to a member. */
function OcrNotice({ card, ocrAvailable }: { card: BusinessCard; ocrAvailable: boolean }) {
  const { t } = useText()
  if (card.ocrState === 'pending') return <Notice>{t('contacts.confirm.pending')}</Notice>
  if (card.ocrState === 'failed') {
    return (
      <Notice tone="error" title={t('contacts.confirm.failed')}>
        {card.ocrError}
      </Notice>
    )
  }
  if (card.ocrState === 'unavailable') return <Notice tone="warning">{t(ocrAvailable ? 'contacts.confirm.notRead' : 'contacts.confirm.noGateway')}</Notice>
  const lowConfidence = card.decisionReason === 'low_confidence' || (card.extraction !== null && card.extraction.overall < LOW_CONFIDENCE)
  if (card.decision === 'NeedsReview' && !card.contactId) {
    return (
      <Notice tone="warning" title={reviewTitle(t, card.decisionReason)}>
        {lowConfidence ? t('contacts.confirm.lowConfidence') : null}
      </Notice>
    )
  }
  if (lowConfidence) return <Notice tone="warning">{t('contacts.confirm.lowConfidence')}</Notice>
  return null
}

function Candidate({ contact, current, pending, disabled, onLink }: { contact: ContactSummary; current: boolean; pending: boolean; disabled: boolean; onLink: () => void }) {
  const { t } = useText()
  const role = [contact.department, contact.title].filter(Boolean).join(' ')
  return (
    <li className="rounded-md border border-line bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-stone-900">{contact.fullName}</span>
        {contact.kana ? <span className="text-xs text-stone-500">{contact.kana}</span> : null}
        {current ? <Badge tone="accent">{t('contacts.scan.linked')}</Badge> : null}
      </div>
      {contact.company || role ? (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-stone-600 [&_svg]:size-3.5 [&_svg]:shrink-0">
          {contact.company ? <Building2 aria-hidden className="text-stone-400" /> : null}
          <span className="truncate">{[contact.company?.name, role].filter(Boolean).join(' · ')}</span>
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-stone-500">{t('contacts.list.metBy', { count: contact.encounterCount })}</span>
        <Button size="sm" icon={<Link2 />} loading={pending} disabled={disabled || current} onClick={onLink}>
          {t('contacts.confirm.link')}
        </Button>
      </div>
    </li>
  )
}

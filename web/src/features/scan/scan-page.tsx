import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { BusinessCard, Contact } from '../../api/contacts'
import { cardQuery, OCR_POLL_MS } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { ActionError, Dialog, HrefLink, Loading, Notice, PageHeader, Section, useDocumentTitle } from '../../ui'
import { CardGrid } from './card-grid'
import { ConfirmPanel } from './confirm-panel'
import { UploadPanel } from './upload-panel'

/**
 * `/`: upload cards and follow each one: reading, registered automatically
 * (undoable), or waiting for review (`?card=<id>` opens its confirm panel).
 */
export function ScanPage({ cardId }: { cardId?: string }) {
  const { t } = useText()
  const { me } = useSession()
  const navigate = useNavigate()
  const [saved, setSaved] = useState<Pick<Contact, 'id' | 'fullName'> | null>(null)
  useDocumentTitle(t('contacts.scan.title'))
  const openCard = (id: string | undefined) => void navigate({ to: '/', search: id ? { card: id } : {}, replace: Boolean(cardId) && Boolean(id) })
  const open = (card: BusinessCard) => {
    setSaved(null)
    openCard(card.id)
  }
  return (
    <div>
      <PageHeader title={t('contacts.scan.title')} lead={t('contacts.scan.lead')} />
      {me.ocr.available ? null : (
        <Notice
          tone="warning"
          title={t('contacts.scan.ocrOff')}
          className="mb-6"
          actions={
            <HrefLink href={paths.settings} className="font-medium underline underline-offset-2">
              {t('contacts.scan.ocrOffLink')}
            </HrefLink>
          }
        >
          {t('contacts.scan.ocrOffBody')}
        </Notice>
      )}
      <UploadPanel onOpen={open} />
      {saved ? (
        <Notice tone="success" className="mt-6">
          {t('contacts.scan.saved', { name: saved.fullName })}{' '}
          <HrefLink href={paths.contact(saved.id)} className="font-medium underline underline-offset-2">
            {t('contacts.scan.openContact')}
          </HrefLink>
        </Notice>
      ) : null}
      <Section title={t('contacts.scan.myCards')} lead={t('contacts.scan.myCardsLead')} className="mt-10">
        <CardGrid onOpen={open} />
      </Section>
      <Dialog
        open={Boolean(cardId)}
        onOpenChange={(open) => {
          if (!open) openCard(undefined)
        }}
        title={t('contacts.confirm.title')}
        description={t('contacts.confirm.description')}
        size="xl"
      >
        {cardId ? (
          <CardConfirm
            cardId={cardId}
            onConfirmed={(contact) => {
              setSaved({ id: contact.id, fullName: contact.fullName })
              openCard(undefined)
            }}
            onCancel={() => openCard(undefined)}
          />
        ) : null}
      </Dialog>
    </div>
  )
}

/** Loads the card (re-polling while it is read) and hands it to the panel. */
function CardConfirm({ cardId, onConfirmed, onCancel }: { cardId: string; onConfirmed: (contact: Contact) => void; onCancel: () => void }) {
  const { me } = useSession()
  const card = useQuery({ ...cardQuery(cardId), refetchInterval: (query) => (query.state.data?.ocrState === 'pending' ? OCR_POLL_MS : false) })
  if (card.isPending) return <Loading />
  if (card.isError) return <ActionError error={card.error} />
  return (
    <ConfirmPanel
      key={`${card.data.id}:${card.data.ocrState}:${card.data.decision ?? ''}`}
      card={card.data}
      ocrAvailable={me.ocr.available}
      onConfirmed={onConfirmed}
      onCancel={onCancel}
    />
  )
}

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Building2, ExternalLink, IdCard, Lock, Mail, MapPin, Pencil, Phone, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { contactsApi, type BusinessCard, type Contact, type Encounter } from '../../api/contacts'
import { contactQuery, invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { directoryProfileUrl, knownMemberName } from '../../model/contact'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { Avatar, Badge, Button, ConfirmDialog, EmptyState, formatDate, HrefLink, IconButton, Notice, PageHeader, Section, useDocumentTitle } from '../../ui'
import { SheetLink } from '../scan/sheet'
import { ArchiveContact, MergeContact } from './contact-actions'
import { ContactEdit } from './contact-edit'
import { ContactHistory } from './contact-history'
import { ContactTags } from './contact-tags'

/**
 * `/contacts/<id>`: who they are (header, details), the cards members
 * received, who in the team met them (with Directory profile links), tags,
 * change history, and edit / merge / archive.
 */
export function ContactPage({ contactId }: { contactId: string }) {
  const { t } = useText()
  const { me } = useSession()
  const { data: contact } = useSuspenseQuery(contactQuery(contactId))
  const [editing, setEditing] = useState(false)
  useDocumentTitle(contact.fullName)
  const archived = contact.state === 'archived'
  const canArchive = !archived && (me.roles.contactsAdmin || contact.createdBy.id === me.member.id)
  const role = [contact.department, contact.title].filter(Boolean).join(' · ')

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: t('contacts.nav.contacts'), href: paths.contacts() }]}
        media={<Avatar name={contact.fullName} size="lg" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {contact.fullName}
            {contact.visibility === 'private' ? <Badge icon={<Lock />}>{t('contacts.contact.private')}</Badge> : null}
            {contact.registeredBy === 'auto' ? (
              <Badge tone="accent" icon={<Sparkles />} title={t('contacts.contact.autoRegisteredTitle')}>
                {t('contacts.contact.autoRegistered')}
              </Badge>
            ) : null}
            {contact.state !== 'active' ? <Badge tone="warning">{t(contact.state === 'draft' ? 'contacts.contact.draft' : 'contacts.contact.archived')}</Badge> : null}
          </span>
        }
        lead={
          <span className="grid gap-0.5">
            {contact.kana ? <span>{contact.kana}</span> : null}
            {contact.company ? (
              <span className="flex flex-wrap items-center gap-x-1.5">
                <Building2 aria-hidden className="size-3.5 text-stone-400" />
                <HrefLink href={paths.company(contact.company.id)} className="font-medium text-accent-strong hover:underline">
                  {contact.company.name}
                </HrefLink>
                {role ? <span className="text-stone-600">{role}</span> : null}
              </span>
            ) : role ? (
              <span className="text-stone-600">{role}</span>
            ) : null}
          </span>
        }
        actions={
          archived || editing ? undefined : (
            <Button icon={<Pencil />} onClick={() => setEditing(true)}>
              {t('contacts.common.edit')}
            </Button>
          )
        }
      />
      {archived ? <Notice className="mb-6">{t('contacts.contact.archivedNotice')}</Notice> : null}
      {editing ? (
        <ContactEdit key={contact.id} contact={contact} onDone={() => setEditing(false)} />
      ) : (
        <Details contact={contact} />
      )}
      <Section title={t('contacts.contact.cards')} lead={t('contacts.contact.cardsLead', { count: contact.cards.length })}>
        {contact.cards.length === 0 ? (
          <EmptyState icon={<IdCard />} title={t('contacts.contact.noCards')} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {contact.cards.map((card) => (
              <li key={card.id}>
                <CardFigure card={card} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('contacts.contact.encounters')} lead={t('contacts.list.metBy', { count: contact.encounterCount })}>
        {contact.encounters.length === 0 ? (
          <p className="text-sm text-stone-500">{t('contacts.contact.noEncounters')}</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
            {contact.encounters.map((encounter) => (
              <li key={encounter.member.id}>
                <EncounterRow encounter={encounter} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {archived ? null : (
        <Section title={t('contacts.tags.title')}>
          <ContactTags contact={contact} />
        </Section>
      )}
      <Section title={t('contacts.history.title')}>
        <ContactHistory changes={contact.changes} />
      </Section>
      {canArchive || (me.roles.contactsAdmin && !archived) ? (
        <div className="mt-10 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {me.roles.contactsAdmin && !archived ? <MergeContact contact={contact} /> : null}
          {canArchive ? <ArchiveContact contact={contact} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Details({ contact }: { contact: Contact }) {
  const { t } = useText()
  const rows = [
    ...contact.emails.map((email) => ({ key: `e-${email}`, icon: <Mail />, label: t('contacts.form.emails'), content: <a href={`mailto:${email}`} className="text-accent-strong hover:underline">{email}</a> })),
    ...contact.phones.map((phone) => ({ key: `p-${phone}`, icon: <Phone />, label: t('contacts.form.phones'), content: <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="text-accent-strong hover:underline">{phone}</a> })),
    ...(contact.address ? [{ key: 'address', icon: <MapPin />, label: t('contacts.form.address'), content: <span>{contact.address}</span> }] : []),
  ]
  if (rows.length === 0 && !contact.notes) return <p className="text-sm text-stone-500">{t('contacts.contact.noDetails')}</p>
  return (
    <div className="grid gap-4 rounded-lg border border-line bg-white px-4 py-4 sm:px-5">
      {rows.length > 0 ? (
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <li key={row.key} className="flex min-w-0 items-center gap-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-stone-400">
              <span className="sr-only">{row.label}: </span>
              {row.icon}
              <span className="min-w-0 truncate">{row.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {contact.notes ? (
        <div>
          <p className="text-xs font-medium text-stone-500">{t('contacts.form.notes')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-stone-800">{contact.notes}</p>
        </div>
      ) : null}
    </div>
  )
}

/** One received card: the image (opens full size), who received it, when and where. Its owner or an admin may remove it. */
function CardFigure({ card }: { card: BusinessCard }) {
  const { t, locale } = useText()
  const { me } = useSession()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => contactsApi.cards.remove(card.id),
    onSuccess: async () => {
      setConfirming(false)
      await invalidateContacts(client)
    },
  })
  const owner = knownMemberName(card.owner) ?? t('contacts.common.unknownMember')
  const canRemove = card.owner.id === me.member.id || me.roles.contactsAdmin
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-white">
      <a href={card.imageUrl} target="_blank" rel="noreferrer" className="block aspect-[91/55] bg-stone-100 hover:opacity-90">
        <img src={card.imageUrl} alt={t('contacts.contact.cardFrom', { name: owner })} loading="lazy" className="size-full object-contain" />
      </a>
      <figcaption className="flex items-start gap-2 px-3 py-2.5 text-xs text-stone-600">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-stone-800">{owner}</span>
          <span className="block truncate">{[card.exchangedAt ? formatDate(card.exchangedAt, locale) : formatDate(card.createdAt, locale), card.place].filter(Boolean).join(' · ')}</span>
          {card.sheetId ? <SheetLink sheetId={card.sheetId} className="mt-1" /> : null}
        </span>
        {canRemove ? (
          <IconButton label={t('contacts.contact.removeCard')} icon={<Trash2 />} onClick={() => setConfirming(true)} className="-my-1 text-stone-500" />
        ) : null}
      </figcaption>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next)
          if (!next) remove.reset()
        }}
        title={t('contacts.contact.removeCardTitle')}
        body={t('contacts.contact.removeCardBody')}
        confirmLabel={t('contacts.contact.removeCard')}
        tone="danger"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error}
      />
    </figure>
  )
}

/** A member who met the contact; their Directory profile when they are linked (C6: one without a Directory person is an unknown member). */
function EncounterRow({ encounter }: { encounter: Encounter }) {
  const { t, locale } = useText()
  const { directoryUrl, me } = useSession()
  const name = knownMemberName(encounter.member) ?? t('contacts.common.unknownMember')
  const profile = directoryProfileUrl(directoryUrl, encounter.member.directoryPersonId)
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={name} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2">
            {profile ? (
              <a href={profile} className="inline-flex items-center gap-1 font-medium text-stone-900 hover:text-accent-strong hover:underline">
                {name}
                <ExternalLink aria-hidden className="size-3.5 text-stone-400" />
                <span className="sr-only">({t('contacts.contact.directoryProfile')})</span>
              </a>
            ) : (
              <span className="font-medium text-stone-900">{name}</span>
            )}
            {encounter.member.id === me.member.id ? <Badge tone="accent">{t('contacts.nav.you')}</Badge> : null}
          </span>
          <span className="block text-xs text-stone-500">{t('contacts.contact.cardCount', { count: encounter.cardCount })}</span>
        </span>
      </div>
      <p className="shrink-0 pl-10 text-xs text-stone-500 sm:pl-0">
        {encounter.firstAt === encounter.lastAt
          ? t('contacts.contact.metOn', { date: formatDate(encounter.lastAt, locale) })
          : t('contacts.contact.metBetween', { first: formatDate(encounter.firstAt, locale), last: formatDate(encounter.lastAt, locale) })}
      </p>
    </div>
  )
}

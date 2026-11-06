import { useMutation, useQueryClient, useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown, IdCard, Keyboard, RotateCw, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { contactsApi, type BusinessCard } from '../../api/contacts'
import { invalidateContacts, myCardsQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { cardName, groupSheetRuns } from '../../model/contact'
import { cardFields, cardStatus } from '../../model/registration'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { ActionError, Button, ConfirmDialog, EmptyState, formatDate, LinkButton, Toast } from '../../ui'
import { CardStatusChip } from './card-status'
import { SheetLink, SheetTag } from './sheet'

/**
 * The caller's cards: the ones that need them first (review, manual entry,
 * failed, still reading), then registered ones, each newest first. Consecutive
 * cards cut from the same sheet sit together under "シートから N 枚". While any
 * card is still being read the query re-polls every 3 s (myCardsQuery).
 */
export function CardGrid({ onOpen }: { onOpen: (card: BusinessCard) => void }) {
  const { t } = useText()
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, error } = useSuspenseInfiniteQuery(myCardsQuery)
  const [unlinked, setUnlinked] = useState(0)
  const cards = data.pages.flatMap((page) => page.items)
  if (cards.length === 0) return <EmptyState icon={<IdCard />} title={t('contacts.scan.emptyTitle')} body={t('contacts.scan.emptyBody')} />
  const ordered = [...cards.filter((card) => !card.contactId), ...cards.filter((card) => card.contactId)]
  const tile = (card: BusinessCard) => <CardTile card={card} onOpen={() => onOpen(card)} onUnlinked={() => setUnlinked((count) => count + 1)} />
  return (
    <div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groupSheetRuns(ordered).map((run) =>
          run.sheetId && run.cards.length > 1 ? (
            <li key={`sheet:${run.cards[0]!.id}`} className="col-span-full">
              <SheetRun sheetId={run.sheetId} count={run.cards.length}>
                {run.cards.map((card) => (
                  <li key={card.id}>{tile(card)}</li>
                ))}
              </SheetRun>
            </li>
          ) : (
            <li key={run.cards[0]!.id}>{tile(run.cards[0]!)}</li>
          )
        )}
      </ul>
      {isFetchNextPageError ? <ActionError error={error} className="mt-4" /> : null}
      {hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button icon={<ChevronDown />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t('contacts.common.loadMore')}
          </Button>
        </div>
      ) : null}
      {unlinked > 0 ? (
        <Toast key={unlinked} onDismiss={() => setUnlinked(0)}>
          {t('contacts.scan.unlinked')}
        </Toast>
      ) : null}
    </div>
  )
}

/** Consecutive cards of one sheet: a header with the count and the sheet link, then the cards. */
function SheetRun({ sheetId, count, children }: { sheetId: string; count: number; children: ReactNode }) {
  const { t } = useText()
  const title = t('contacts.scan.sheetGroup', { count })
  return (
    <section aria-label={title} className="rounded-xl border border-line bg-stone-50/60 p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5">
        <p className="text-sm font-medium text-stone-800">{title}</p>
        <SheetLink sheetId={sheetId} />
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>
    </section>
  )
}

function CardTile({ card, onOpen, onUnlinked }: { card: BusinessCard; onOpen: () => void; onUnlinked: () => void }) {
  const { t, locale } = useText()
  const { me } = useSession()
  const client = useQueryClient()
  const [undoing, setUndoing] = useState(false)
  const retry = useMutation({ mutationFn: () => contactsApi.cards.retryOcr(card.id), onSuccess: () => invalidateContacts(client) })
  const unlink = useMutation({
    mutationFn: () => contactsApi.cards.unlink(card.id),
    onSuccess: async () => {
      setUndoing(false)
      onUnlinked()
      await invalidateContacts(client)
    },
  })
  const status = cardStatus(card)
  const name = cardName(card)
  const company = cardFields(card)?.company?.trim()
  const label = name ?? t('contacts.scan.unnamed')
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-white">
      <button
        type="button"
        onClick={onOpen}
        disabled={status.kind === 'reading'}
        aria-label={t('contacts.scan.cardOf', { name: label })}
        className="relative block aspect-[91/55] w-full overflow-hidden bg-stone-100 enabled:cursor-pointer enabled:hover:opacity-90"
      >
        <img src={card.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
      </button>
      <div className="flex flex-1 flex-col gap-1 px-3.5 py-3">
        <CardStatusChip status={status} card={card} className="mb-1" />
        {/* A registered card's chip already names the person and company. */}
        {status.kind === 'registered' ? null : (
          <>
            <p className={name ? 'truncate text-sm font-semibold text-stone-900' : 'truncate text-sm text-stone-500'}>{label}</p>
            {company ? <p className="truncate text-xs text-stone-600">{company}</p> : null}
          </>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-xs text-stone-500">
            {[card.exchangedAt ? formatDate(card.exchangedAt, locale) : t('contacts.scan.uploadedAt', { date: formatDate(card.createdAt, locale) }), card.place]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {card.sheetId ? <SheetTag /> : null}
        </div>
        {retry.isError ? <ActionError error={retry.error} className="mt-2" /> : null}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          {status.kind === 'registered' || status.kind === 'linked' ? (
            <LinkButton href={paths.contact(status.contactId)} size="sm">
              {t('contacts.scan.openContact')}
            </LinkButton>
          ) : null}
          {status.kind === 'registered' ? (
            <Button size="sm" icon={<Undo2 />} onClick={() => setUndoing(true)}>
              {t('contacts.scan.unlink')}
            </Button>
          ) : null}
          {status.kind === 'review' ? (
            <Button size="sm" tone="primary" onClick={onOpen}>
              {t('contacts.scan.confirm')}
            </Button>
          ) : null}
          {status.kind === 'failed' && me.ocr.available ? (
            <Button size="sm" icon={<RotateCw />} loading={retry.isPending} onClick={() => retry.mutate()}>
              {t('contacts.ocr.retry')}
            </Button>
          ) : null}
          {status.kind === 'unavailable' || status.kind === 'failed' ? (
            <Button size="sm" tone={status.kind === 'unavailable' ? 'primary' : 'secondary'} icon={<Keyboard />} onClick={onOpen}>
              {t('contacts.scan.enterByHand')}
            </Button>
          ) : null}
        </div>
      </div>
      {status.kind === 'registered' ? (
        <ConfirmDialog
          open={undoing}
          onOpenChange={(next) => {
            setUndoing(next)
            if (!next) unlink.reset()
          }}
          title={t('contacts.scan.unlinkTitle')}
          body={t('contacts.scan.unlinkBody', { name: label })}
          confirmLabel={t('contacts.scan.unlink')}
          tone="danger"
          onConfirm={() => unlink.mutate()}
          pending={unlink.isPending}
          error={unlink.error}
        />
      ) : null}
    </article>
  )
}

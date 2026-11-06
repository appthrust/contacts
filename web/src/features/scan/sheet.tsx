import { useQuery } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import { sheetImageUrl, type BusinessCard, type Sheet } from '../../api/contacts'
import { cardQuery, OCR_POLL_MS } from '../../api/queries'
import { useText } from '../../i18n'
import { cardName } from '../../model/contact'
import { cardStatus } from '../../model/registration'
import { Badge, cn } from '../../ui'
import { CardStatusChip } from './card-status'

/**
 * Cards cut from one sheet (design/platform/builtin-app-contacts/sheet-split.md):
 * an image that held several cards is stored as one card per detected region,
 * each with `sheetId`, and the original stays viewable as the sheet image.
 */

/** "シート": the card was cut from a multi-card image. */
export function SheetTag() {
  const { t } = useText()
  return (
    <Badge icon={<Layers />} title={t('contacts.scan.sheetTagHint')}>
      {t('contacts.scan.sheetTag')}
    </Badge>
  )
}

/** "シートを表示": the whole sheet the card was cut from, in a new tab. */
export function SheetLink({ sheetId, className }: { sheetId: string; className?: string }) {
  const { t } = useText()
  return (
    <a
      href={sheetImageUrl(sheetId)}
      target="_blank"
      rel="noreferrer"
      className={cn('inline-flex items-center gap-1 text-xs font-medium text-accent-strong hover:underline [&_svg]:size-3.5 [&_svg]:shrink-0', className)}
    >
      <Layers aria-hidden />
      {t('contacts.scan.showSheet')}
    </a>
  )
}

/**
 * An upload that held several cards: "シートから N 枚", the sheet thumbnail
 * (opens full size) and one row per card with its own status chip, re-read
 * every 3 s while that card is being read. A card's thumbnail opens it.
 */
export function UploadedSheet({ sheet, cards, onOpen }: { sheet: Sheet; cards: readonly BusinessCard[]; onOpen?: (card: BusinessCard) => void }) {
  const { t } = useText()
  const title = t('contacts.scan.sheetGroup', { count: cards.length })
  return (
    <section aria-label={title} className="mt-1.5 mb-1 flex flex-col gap-3 rounded-lg border border-line bg-stone-50/60 p-3 sm:flex-row">
      <a
        href={sheet.imageUrl}
        target="_blank"
        rel="noreferrer"
        className="block w-full shrink-0 self-start overflow-hidden rounded-md border border-line bg-stone-100 hover:opacity-90 sm:w-36"
      >
        <img src={sheet.imageUrl} alt={t('contacts.scan.sheetImage')} loading="lazy" className="max-h-48 w-full object-contain" />
      </a>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-stone-800 [&_svg]:size-4 [&_svg]:text-stone-500">
          <Layers aria-hidden />
          {title}
        </p>
        <ul className="mt-2 grid gap-1.5">
          {cards.map((card) => (
            <SheetCardRow key={card.id} card={card} onOpen={onOpen} />
          ))}
        </ul>
      </div>
    </section>
  )
}

function SheetCardRow({ card: uploaded, onOpen }: { card: BusinessCard; onOpen?: (card: BusinessCard) => void }) {
  const { t } = useText()
  const { data: card } = useQuery({
    ...cardQuery(uploaded.id),
    initialData: uploaded,
    refetchInterval: (query) => (query.state.data?.ocrState === 'pending' ? OCR_POLL_MS : false),
  })
  const status = cardStatus(card)
  const label = cardName(card) ?? t('contacts.scan.unnamed')
  return (
    <li className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => onOpen?.(card)}
        disabled={!onOpen || status.kind === 'reading'}
        aria-label={t('contacts.scan.cardOf', { name: label })}
        className="block aspect-[91/55] h-9 shrink-0 overflow-hidden rounded-sm border border-line bg-stone-100 enabled:cursor-pointer enabled:hover:opacity-90"
      >
        <img src={card.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
      </button>
      <CardStatusChip status={status} card={card} />
    </li>
  )
}

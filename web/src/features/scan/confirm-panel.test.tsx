import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BusinessCard, ContactSummary, Extraction } from '../../api/contacts'
import { contactSearchQuery } from '../../api/queries'
import { I18nProvider } from '../../i18n'
import { ConfirmPanel } from './confirm-panel'

const owner = { id: 'm1', displayName: '山田 太郎', email: 'yamada@example.com', directoryPersonId: 'p-yamada' }

const extraction: Extraction = {
  id: 'x-1',
  engine: 'gateway-vision',
  model: 'gemma3:4b',
  fields: {
    fullName: '伊藤 さくら',
    kana: 'イトウ サクラ',
    company: '東京テック株式会社',
    department: '開発本部',
    title: 'マネージャー',
    emails: ['ito@tokyo-tech.jp'],
    phones: ['03-5555-6666'],
    address: null,
    url: null,
    confidence: 0.88,
  },
  fieldConfidence: { fullName: 0.88 },
  overall: 0.88,
  durationMs: 1800,
  createdAt: '2026-10-29T00:00:00.000Z',
}

const read: BusinessCard = {
  id: 'card-1',
  contactId: null,
  owner,
  imageUrl: '/api/contacts/v1/cards/card-1/image',
  ocrState: 'done',
  extraction,
  decision: null,
  decisionReason: null,
  ocrError: null,
  exchangedAt: '2026-10-29T00:00:00.000Z',
  place: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  sheetId: null,
  bbox: null,
}

const ito: ContactSummary = {
  id: 'contact-ito',
  fullName: '伊藤 さくら',
  kana: 'イトウ サクラ',
  title: 'マネージャー',
  department: '開発本部',
  company: { id: 'co-tt', name: '東京テック株式会社' },
  primaryEmail: 'ito@tokyo-tech.jp',
  visibility: 'shared',
  state: 'active',
  tags: [],
  encounterCount: 2,
  knownByMe: false,
  lastMetAt: '2026-09-06T09:00:00.000Z',
  updatedAt: '2026-09-06T09:00:00.000Z',
}

/** Server-renders the panel with the duplicate search for `name` already answered. */
function render(card: BusinessCard, { ocrAvailable = true, candidates = [] as ContactSummary[], language = 'ja' as 'ja' | 'en' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const name = card.extraction?.fields.fullName?.trim()
  if (name) client.setQueryData(contactSearchQuery(name).queryKey, candidates)
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <I18nProvider language={language}>{node}</I18nProvider>
    </QueryClientProvider>
  )
  return renderToStaticMarkup(wrap(<ConfirmPanel card={card} ocrAvailable={ocrAvailable} onConfirmed={() => {}} onCancel={() => {}} />))
}

describe('card confirm panel', () => {
  test('a read card pre-fills the form and offers the matching contact beside it', () => {
    const html = render(read, { candidates: [ito] })
    expect(html).toContain('src="/api/contacts/v1/cards/card-1/image"')
    expect(html).toContain('value="伊藤 さくら"')
    expect(html).toContain('value="東京テック株式会社"')
    expect(html).toContain('ito@tokyo-tech.jp</textarea>')
    expect(html).toContain('登録済みの人では？')
    expect(html).toContain('この人に紐づける')
    expect(html).toContain('2 人が面識あり')
    expect(html).toContain('連絡先を登録')
    expect(html).not.toContain('読み違いがあるかもしれません')
  })

  test('a card cut from a sheet links to the whole sheet; a single upload does not', () => {
    expect(render(read)).not.toContain('シートを表示')
    const html = render({ ...read, sheetId: 'sheet-1', bbox: [60, 60, 760, 484] })
    expect(html).toMatch(/<a[^>]*href="\/api\/contacts\/v1\/sheets\/sheet-1\/image"[^>]*target="_blank"[^>]*>.*シートを表示<\/a>/)
    expect(render({ ...read, sheetId: 'sheet-1', bbox: [60, 60, 760, 484] }, { language: 'en' })).toContain('Show sheet')
  })

  test('no match says so; a low-confidence read asks for a careful check', () => {
    const html = render({ ...read, extraction: { ...extraction, overall: 0.4 } })
    expect(html).toContain('この名前の人はまだいません。')
    expect(html).not.toContain('この人に紐づける')
    expect(html).toContain('読み違いがあるかもしれません')
  })

  test('a card automatic registration sent to review says why on top of the pre-filled form (R4)', () => {
    const ambiguous = render({ ...read, decision: 'NeedsReview', decisionReason: 'ambiguous_match' }, { candidates: [ito] })
    expect(ambiguous).toContain('確認が必要：登録済みの人と同じかもしれません')
    expect(ambiguous).toContain('value="伊藤 さくら"')
    expect(ambiguous).not.toContain('読み違いがあるかもしれません')
    const low = render({ ...read, decision: 'NeedsReview', decisionReason: 'low_confidence' }, { language: 'en' })
    expect(low).toContain('Needs review: the reading may be wrong')
    expect(low).toContain('Some fields may be misread.')
    expect(render({ ...read, decision: 'NeedsReview', decisionReason: 'missing_field:company' })).toContain('確認が必要：会社を読み取れませんでした')
  })

  test('without a gateway the form starts empty with the manual-entry notice (D3), and no retry', () => {
    const html = render({ ...read, ocrState: 'unavailable', extraction: null, decision: 'Unavailable' }, { ocrAvailable: false })
    expect(html).toContain('名刺の読み取りが設定されていないため、手で入力してください')
    expect(html).toContain('名前を入れると、登録済みの人を探します。')
    expect(html).not.toContain('value="伊藤 さくら"')
    expect(html).not.toContain('もう一度読み取る')
  })

  test('a failed read shows the reason and offers a retry when a gateway exists', () => {
    const html = render({ ...read, ocrState: 'failed', extraction: null, ocrError: 'The AI gateway did not answer within 60 seconds' }, { language: 'en' })
    expect(html).toContain('Reading this card failed.')
    expect(html).toContain('The AI gateway did not answer within 60 seconds')
    expect(html).toContain('Retry reading')
  })

  test('a card already filed under the candidate marks it and disables linking it again', () => {
    const html = render({ ...read, contactId: ito.id }, { candidates: [ito] })
    expect(html).toContain('この名刺は登録済みです')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*この人に紐づける/)
  })
})

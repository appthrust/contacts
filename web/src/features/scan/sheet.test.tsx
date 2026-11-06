import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppConfig, BusinessCard, Extraction, Me, Sheet } from '../../api/contacts'
import { cardQuery, configQuery, meQuery, myCardsQuery } from '../../api/queries'
import { I18nProvider } from '../../i18n'
import { CardGrid } from './card-grid'
import { UploadedSheet } from './sheet'

const owner = { id: 'm1', displayName: '山田 太郎', email: 'yamada@example.com', directoryPersonId: 'p-yamada' }
const sheet: Sheet = { id: 'sheet-1', detected: 3, imageUrl: '/api/contacts/v1/sheets/sheet-1/image' }

const extraction = (fullName: string, company: string, overall = 0.92): Extraction => ({
  id: `x-${fullName}`,
  engine: 'gateway-vision',
  model: 'gemma3:4b',
  fields: { fullName, kana: null, company, department: null, title: null, emails: [], phones: [], address: null, url: null, confidence: overall },
  fieldConfidence: {},
  overall,
  durationMs: 1200,
  createdAt: '2026-10-31T00:00:00.000Z',
})

function card(id: string, overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    id,
    contactId: null,
    owner,
    imageUrl: `/api/contacts/v1/cards/${id}/image`,
    ocrState: 'pending',
    extraction: null,
    decision: null,
    decisionReason: null,
    ocrError: null,
    exchangedAt: '2026-10-31T00:00:00.000Z',
    place: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    sheetId: sheet.id,
    bbox: [60, 60, 760, 484],
    ...overrides,
  }
}

const me: Me = {
  member: owner,
  roles: { contactsAdmin: true },
  directory: { linked: true, publicUrl: null },
  ocr: { available: true, extractor: 'gateway-vision', model: 'gemma3:4b', releaseModel: '', models: [], local: true, sheetSplit: true },
  counts: { myCards: 4, myContacts: 0, contacts: 0, companies: 0 },
}
const config: AppConfig = { projectId: 'pj-test', publicUrl: '', directoryUrl: '' }

function render(node: ReactNode, seed: (client: QueryClient) => void = () => {}, language: 'ja' | 'en' = 'ja') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seed(client)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider language={language}>{node}</I18nProvider>
    </QueryClientProvider>
  )
}

const count = (html: string, text: string) => html.split(text).length - 1

describe('uploaded sheet group', () => {
  const uploaded = [card('c1'), card('c2'), card('c3')]

  test('names the count, shows the sheet thumbnail and one chip per card in sheet order', () => {
    const html = render(<UploadedSheet sheet={sheet} cards={uploaded} onOpen={() => {}} />)
    expect(html).toContain('aria-label="シートから 3 枚"')
    expect(html).toMatch(/<a[^>]*href="\/api\/contacts\/v1\/sheets\/sheet-1\/image"[^>]*target="_blank"[^>]*><img[^>]*src="\/api\/contacts\/v1\/sheets\/sheet-1\/image"[^>]*alt="シートの画像"/)
    expect(count(html, '読み取り中')).toBe(3)
    const crops = [...html.matchAll(/src="\/api\/contacts\/v1\/cards\/(c\d)\/image"/g)].map((match) => match[1])
    expect(crops).toEqual(['c1', 'c2', 'c3'])
    // A card still being read cannot be opened yet.
    expect(count(html, 'disabled=""')).toBe(3)
    expect(render(<UploadedSheet sheet={sheet} cards={uploaded} />, undefined, 'en')).toContain('3 cards from one sheet')
  })

  test('each chip follows its own card: the latest read of that card replaces what the upload answered', () => {
    const html = render(<UploadedSheet sheet={sheet} cards={uploaded} onOpen={() => {}} />, (client) => {
      client.setQueryData(cardQuery('c1').queryKey, card('c1', { ocrState: 'done', contactId: 'k1', decision: 'AutoCreated', extraction: extraction('石井 美咲', '株式会社あおば製作所') }))
      client.setQueryData(cardQuery('c3').queryKey, card('c3', { ocrState: 'done', decision: 'NeedsReview', decisionReason: 'low_confidence', extraction: extraction('小林 直樹', '小林会計事務所', 0.48) }))
    })
    expect(html).toContain('登録しました：石井 美咲 / 株式会社あおば製作所')
    expect(html).toContain('確認が必要：読み取りに自信がありません')
    expect(count(html, '読み取り中')).toBe(1)
    expect(html).toContain('aria-label="小林 直樹 の名刺"')
    // Only the card still being read stays disabled.
    expect(count(html, 'disabled=""')).toBe(1)
  })
})

describe('my cards list', () => {
  test('consecutive cards of one sheet sit in one group with the sheet link; every sheet card carries the tag', () => {
    const items = [
      card('s1', { ocrState: 'done', decision: 'NeedsReview', decisionReason: 'low_confidence', extraction: extraction('小林 直樹', '小林会計事務所', 0.48) }),
      card('s2', { ocrState: 'done', decision: 'NeedsReview', decisionReason: 'policy', extraction: extraction('岡田 大輔', '株式会社ソラ通信') }),
      card('single', { sheetId: null, bbox: null, ocrState: 'done', decision: 'NeedsReview', decisionReason: 'policy', extraction: extraction('森 由紀子', '株式会社ひかり物流') }),
    ]
    const html = render(<CardGrid onOpen={() => {}} />, (client) => {
      client.setQueryData(meQuery.queryKey, me)
      client.setQueryData(configQuery.queryKey, config)
      client.setQueryData(myCardsQuery.queryKey, { pages: [{ items, nextCursor: null }], pageParams: [null] })
    })
    expect(count(html, 'aria-label="シートから 2 枚"')).toBe(1)
    expect(count(html, 'href="/api/contacts/v1/sheets/sheet-1/image"')).toBe(1)
    expect(count(html, 'シートを表示')).toBe(1)
    expect(count(html, '>シート</span>')).toBe(2)
    // The group holds both sheet cards, and the single card follows outside it.
    const group = html.slice(html.indexOf('aria-label="シートから 2 枚"'), html.indexOf('/cards/single/image'))
    expect(group).toContain('/cards/s1/image')
    expect(group).toContain('/cards/s2/image')
    expect(group.indexOf('</section>')).toBeGreaterThan(group.indexOf('/cards/s2/image'))
  })
})

import { createDashboardTranslator } from '@appthrust/platform-dashboard-i18n'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BusinessCard, OcrFields } from '../../api/contacts'
import { catalogs } from '../../copy'
import { I18nProvider, type Translate } from '../../i18n'
import { cardStatus, REQUIRED_FIELD_OPTIONS, REVIEW_REASONS } from '../../model/registration'
import { CardStatusChip, cardStatusLabel, reviewReasonText } from './card-status'

const translators = { ja: createDashboardTranslator('ja', catalogs).t as Translate, en: createDashboardTranslator('en', catalogs).t as Translate }

const fields: OcrFields = {
  fullName: '森 由紀子',
  kana: 'モリ ユキコ',
  company: '株式会社ひかり物流',
  department: null,
  title: null,
  emails: ['mori@hikari-logi.co.jp'],
  phones: [],
  address: null,
  url: null,
  confidence: 0.92,
}
type Card = Pick<BusinessCard, 'contactId' | 'ocrState' | 'decision' | 'decisionReason' | 'extraction'>
const read = (overrides: Partial<BusinessCard> = {}): Card => ({
  contactId: null,
  ocrState: 'done',
  decision: null,
  decisionReason: null,
  extraction: { id: 'x1', engine: 'gateway-vision', model: 'gemma3:4b', fields, fieldConfidence: {}, overall: 0.92, durationMs: 1, createdAt: '2026-10-31T00:00:00Z' },
  ...overrides,
})
const chip = (card: Card, language: 'ja' | 'en' = 'ja') => cardStatusLabel(translators[language], cardStatus(card), card).text

describe('scan card chips', () => {
  test('each (ocrState, decision) reads as the design names it', () => {
    expect(chip(read({ ocrState: 'pending', extraction: null }))).toBe('読み取り中')
    expect(chip(read({ decision: 'AutoCreated', contactId: 'c1' }))).toBe('登録しました：森 由紀子 / 株式会社ひかり物流')
    expect(chip(read({ decision: 'AutoLinked', contactId: 'c1' }), 'en')).toBe('Registered: 森 由紀子 / 株式会社ひかり物流')
    expect(chip(read({ decision: 'AutoCreated', contactId: 'c1', extraction: { ...read().extraction!, fields: { ...fields, company: '' } } }))).toBe('登録しました：森 由紀子')
    expect(chip(read({ decision: 'NeedsReview', decisionReason: 'low_confidence' }))).toBe('確認が必要：読み取りに自信がありません')
    expect(chip(read({ decision: 'NeedsReview', decisionReason: 'missing_field:fullName' }))).toBe('確認が必要：氏名を読み取れませんでした')
    expect(chip(read())).toBe('確認が必要')
    expect(chip(read({ ocrState: 'unavailable', decision: 'Unavailable', extraction: null }))).toBe('OCRを使えません')
    expect(chip(read({ ocrState: 'failed', extraction: null }))).toBe('読み取り失敗')
    expect(chip(read({ decision: 'NeedsReview', contactId: 'c1' }))).toBe('登録済み')
  })

  test('the chip renders its text with a decorative icon', () => {
    const card = read({ decision: 'AutoCreated', contactId: 'c1' })
    const html = renderToStaticMarkup(
      <I18nProvider language="ja">
        <CardStatusChip status={cardStatus(card)} card={card} />
      </I18nProvider>
    )
    expect(html).toContain('登録しました：森 由紀子 / 株式会社ひかり物流')
    expect(html).toContain('aria-hidden="true"')
  })
})

describe('review reason copy', () => {
  test('every reason the server records has its own words in Japanese and English', () => {
    for (const language of ['ja', 'en'] as const) {
      const t = translators[language]
      const other = reviewReasonText(t, 'something_new')
      const texts = [...REVIEW_REASONS.map((reason) => reviewReasonText(t, reason)), ...REQUIRED_FIELD_OPTIONS.map((field) => reviewReasonText(t, `missing_field:${field}`))]
      for (const text of texts) {
        expect(text, language).toBeTruthy()
        expect(text, language).not.toBe(other)
        expect(text, language).not.toMatch(/[{}]|contacts\./)
      }
      expect(new Set(texts).size, language).toBe(texts.length)
    }
    expect(reviewReasonText(translators.ja, null)).toBeNull()
    // A field the screen has no label for still says which one.
    expect(reviewReasonText(translators.en, 'missing_field:url')).toBe('url was not read')
  })
})

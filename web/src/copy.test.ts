import { createDashboardTranslator } from '@appthrust/platform-dashboard-i18n'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { catalogs } from './copy'

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort()

/** Every `.ts`/`.tsx` source outside tests and the copy itself. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'copy' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('contacts copy catalogs', () => {
  const messages = catalogs.flatMap((catalog) => Object.entries(catalog))

  test('every message is namespaced, translated to Japanese and keeps its placeholders', () => {
    for (const [id, message] of messages) {
      expect(id.startsWith('contacts.')).toBe(true)
      const ja = message.translations.ja
      expect(ja, id).toBeTruthy()
      expect(placeholders(ja ?? ''), id).toEqual(placeholders(message.defaultMessage))
    }
  })

  test('ids are unique, so both languages build a translator', () => {
    expect(new Set(messages.map(([id]) => id)).size).toBe(messages.length)
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    expect(ja.t('contacts.nav.scan')).toBe('取り込む')
    expect(en.t('contacts.nav.scan')).toBe('Scan')
    expect(ja.t('contacts.list.metBy', { count: 3 })).toBe('3 人が面識あり')
    expect(en.t('contacts.scan.uploadProgress', { done: 1, total: 2 })).toBe('1 of 2 uploaded')
  })

  test('automatic registration wording exists in both languages with its values filled in', () => {
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    const registration = messages.filter(([id]) => /^contacts\.(reason\.|scan\.(registered|review|unlink|ocrOff|enterByHand)|settings\.(mode|threshold|autoCreate|autoLink|required|private|engine|local|remote|registration|adminOnly|saved|discard|forbidden)|contact\.autoRegistered|history\.auto)/.test(id))
    // reason ×6, scan ×12, settings ×30, contact ×2, history ×2
    expect(registration.length).toBeGreaterThanOrEqual(45)
    for (const [id, message] of registration) {
      expect(message.defaultMessage.trim(), id).not.toBe('')
      expect(message.translations.ja?.trim(), id).toBeTruthy()
      expect(message.translations.ja, id).not.toBe(message.defaultMessage)
    }
    const values = { name: '森 由紀子', company: '株式会社ひかり物流' }
    expect(ja.t('contacts.scan.registered', values)).toBe('登録しました：森 由紀子 / 株式会社ひかり物流')
    expect(en.t('contacts.scan.registered', values)).toBe('Registered: 森 由紀子 / 株式会社ひかり物流')
    expect(ja.t('contacts.scan.review', { reason: ja.t('contacts.reason.unlinked') })).toBe('確認が必要：自動登録を取り消しました')
    expect(ja.t('contacts.ocr.unavailable')).toBe('OCRを使えません')
    expect(ja.t('contacts.scan.unlink')).toBe('取り消す')
    expect(ja.t('contacts.settings.local')).toBe('名刺画像はクラスタ外に出ません。')
    expect(ja.t('contacts.settings.remote', { model: 'gpt-4o-mini' })).toBe('名刺画像は gpt-4o-mini へ送信されます。')
    expect(en.t('contacts.settings.modeOff')).toBe("Don't use OCR")
    expect(ja.t('contacts.contact.autoRegistered')).toBe('自動登録')
    expect(ja.t('contacts.history.auto')).toBe('自動')
  })

  test('OCR model selection names release and gateway defaults and provider locality in both languages', () => {
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    expect(ja.t('contacts.settings.ocrModel')).toBe('読み取りに使うモデル')
    expect(en.t('contacts.settings.ocrModel')).toBe('Model for card reading')
    expect(ja.t('contacts.settings.releaseModel', { model: 'gpt-5-mini' })).toBe('リリース既定 (gpt-5-mini)')
    expect(en.t('contacts.settings.releaseModel', { model: 'gpt-5-mini' })).toBe('Release default (gpt-5-mini)')
    expect(ja.t('contacts.settings.gatewayDefault')).toBe('gateway既定')
    expect(en.t('contacts.settings.gatewayDefault')).toBe('Gateway default')
    expect(ja.t('contacts.settings.modelLocal')).toBe('クラスタ内')
    expect(en.t('contacts.settings.modelLocal')).toBe('In cluster')
    expect(ja.t('contacts.settings.modelExternal', { owner: 'openai' })).toBe('外部: openai')
    expect(en.t('contacts.settings.modelExternal', { owner: 'openai' })).toBe('External: openai')
  })

  test('sheet wording (many cards in one image) exists in both languages with its count filled in', () => {
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    const sheet = messages.filter(([id]) => /^contacts\.(scan\.(sheet|showSheet)|settings\.noSheetSplit)/.test(id))
    expect(sheet.map(([id]) => id).sort()).toEqual([
      'contacts.scan.sheetGroup',
      'contacts.scan.sheetImage',
      'contacts.scan.sheetTag',
      'contacts.scan.sheetTagHint',
      'contacts.scan.showSheet',
      'contacts.settings.noSheetSplit',
    ])
    for (const [id, message] of sheet) expect(message.translations.ja, id).not.toBe(message.defaultMessage)
    expect(ja.t('contacts.scan.sheetGroup', { count: 4 })).toBe('シートから 4 枚')
    expect(en.t('contacts.scan.sheetGroup', { count: 4 })).toBe('4 cards from one sheet')
    expect(ja.t('contacts.scan.sheetTag')).toBe('シート')
    expect(ja.t('contacts.scan.showSheet')).toBe('シートを表示')
    expect(en.t('contacts.scan.showSheet')).toBe('Show sheet')
    expect(ja.t('contacts.settings.noSheetSplit')).toBe('複数の名刺を写した画像は、1 枚の名刺として保存されます。')
    expect(en.t('contacts.settings.noSheetSplit')).toBe('An image showing several cards is stored as a single card.')
  })

  test('every message a screen names exists, and none is left unused', () => {
    const defined = new Set(messages.map(([id]) => id))
    const used = new Set(sources(import.meta.dir).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/'(contacts\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]!)))
    expect([...used].filter((id) => !defined.has(id))).toEqual([])
    expect([...defined].filter((id) => !used.has(id))).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import type { BusinessCard, Contact, ContactSummary, OcrFields } from '../api/contacts'
import {
  confirmCreateBody,
  contactPatch,
  dateInputToIso,
  directoryProfileUrl,
  emailDomain,
  formFromContact,
  formFromOcr,
  formProblems,
  groupByCompany,
  groupSheetRuns,
  hasPendingCards,
  knownMemberName,
  normalizeName,
  splitLines,
  todayInput,
} from './contact'

const ocr: OcrFields = {
  fullName: '森 由紀子',
  kana: 'モリ ユキコ',
  company: '株式会社ひかり物流',
  department: '営業企画部',
  title: '課長',
  emails: ['mori@hikari-logi.co.jp'],
  phones: ['03-1234-5678', '090-8765-4321'],
  address: '東京都港区芝浦1-2-3',
  url: 'https://hikari-logi.co.jp',
  confidence: 0.93,
}

const member = { id: 'm1', displayName: '山田 太郎', email: 'yamada@example.com', directoryPersonId: 'p-yamada' }

const contact: Contact = {
  id: 'c1',
  fullName: '高橋 健一',
  kana: 'タカハシ ケンイチ',
  title: '部長',
  department: '営業部',
  company: { id: 'co1', name: '株式会社サンプル商事' },
  primaryEmail: 'takahashi@sample-shoji.co.jp',
  visibility: 'shared',
  state: 'active',
  tags: [],
  encounterCount: 1,
  knownByMe: true,
  lastMetAt: '2026-09-03T09:00:00.000Z',
  updatedAt: '2026-09-03T09:00:00.000Z',
  emails: ['takahashi@sample-shoji.co.jp'],
  phones: ['03-1111-2222'],
  address: null,
  notes: null,
  createdBy: member,
  registeredBy: 'member',
  version: 4,
  createdAt: '2026-09-03T09:00:00.000Z',
  cards: [],
  encounters: [],
  changes: [],
}

const summary = (id: string, company: ContactSummary['company']): ContactSummary => ({ ...contact, id, company })

describe('normalisation (domain.normalizedName, C4)', () => {
  test('NFKC, lower case and no whitespace, so full-width and spaced names compare equal', () => {
    expect(normalizeName('高橋　健一')).toBe(normalizeName('高橋 健一'))
    expect(normalizeName('ＡＢＣ 商事')).toBe('abc商事')
    expect(normalizeName(' Emily  Clark ')).toBe(normalizeName('emily clark'))
  })

  test('email domain is the lower-cased part after the last @', () => {
    expect(emailDomain('E.Clark@Tokyo-Tech.JP')).toBe('tokyo-tech.jp')
    expect(emailDomain('a@b@example.com')).toBe('example.com')
    expect(emailDomain('no-at-sign')).toBeNull()
    expect(emailDomain('trailing@')).toBeNull()
  })

  test('lists typed one per line are trimmed and de-duplicated', () => {
    expect(splitLines(' a@example.com \n\n b@example.com\r\na@example.com ')).toEqual(['a@example.com', 'b@example.com'])
  })
})

describe('confirm and edit forms', () => {
  test('OCR fields pre-fill the confirm form; an unread card starts empty and shared', () => {
    const form = formFromOcr(ocr)
    expect(form).toMatchObject({ fullName: '森 由紀子', companyName: '株式会社ひかり物流', emails: 'mori@hikari-logi.co.jp', phones: '03-1234-5678\n090-8765-4321', visibility: 'shared' })
    expect(formFromOcr(null).fullName).toBe('')
    expect(formFromOcr({ ...ocr, kana: '', company: null }).companyName).toBe('')
  })

  test('creating sends the company as companyName beside the contact, empty text as null', () => {
    const body = confirmCreateBody({ ...formFromOcr(ocr), kana: '  ', department: '' })
    expect(body.companyName).toBe('株式会社ひかり物流')
    expect(body.contact).not.toHaveProperty('companyName')
    expect(body.contact).toMatchObject({ fullName: '森 由紀子', kana: null, department: null, phones: ['03-1234-5678', '090-8765-4321'], visibility: 'shared' })
    expect(confirmCreateBody({ ...formFromOcr(ocr), companyName: ' ' }).companyName).toBeNull()
  })

  test('a PATCH carries only what changed; a company renamed by spacing alone is unchanged', () => {
    const form = formFromContact(contact)
    expect(contactPatch(contact, form)).toEqual({})
    expect(contactPatch(contact, { ...form, companyName: '株式会社サンプル商事 ' })).toEqual({})
    expect(contactPatch(contact, { ...form, title: '本部長', emails: 'takahashi@sample-shoji.co.jp\nk.takahashi@example.com' })).toEqual({
      title: '本部長',
      emails: ['takahashi@sample-shoji.co.jp', 'k.takahashi@example.com'],
    })
    expect(contactPatch(contact, { ...form, companyName: '' })).toEqual({ companyId: null })
    expect(contactPatch(contact, { ...form, companyName: '東京テック株式会社', visibility: 'private' })).toEqual({ companyName: '東京テック株式会社', visibility: 'private' })
  })

  test('a name is required and bounded; every email must look like one', () => {
    expect(formProblems(formFromOcr(null))).toEqual({ fullName: 'nameRequired' })
    expect(formProblems({ ...formFromOcr(ocr), fullName: 'あ'.repeat(201) }).fullName).toBe('nameTooLong')
    expect(formProblems({ ...formFromOcr(ocr), emails: 'mori@hikari-logi.co.jp\nnot an email' })).toEqual({ emails: 'emailInvalid' })
    expect(formProblems(formFromOcr(ocr))).toEqual({})
  })
})

describe('lists', () => {
  test('groups keep first-appearance order with company-less contacts last', () => {
    const a = { id: 'co-a', name: 'A' }
    const b = { id: 'co-b', name: 'B' }
    const groups = groupByCompany([summary('1', b), summary('2', null), summary('3', a), summary('4', b)])
    expect(groups.map((group) => [group.company?.id ?? null, group.contacts.map((item) => item.id)])).toEqual([
      ['co-b', ['1', '4']],
      ['co-a', ['3']],
      [null, ['2']],
    ])
  })

  test('the scan list polls only while a card is still being read', () => {
    const card = (ocrState: BusinessCard['ocrState']) => ({ ocrState }) as BusinessCard
    expect(hasPendingCards([card('done'), card('pending')])).toBe(true)
    expect(hasPendingCards([card('done'), card('failed'), card('unavailable')])).toBe(false)
  })

  test('consecutive cards of one sheet form one run; other cards, and a sheet interrupted by another card, stay apart', () => {
    const card = (id: string, sheetId: string | null = null) => ({ id, sheetId }) as BusinessCard
    const runs = groupSheetRuns([card('a', 's1'), card('b', 's1'), card('c'), card('d'), card('e', 's2'), card('f', 's1'), card('g', 's2'), card('h', 's2')])
    expect(runs.map((run) => [run.sheetId, run.cards.map((item) => item.id)])).toEqual([
      ['s1', ['a', 'b']],
      [null, ['c']],
      [null, ['d']],
      ['s2', ['e']],
      ['s1', ['f']],
      ['s2', ['g', 'h']],
    ])
    expect(groupSheetRuns([])).toEqual([])
  })

  test('cards of one sheet are shown in reading order, not newest-first; tilt within half a card height keeps a row together', () => {
    const card = (id: string, bbox: [number, number, number, number]) => ({ id, sheetId: 's', bbox }) as BusinessCard
    // server order is newest-first: bottom-right card first
    const runs = groupSheetRuns([
      card('br', [812, 910, 1504, 1358]),
      card('bl', [59, 940, 752, 1358]),
      card('tr', [812, 49, 1504, 473]),
      card('tl', [59, 80, 752, 473]),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.cards.map((item) => item.id)).toEqual(['tl', 'tr', 'bl', 'br'])
  })

  test('Directory profile links need both the browser origin and a linked person', () => {
    expect(directoryProfileUrl('https://directory.example/', 'p 1')).toBe('https://directory.example/people/p%201')
    expect(directoryProfileUrl(null, 'p1')).toBeUndefined()
    expect(directoryProfileUrl('https://directory.example', null)).toBeUndefined()
  })

  test('a member without a Directory person is unknown (C6)', () => {
    expect(knownMemberName(member)).toBe('山田 太郎')
    expect(knownMemberName({ ...member, directoryPersonId: null })).toBeNull()
    expect(knownMemberName({ ...member, displayName: ' ' })).toBeNull()
  })

  test('date inputs round-trip through local midnight', () => {
    const iso = dateInputToIso('2026-10-29')!
    expect(todayInput(new Date(iso))).toBe('2026-10-29')
    expect(dateInputToIso('')).toBeUndefined()
  })
})

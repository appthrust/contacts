import { beforeEach, describe, expect, test } from 'bun:test'
import type { BusinessCard, Contact, ContactSummary, Page, Settings, UploadResult } from '../api/contacts'
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS } from '../model/registration'
import { contactsRoutes, MOCK_MEMBER_IDS, MOCK_MODELS, OPENAPI_FILE } from './mock-contacts'

type Init = { body?: unknown; form?: FormData; headers?: Record<string, string> }

async function call(method: string, path: string, init: Init = {}) {
  const url = new URL(path.startsWith('/config') ? path : `/api/contacts/v1${path}`, 'http://mock.test')
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await contactsRoutes(new Request(url, { method, headers, body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) }), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  const type = response.headers.get('Content-Type') ?? ''
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 204 ? undefined : type.includes('json') ? await response.json() : await response.text(),
  }
}

const as = (member: keyof typeof MOCK_MEMBER_IDS, admin = false) => call('POST', '/__mock/caller', { body: { memberId: MOCK_MEMBER_IDS[member], admin } })
const png = (bytes = 64) => new File([new Uint8Array(bytes)], 'card.png', { type: 'image/png' })

function upload(fields: Record<string, string> = {}, image: Blob = png()) {
  const form = new FormData()
  // Bun derives a part's type from the file name, so the name must match the type under test.
  form.set('image', image, image instanceof File ? image.name : 'card.png')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return call('POST', '/cards', { form })
}

/** An upload of one card (no sheet): the card it answers. */
async function uploadCard(fields: Record<string, string> = {}, image: Blob = png()): Promise<BusinessCard> {
  const result: UploadResult = (await upload(fields, image)).body
  expect(result.sheet).toBeNull()
  expect(result.cards).toHaveLength(1)
  return result.cards[0]!
}

async function contactNamed(name: string): Promise<ContactSummary> {
  const page: Page<ContactSummary> = (await call('GET', `/contacts?q=${encodeURIComponent(name)}`)).body
  const found = page.items.find((item) => item.fullName === name)
  if (!found) throw new Error(`no contact ${name}`)
  return found
}
/** Admin only: switch the registration policy (the default is `auto`). */
const policy = (settings: Partial<Settings>) => call('PUT', '/settings', { body: { ...DEFAULT_SETTINGS, ...settings } })

beforeEach(async () => {
  expect((await call('POST', '/__mock/reset')).body).toEqual({ reset: true })
  await call('POST', '/__mock/ocr', { body: { available: true, delayMs: 0, failNext: false } })
})

describe('contacts mock contract', () => {
  test('GET /me and GET /config describe the caller, roles, OCR and Directory', async () => {
    const { body: me } = await call('GET', '/me')
    expect(me.member).toMatchObject({ id: MOCK_MEMBER_IDS.yamada, displayName: '山田 太郎', directoryPersonId: 'p-yamada' })
    expect(me.roles).toEqual({ contactsAdmin: true })
    expect(me.ocr).toEqual({ available: true, extractor: 'gateway-vision', model: 'gemma3:4b', releaseModel: 'gemma3:4b', models: MOCK_MODELS, local: true, sheetSplit: true })
    // 山田's five seeded cards plus the one waiting for review.
    expect(me.counts).toEqual({ myCards: 6, myContacts: 5, contacts: 12, companies: 4 })
    expect((await call('GET', '/config')).body).toEqual({ projectId: 'pj-mock', publicUrl: 'https://contacts.pj-mock.appthrust.ink', directoryUrl: 'https://directory.pj-mock.appthrust.ink' })
    await as('suzuki')
    const member = (await call('GET', '/me')).body
    expect(member.roles.contactsAdmin).toBe(false)
    expect(member.directory.linked).toBe(false)
    // 井上 (private to 佐藤) and 松本 (private to 山田) are hidden from 鈴木 (C5).
    expect(member.counts.contacts).toBe(10)
  })

  test('an upload is pending, then OCR reads it into an extraction; the card serves its image', async () => {
    await call('POST', '/__mock/ocr', { body: { delayMs: 60_000 } })
    const uploaded = await upload({ exchangedAt: '2026-10-29T00:00:00Z', place: '展示会' })
    expect(uploaded.status).toBe(202)
    const card: BusinessCard = uploaded.body.cards[0]
    expect(uploaded.body.sheet).toBeNull()
    expect(card).toMatchObject({ ocrState: 'pending', extraction: null, decision: null, decisionReason: null, contactId: null, place: '展示会', exchangedAt: '2026-10-29T00:00:00.000Z' })
    expect(card.imageUrl).toBe(`/api/contacts/v1/cards/${card.id}/image`)
    expect((await call('GET', `/cards/${card.id}`)).body.ocrState).toBe('pending')

    await call('POST', '/__mock/ocr', { body: { delayMs: 0 } })
    const second = await uploadCard()
    expect(second.ocrState).toBe('done')
    expect(second.extraction).toMatchObject({ engine: 'gateway-vision', model: 'gemma3:4b', overall: 0.88, fields: { company: '東京テック株式会社', fullName: '伊藤 さくら' } })
    expect(second.extraction?.fieldConfidence).toMatchObject({ fullName: 0.88, emails: 0.88 })
    expect(Object.keys(second.extraction?.fieldConfidence ?? {})).not.toContain('confidence')

    const image = await call('GET', `/cards/${card.id}/image`)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=3600')
    const mine: Page<BusinessCard> = (await call('GET', '/cards?owner=me')).body
    expect(mine.items.slice(0, 2).map((item) => item.id)).toEqual([second.id, card.id])
  })

  test('automatic registration: a confident new person is created, a known email is linked, a low-confidence read waits', async () => {
    // FAKE_OCR turn 1: 森 由紀子 read at 0.92 ≥ 0.85, nobody matches.
    const created = await uploadCard({ exchangedAt: '2026-10-29T00:00:00Z' })
    expect(created).toMatchObject({ ocrState: 'done', decision: 'AutoCreated', decisionReason: null })
    expect(created.extraction?.overall).toBe(0.92)
    const mori: Contact = (await call('GET', `/contacts/${created.contactId}`)).body
    expect(mori).toMatchObject({ fullName: '森 由紀子', registeredBy: 'auto', visibility: 'shared', company: { name: '株式会社ひかり物流' }, encounterCount: 1, knownByMe: true })
    expect(mori.createdBy.id).toBe(MOCK_MEMBER_IDS.yamada)
    expect(mori.encounters).toEqual([{ member: expect.objectContaining({ id: MOCK_MEMBER_IDS.yamada }), firstAt: '2026-10-29T00:00:00.000Z', lastAt: '2026-10-29T00:00:00.000Z', cardCount: 1 }])
    expect(mori.changes).toEqual([expect.objectContaining({ source: 'auto', actor: expect.objectContaining({ id: MOCK_MEMBER_IDS.yamada }) })])
    expect(mori.changes[0]?.diff.fullName).toEqual({ from: null, to: '森 由紀子' })

    // Turn 2: 伊藤 さくら's email is already in contacts (score 1.0 ≥ 0.9).
    const ito = await contactNamed('伊藤 さくら')
    const linked = await uploadCard()
    expect(linked).toMatchObject({ decision: 'AutoLinked', contactId: ito.id })
    const itoDetail: Contact = (await call('GET', `/contacts/${ito.id}`)).body
    expect(itoDetail.registeredBy).toBe('member')
    expect(itoDetail.changes[0]).toMatchObject({ source: 'auto', diff: { cards: { from: null, to: linked.id } } })

    // Turn 3: 0.45 < 0.85 with no match.
    const waiting = await uploadCard()
    expect(waiting).toMatchObject({ decision: 'NeedsReview', decisionReason: 'low_confidence', contactId: null })
  })

  test('the seeded low-confidence card waits in 山田\'s review queue; seeded automatic registrations say so', async () => {
    const mine: Page<BusinessCard> = (await call('GET', '/cards?owner=me')).body
    const waiting = mine.items.filter((card) => !card.contactId)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ ocrState: 'done', decision: 'NeedsReview', decisionReason: 'low_confidence', extraction: { overall: 0.52, fields: { fullName: '前田 智也' } } })
    expect(mine.items.filter((card) => card.decision === 'AutoCreated')).toHaveLength(1)
    const clark: Contact = (await call('GET', `/contacts/${(await contactNamed('Emily Clark')).id}`)).body
    expect(clark).toMatchObject({ registeredBy: 'auto', changes: [expect.objectContaining({ source: 'auto' })] })
  })

  test('the policy decides: review sends everything to a member, off decides nothing, required fields and private default apply', async () => {
    expect((await policy({ mode: 'review' })).status).toBe(200)
    expect(await uploadCard()).toMatchObject({ decision: 'NeedsReview', decisionReason: 'policy', contactId: null })
    // `off` still reads (the form is pre-filled) but registers nothing.
    await policy({ mode: 'off' })
    const off = await uploadCard()
    expect(off).toMatchObject({ ocrState: 'done', decision: 'Unavailable', contactId: null })
    expect(off.extraction?.fields.fullName).toBe('伊藤 さくら')
    // Turn 3 (佐々木) has no kana: a missing required field is checked before confidence.
    await policy({ requiredFields: ['fullName', 'kana'] })
    expect(await uploadCard()).toMatchObject({ decision: 'NeedsReview', decisionReason: 'missing_field:kana', contactId: null })
    // Turn 4 is 森 again, created private by default.
    await policy({ privateDefault: true })
    const created = await uploadCard()
    expect(created.decision).toBe('AutoCreated')
    expect((await call('GET', `/contacts/${created.contactId}`)).body).toMatchObject({ registeredBy: 'auto', visibility: 'private' })
  })

  test('confirming a card under review creates the contact as the member, with one encounter', async () => {
    await policy({ mode: 'review' })
    const card = await uploadCard({ exchangedAt: '2026-10-29T00:00:00Z' })
    expect(card.extraction?.fields.fullName).toBe('森 由紀子')
    const confirmed = await call('POST', `/cards/${card.id}/confirm`, {
      body: { contact: { fullName: '森 由紀子', kana: 'モリ ユキコ', emails: ['mori@hikari-logi.co.jp'], visibility: 'shared' }, companyName: '株式会社ひかり物流' },
    })
    expect(confirmed.status).toBe(200)
    const contact: Contact = confirmed.body
    expect(contact).toMatchObject({ fullName: '森 由紀子', state: 'active', registeredBy: 'member', company: { name: '株式会社ひかり物流' }, encounterCount: 1, knownByMe: true, version: 1 })
    expect(contact.cards.map((item) => item.id)).toEqual([card.id])
    expect(contact.changes).toEqual([expect.objectContaining({ source: 'member' })])
    expect((await call('GET', `/cards/${card.id}`)).body.contactId).toBe(contact.id)
    expect((await contactNamed('森 由紀子')).id).toBe(contact.id)
    // The company was created from the confirmed name and is now listed.
    expect((await call('GET', `/companies?q=${encodeURIComponent('ひかり')}`)).body.items).toHaveLength(1)
  })

  test('linking a card to an existing contact adds the member to its encounters (C7)', async () => {
    await policy({ mode: 'review' })
    await as('suzuki')
    const ito = await contactNamed('伊藤 さくら')
    expect(ito).toMatchObject({ encounterCount: 1, knownByMe: false })
    const card = await uploadCard()
    const linked: Contact = (await call('POST', `/cards/${card.id}/confirm`, { body: { contactId: ito.id } })).body
    expect(linked).toMatchObject({ id: ito.id, encounterCount: 2, knownByMe: true })
    expect(linked.encounters.map((encounter) => encounter.member.id).sort()).toEqual([MOCK_MEMBER_IDS.yamada, MOCK_MEMBER_IDS.suzuki].sort())
    expect((await call('GET', '/contacts?knownBy=me')).body.items.map((item: ContactSummary) => item.id)).toContain(ito.id)
  })

  test('unlinking undoes an automatic registration (R3): the card returns to review, an untouched auto contact is archived', async () => {
    const card = await uploadCard()
    const contactId = card.contactId!
    expect(card.decision).toBe('AutoCreated')
    // 佐藤 sees the card through its shared contact but neither owns it nor is an admin.
    await as('sato')
    expect((await call('POST', `/cards/${card.id}/unlink`)).status).toBe(403)
    await as('yamada', true)

    const unlinked = await call('POST', `/cards/${card.id}/unlink`)
    expect(unlinked.status).toBe(200)
    expect(unlinked.body).toMatchObject({ id: card.id, contactId: null, decision: 'NeedsReview', decisionReason: 'unlinked', ocrState: 'done' })
    const archived: Contact = (await call('GET', `/contacts/${contactId}`)).body
    expect(archived).toMatchObject({ state: 'archived', encounterCount: 0, cards: [] })
    expect(archived.changes[0]).toMatchObject({ source: 'member', diff: { cards: { from: card.id, to: null }, state: { from: 'active', to: 'archived' } } })
    expect((await call('GET', '/contacts')).body.items.map((item: ContactSummary) => item.id)).not.toContain(contactId)

    // Back in review, the member files it by hand.
    const confirmed: Contact = (await call('POST', `/cards/${card.id}/confirm`, { body: { contact: { fullName: '森 由紀子' }, companyName: null } })).body
    expect(confirmed.registeredBy).toBe('member')
    expect((await call('GET', `/cards/${card.id}`)).body).toMatchObject({ contactId: confirmed.id, decision: 'NeedsReview' })
  })

  test('unlinking keeps a contact that has another card or a member\'s edit', async () => {
    // AutoLinked onto 伊藤, who has 山田's earlier card.
    await upload()
    const linked = await uploadCard()
    expect(linked.decision).toBe('AutoLinked')
    await call('POST', `/cards/${linked.id}/unlink`)
    expect((await call('GET', `/contacts/${linked.contactId}`)).body.state).toBe('active')

    // An auto-created contact a member edited stays.
    await call('POST', '/__mock/reset')
    await call('POST', '/__mock/ocr', { body: { delayMs: 0 } })
    const created = await uploadCard()
    const contact: Contact = (await call('GET', `/contacts/${created.contactId}`)).body
    await call('PATCH', `/contacts/${contact.id}`, { body: { title: '部長' }, headers: { 'If-Match': String(contact.version) } })
    await call('POST', `/cards/${created.id}/unlink`)
    expect((await call('GET', `/contacts/${contact.id}`)).body).toMatchObject({ state: 'active', encounterCount: 0 })
  })

  test('settings: everyone reads the defaults; only admins write, validated like registration.Validate (R7)', async () => {
    expect((await call('GET', '/settings')).body).toEqual(DEFAULT_SETTINGS)
    await as('sato')
    expect((await call('GET', '/settings')).body.mode).toBe('auto')
    expect((await policy({ mode: 'review' })).status).toBe(403)
    await as('yamada', true)
    expect((await policy({ mode: 'sometimes' as Settings['mode'] })).body).toMatchObject({ error: 'invalid_request', message: 'mode must be auto, review, or off' })
    expect((await policy({ autoLinkThreshold: 1.5 })).status).toBe(400)
    expect((await policy({ requiredFields: ['nickname'] })).body.message).toBe('unknown required field: nickname')
    expect((await call('PUT', '/settings', { body: [] })).status).toBe(400)
    const saved = await policy({ mode: 'review', autoCreateThreshold: 0.7, requiredFields: ['fullName', 'company'], privateDefault: true })
    expect(saved.body).toEqual({ ...DEFAULT_SETTINGS, mode: 'review', autoCreateThreshold: 0.7, requiredFields: ['fullName', 'company'], privateDefault: true })
    expect((await call('GET', '/settings')).body).toEqual(saved.body)
  })

  test('model overrides change the next extraction and locality; clearing restores the release default', async () => {
    for (const ocrModel of ['gpt-5-mini', 'qwen3-vl-4b-instruct-fp8', '']) {
      expect((await policy({ ocrModel })).body.ocrModel).toBe(ocrModel)
      expect((await call('GET', '/settings')).body.ocrModel).toBe(ocrModel)
      const model = ocrModel || 'gemma3:4b'
      expect((await call('GET', '/me')).body.ocr).toMatchObject({ model, releaseModel: 'gemma3:4b', models: MOCK_MODELS, local: model !== 'gpt-5-mini' })
      expect((await uploadCard()).extraction?.model).toBe(model)
    }
    await as('sato')
    expect((await policy({ ocrModel: 'gpt-5-mini' })).status).toBe(403)
    expect((await call('GET', '/settings')).body.ocrModel).toBe('')
  })

  test('model validation rejects whitespace, controls and more than 128 characters', async () => {
    for (const ocrModel of ['gpt mini', 'gpt\tmini', 'gpt\nmini', 'gpt\u00a0mini', 'gpt\u3000mini', 'gpt\u0000mini', 'gpt\u007fmini', 'gpt\u0085mini']) {
      expect((await policy({ ocrModel })).body).toMatchObject({ error: 'invalid_request', message: 'ocrModel must not contain whitespace or control characters' })
    }
    for (const ocrModel of ['a'.repeat(129), '界'.repeat(129)]) {
      expect((await policy({ ocrModel })).body.message).toBe('ocrModel must be at most 128 characters')
    }
    for (const ocrModel of ['', 'a'.repeat(128), '界'.repeat(128)]) expect((await policy({ ocrModel })).status).toBe(200)
  })

  test('without a gateway uploads are unavailable (D3) and OCR retries are refused', async () => {
    await call('POST', '/__mock/ocr', { body: { available: false } })
    expect((await call('GET', '/me')).body.ocr).toEqual({ available: false, extractor: '', model: 'gemma3:4b', releaseModel: 'gemma3:4b', models: [], local: false, sheetSplit: false })
    const card = await uploadCard()
    expect(card).toMatchObject({ ocrState: 'unavailable', extraction: null, decision: 'Unavailable' })
    expect((await call('POST', `/cards/${card.id}/ocr`)).body).toMatchObject({ error: 'ocr_unavailable' })
    await call('POST', '/__mock/ocr', { body: { available: true } })
    expect((await call('POST', `/cards/${card.id}/ocr`)).body).toMatchObject({ ocrState: 'done', decision: 'AutoCreated' })
  })

  test('a failed read can be retried; uploads refuse oversized and non-image files', async () => {
    await call('POST', '/__mock/ocr', { body: { failNext: true } })
    const failed = await uploadCard()
    expect(failed.ocrState).toBe('failed')
    expect(failed.ocrError).toBeTruthy()
    expect((await call('POST', `/cards/${failed.id}/ocr`)).body).toMatchObject({ ocrState: 'done', ocrError: null })
    expect((await call('POST', `/cards/${failed.id}/ocr`)).status).toBe(409)
    expect((await upload({}, png(5 * 1024 * 1024 + 1))).body).toMatchObject({ error: 'image_too_large' })
    expect((await upload({}, new File(['hello'], 'note.txt', { type: 'text/plain' }))).status).toBe(415)
  })

  test('PATCH needs If-Match: a stale version is 409 version_conflict and changes nothing (C2)', async () => {
    const takahashi = await contactNamed('高橋 健一')
    const before: Contact = (await call('GET', `/contacts/${takahashi.id}`)).body
    expect((await call('PATCH', `/contacts/${takahashi.id}`, { body: { title: '本部長' } })).status).toBe(400)
    const saved = await call('PATCH', `/contacts/${takahashi.id}`, { body: { title: '本部長' }, headers: { 'If-Match': String(before.version) } })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ title: '本部長', version: before.version + 1 })
    expect(saved.body.changes[0]).toMatchObject({ actor: { id: MOCK_MEMBER_IDS.yamada }, diff: { title: { from: '部長', to: '本部長' } } })

    const stale = await call('PATCH', `/contacts/${takahashi.id}`, { body: { title: '社長' }, headers: { 'If-Match': String(before.version) } })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('version_conflict')
    expect((await call('GET', `/contacts/${takahashi.id}`)).body.title).toBe('本部長')
  })

  test('duplicates are proposed by name + domain and name + company; merging moves cards and archives the source', async () => {
    const pairs = (await call('GET', '/contacts/duplicates')).body.items as { contacts: ContactSummary[]; reason: string }[]
    expect(pairs.map((pair) => [pair.reason, pair.contacts.map((item) => item.fullName).sort()])).toEqual([
      ['name_company', ['高橋 健一', '高橋\u3000健一']],
      ['name_domain', ['Emily Clark', 'emily clark']],
    ])
    const [keep, drop] = pairs[1]!.contacts as [ContactSummary, ContactSummary]
    const target: Contact = (await call('GET', `/contacts/${keep.id}`)).body
    await as('suzuki')
    expect((await call('POST', `/contacts/${keep.id}/merge`, { body: { sourceId: drop.id }, headers: { 'If-Match': String(target.version) } })).status).toBe(403)
    await as('yamada', true)
    const merged: Contact = (await call('POST', `/contacts/${keep.id}/merge`, { body: { sourceId: drop.id }, headers: { 'If-Match': String(target.version) } })).body
    expect(merged.encounterCount).toBe(2)
    expect(merged.cards).toHaveLength(2)
    expect((await call('GET', `/contacts/${drop.id}`)).body.state).toBe('archived')
    expect((await call('GET', '/contacts/duplicates')).body.items).toHaveLength(1)
  })

  test('tags are versioned contact mutations; shared tags need admin', async () => {
    const ito = await contactNamed('伊藤 さくら')
    const tags = (await call('GET', '/tags')).body.items as { id: string; name: string }[]
    const prospect = tags.find((tag) => tag.name === '見込み客')!
    const contact: Contact = (await call('GET', `/contacts/${ito.id}`)).body
    expect((await call('PUT', `/contacts/${ito.id}/tags/${prospect.id}`, { headers: { 'If-Match': String(contact.version) } })).status).toBe(204)
    const tagged: Contact = (await call('GET', `/contacts/${ito.id}`)).body
    expect(tagged.version).toBe(contact.version + 1)
    expect(tagged.tags.map((tag) => tag.name)).toContain('見込み客')
    expect((await call('GET', `/contacts?tag=${prospect.id}`)).body.items.map((item: ContactSummary) => item.id)).toContain(ito.id)
    expect((await call('DELETE', `/contacts/${ito.id}/tags/${prospect.id}`, { headers: { 'If-Match': String(contact.version) } })).status).toBe(409)
    await as('sato')
    expect((await call('POST', '/tags', { body: { name: '共有タグ', shared: true } })).status).toBe(403)
    expect((await call('POST', '/tags', { body: { name: '自分用', shared: false } })).body).toMatchObject({ name: '自分用', ownerMemberId: MOCK_MEMBER_IDS.sato })
  })

  test('company merge redirects the loser; its contacts follow (C3)', async () => {
    const companies = (await call('GET', '/companies')).body.items as { id: string; name: string; contactCount: number }[]
    const sample = companies.find((company) => company.name === '株式会社サンプル商事')!
    const mirai = companies.find((company) => company.name === '合同会社みらいデザイン')!
    await as('sato')
    expect((await call('POST', `/companies/${sample.id}/merge`, { body: { sourceId: mirai.id } })).status).toBe(403)
    await as('yamada', true)
    const merged = (await call('POST', `/companies/${sample.id}/merge`, { body: { sourceId: mirai.id } })).body
    expect(merged.contactCount).toBe(sample.contactCount + mirai.contactCount)
    expect((await call('GET', `/companies/${mirai.id}`)).body.id).toBe(sample.id)
    expect((await call('GET', '/companies')).body.items).toHaveLength(3)
    expect((await contactNamed('中村 優子')).company?.id).toBe(sample.id)
  })

  test('cursor paging walks every contact once; CSV export has a BOM and the contract columns', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const response: { body: Page<ContactSummary> } = await call('GET', `/contacts?limit=5${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...response.body.items.map((item) => item.id))
      cursor = response.body.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
    expect((await call('GET', '/contacts?limit=101')).status).toBe(400)
    expect((await call('GET', '/contacts?cursor=%25%25')).status).toBe(400)

    const csv = await call('GET', '/export.csv?scope=me')
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(csv.body.startsWith('\uFEFFfullName,kana,company,department,title,emails,phones,address,visibility,firstMetAt,lastMetAt,metBy\r\n')).toBe(true)
    expect(csv.body).toContain('高橋 健一,タカハシ ケンイチ,株式会社サンプル商事')
    await as('sato')
    expect((await call('GET', '/export.csv?scope=project')).status).toBe(403)
  })

  test('archiving needs the creator or an admin and the current version', async () => {
    const ito = await contactNamed('伊藤 さくら')
    const contact: Contact = (await call('GET', `/contacts/${ito.id}`)).body
    await as('sato')
    expect((await call('DELETE', `/contacts/${ito.id}`, { headers: { 'If-Match': String(contact.version) } })).status).toBe(403)
    await as('yamada')
    expect((await call('DELETE', `/contacts/${ito.id}`, { headers: { 'If-Match': String(contact.version) } })).status).toBe(204)
    expect((await call('GET', '/contacts')).body.items.map((item: ContactSummary) => item.id)).not.toContain(ito.id)
    expect((await call('GET', '/contacts?state=archived')).body.items.map((item: ContactSummary) => item.id)).toEqual([ito.id])
  })

  test('/openapi.json is the server\'s committed document, and the mock answers every operation in it', async () => {
    const served = await call('GET', '/openapi.json')
    expect(served.status).toBe(200)
    expect(served.body).toEqual(JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')))
    const doc = served.body as {
      openapi: string
      'x-appthrust-definition': string
      servers: { url: string }[]
      paths: Record<string, Record<string, { operationId?: string; parameters?: { name: string; in: string; required?: boolean }[]; requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }>>
    }
    expect(doc).toMatchObject({ openapi: '3.0.3', 'x-appthrust-definition': 'contacts', servers: [{ url: '/api/contacts/v1' }] })

    // Representative operations carry the shapes the SPA sends.
    const patch = doc.paths['/contacts/{id}']!.patch!
    expect(patch.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', in: 'header', required: true }))
    expect(patch.requestBody?.content['application/json']?.schema).toEqual({ $ref: '#/components/schemas/ContactPatch' })
    expect(doc.paths['/contacts/{id}/merge']!.post!.parameters).toContainEqual(expect.objectContaining({ name: 'If-Match', in: 'header' }))
    expect(doc.paths['/cards/{id}/confirm']!.post!.requestBody?.content['application/json']?.schema).toEqual({ $ref: '#/components/schemas/ConfirmInput' })
    const upload = doc.paths['/cards']!.post!.requestBody?.content['multipart/form-data']?.schema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(upload.properties).sort()).toEqual(['contactId', 'exchangedAt', 'image', 'place'])
    expect(upload.required).toEqual(['image'])

    // No documented operation falls through to the mock's "no mock for" answer.
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => [method.toUpperCase(), path.replace(/\{[^}]+\}/g, 'unknown-id')] as const)
    )
    // The design's route table has 28 operations; the document may grow, never shrink.
    expect(operations.length).toBeGreaterThanOrEqual(28)
    for (const [method, path] of operations) {
      const answer = await call(method, path)
      expect(typeof answer.body === 'object' && answer.body ? String(answer.body.message) : '', `${method} ${path}`).not.toStartWith('no mock for')
    }
  })

  test('a file named *sheet* is split into 3–6 cards with distinct people, each read on its own, plus the sheet image', async () => {
    const bytes = new Uint8Array(96).map((_, index) => index)
    const uploaded = await upload({ place: '展示会' }, new File([bytes], 'expo-sheet.png', { type: 'image/png' }))
    expect(uploaded.status).toBe(202)
    const { cards, sheet }: UploadResult = uploaded.body
    // No digit in the name: 3 + 96 mod 4 = 3 cards.
    expect(sheet).toEqual({ id: expect.any(String), detected: 3, imageUrl: `/api/contacts/v1/sheets/${sheet!.id}/image` })
    expect(cards.map((card) => card.extraction?.fields.fullName)).toEqual(['石井 美咲', '岡田 大輔', '小林 直樹'])
    expect(cards.map((card) => [card.decision, card.decisionReason])).toEqual([
      ['AutoCreated', null],
      ['AutoCreated', null],
      ['NeedsReview', 'low_confidence'],
    ])
    for (const card of cards) {
      expect(card).toMatchObject({ sheetId: sheet!.id, place: '展示会', ocrState: 'done' })
      expect(card.bbox).toHaveLength(4)
      expect((await call('GET', `/cards/${card.id}/image`)).headers.get('Content-Type')).toBe('image/svg+xml')
    }
    expect(new Set(cards.map((card) => card.id)).size).toBe(3)

    // The sheet serves the uploaded bytes to its owner or an admin only.
    const image = await call('GET', `/sheets/${sheet!.id}/image`)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=3600')
    await as('sato')
    expect((await call('GET', `/sheets/${sheet!.id}/image`)).status).toBe(404)
    await as('yamada')
    expect((await call('GET', `/sheets/${sheet!.id}/image`)).status).toBe(200)

    // Listing and detail carry sheetId; deleting the last card deletes the sheet (S3).
    const mine: Page<BusinessCard> = (await call('GET', '/cards?owner=me')).body
    expect(mine.items.filter((card) => card.sheetId === sheet!.id)).toHaveLength(3)
    for (const [index, card] of cards.entries()) {
      expect((await call('DELETE', `/cards/${card.id}`)).status).toBe(204)
      expect((await call('GET', `/sheets/${sheet!.id}/image`)).status).toBe(index < cards.length - 1 ? 200 : 404)
    }
  })

  test('a digit 3–6 in a sheet file name picks the count; without a gateway or with contactId nothing is split', async () => {
    const sheet = (name: string) => new File([new Uint8Array(8)], name, { type: 'image/png' })
    const six: UploadResult = (await upload({}, sheet('sheet6.png'))).body
    expect(six.sheet?.detected).toBe(6)
    expect(new Set(six.cards.map((card) => card.extraction?.fields.fullName)).size).toBe(6)
    const ito = await contactNamed('伊藤 さくら')
    expect((await upload({ contactId: ito.id }, sheet('sheet-3.png'))).body).toMatchObject({ error: 'sheet_with_contact' })
    await call('POST', '/__mock/ocr', { body: { available: false } })
    const single: UploadResult = (await upload({}, sheet('sheet-5.png'))).body
    expect(single.sheet).toBeNull()
    expect(single.cards).toEqual([expect.objectContaining({ sheetId: null, bbox: null, ocrState: 'unavailable' })])
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { contactsRoutes } from '../dev/mock-contacts'
import { ContactsApiError, createContactsApi, exportUrl, isContactsError, sheetImageUrl } from './contacts'
import { retryQuery } from './queries'

type Call = { input: string; init: RequestInit }

/** The client wired to the in-repo mock, recording every request it sends. */
function mockApi() {
  const calls: Call[] = []
  const api = createContactsApi(async (input, init) => {
    calls.push({ input, init })
    const url = new URL(input, 'http://contacts.test')
    return (await contactsRoutes(new Request(url, init), url)) ?? new Response(null, { status: 404 })
  }, () => false)
  return { api, calls }
}

async function rejection(promise: Promise<unknown>): Promise<ContactsApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ContactsApiError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

beforeEach(async () => {
  for (const [path, body] of [
    ['/api/contacts/v1/__mock/reset', undefined],
    ['/api/contacts/v1/__mock/ocr', { delayMs: 0 }],
  ] as const) {
    const url = new URL(path, 'http://contacts.test')
    await contactsRoutes(new Request(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined }), url)
  }
})

describe('contacts API client', () => {
  test('reads go to same-origin /api/contacts/v1 (config to /config) without any token, with only the set parameters', async () => {
    const { api, calls } = mockApi()
    await api.config()
    await api.me()
    await api.contacts.list({ q: '高橋', knownBy: 'me', companyId: undefined, limit: 5 })
    expect(calls.map((call) => call.input)).toEqual(['/config', '/api/contacts/v1/me', `/api/contacts/v1/contacts?q=${encodeURIComponent('高橋')}&knownBy=me&limit=5`])
    for (const call of calls) {
      expect(call.init.credentials).toBe('same-origin')
      expect(new Headers(call.init.headers).has('Authorization')).toBe(false)
    }
    expect(exportUrl('project')).toBe('/api/contacts/v1/export.csv?scope=project')
    expect(sheetImageUrl('01J SHEET')).toBe('/api/contacts/v1/sheets/01J%20SHEET/image')
  })

  test('uploads are multipart without a hand-set Content-Type; confirm and edits send JSON with If-Match', async () => {
    const { api, calls } = mockApi()
    const uploaded = await api.cards.upload({ image: new File([new Uint8Array(16)], 'card.png', { type: 'image/png' }), fileName: 'card.png', place: '展示会' })
    expect(uploaded.sheet).toBeNull()
    expect(uploaded.cards).toHaveLength(1)
    const card = uploaded.cards[0]!
    expect(card).toMatchObject({ ocrState: 'done', sheetId: null, bbox: null })
    const sent = calls.at(-1)!.init
    expect(sent.body).toBeInstanceOf(FormData)
    expect((sent.body as FormData).get('place')).toBe('展示会')
    expect(new Headers(sent.headers).has('Content-Type')).toBe(false)

    const contact = await api.cards.confirm(card.id, { contact: { fullName: '森 由紀子' }, companyName: '株式会社ひかり物流' })
    expect(calls.at(-1)?.init.body).toBe(JSON.stringify({ contact: { fullName: '森 由紀子' }, companyName: '株式会社ひかり物流' }))
    const edited = await api.contacts.update(contact.id, contact.version, { title: '課長' })
    expect(new Headers(calls.at(-1)?.init.headers).get('If-Match')).toBe(String(contact.version))
    expect(edited.version).toBe(contact.version + 1)
    const conflict = await rejection(api.contacts.update(contact.id, contact.version, { title: '部長' }))
    expect(conflict).toMatchObject({ status: 409, code: 'version_conflict', transient: false })
    expect(await api.contacts.archive(contact.id, edited.version)).toBeUndefined()
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })

  test('an image holding several cards answers every card and the sheet they were cut from', async () => {
    const { api, calls } = mockApi()
    const { cards, sheet } = await api.cards.upload({ image: new File([new Uint8Array(16)], 'sheet-4.png', { type: 'image/png' }), fileName: 'sheet-4.png' })
    expect((calls.at(-1)!.init.body as FormData).get('image')).toBeInstanceOf(File)
    expect(sheet).toEqual({ id: expect.any(String), detected: 4, imageUrl: sheetImageUrl(sheet!.id) })
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.sheetId).toBe(sheet!.id)
      expect(card.bbox).toHaveLength(4)
    }
    expect(new Set(cards.map((card) => card.extraction?.fields.fullName)).size).toBe(4)
  })

  test('settings are read and replaced as one JSON document; unlink is a bodiless POST answering the card', async () => {
    const { api, calls } = mockApi()
    const stored = await api.settings.get()
    expect(calls.at(-1)).toMatchObject({ input: '/api/contacts/v1/settings', init: { method: 'GET' } })
    const next = { ...stored, mode: 'review' as const, autoCreateThreshold: 0.75, ocrModel: 'gpt-5-mini' }
    expect(await api.settings.put(next)).toEqual(next)
    expect(calls.at(-1)?.init).toMatchObject({ method: 'PUT', body: JSON.stringify(next) })
    expect(new Headers(calls.at(-1)?.init.headers).get('Content-Type')).toBe('application/json')
    expect((await api.me()).ocr).toMatchObject({ model: 'gpt-5-mini', local: false })
    expect(await rejection(api.settings.put({ ...next, autoLinkThreshold: 2 }))).toMatchObject({ status: 400, code: 'invalid_request' })

    await api.settings.put({ ...next, mode: 'auto' })
    const { cards } = await api.cards.upload({ image: new File([new Uint8Array(16)], 'card.png', { type: 'image/png' }), fileName: 'card.png' })
    const card = cards[0]!
    expect(card).toMatchObject({ decision: 'AutoCreated' })
    const undone = await api.cards.unlink(card.id)
    expect(calls.at(-1)).toMatchObject({ input: `/api/contacts/v1/cards/${card.id}/unlink`, init: { method: 'POST', body: undefined } })
    expect(undone).toMatchObject({ id: card.id, contactId: null, decision: 'NeedsReview', decisionReason: 'unlinked' })
  })

  test('errors keep the server code; unanswered calls are transient and retried, answers are final', async () => {
    const { api } = mockApi()
    expect(isContactsError(await rejection(api.contacts.get('missing')), 'not_found')).toBe(true)
    const offline = createContactsApi(() => Promise.reject(new Error('offline')), () => false)
    const unanswered = await rejection(offline.me())
    expect(unanswered).toMatchObject({ status: 0, transient: true })
    expect(retryQuery(0, unanswered)).toBe(true)
    const proxy = createContactsApi(async () => new Response('<html>bad gateway</html>', { status: 502 }), () => false)
    expect(await rejection(proxy.me())).toMatchObject({ status: 502, code: 'unknown', transient: true })
    const store = createContactsApi(async () => Response.json({ error: 'contacts_store_unavailable', message: 'database unreachable' }, { status: 503 }), () => false)
    const outage = await rejection(store.me())
    expect(outage).toMatchObject({ status: 503, code: 'contacts_store_unavailable', transient: false })
    expect(retryQuery(0, outage)).toBe(false)
  })
})

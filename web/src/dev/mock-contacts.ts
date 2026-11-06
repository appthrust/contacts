// Dev-only in-memory implementation of the contacts contract
// (`/api/contacts/v1/*` and `/config`, cmd/server;
// design/platform/builtin-app-contacts/README.md "API contract" and
// auto-registration.md). Fixtures live in ./mock-fixtures; `/openapi.json` is
// the server's committed document.
//
// The caller is 山田 (contacts admin) unless MOCK_ROLE is set to anything but
// Admin. OCR is a fake: an upload is `pending` for MOCK_OCR_DELAY_MS (default
// 2000), then reads the next FAKE_OCR card into an Extraction, resolves it
// against existing contacts and registers it by the Project's Settings exactly
// like `registration.Decide` (AutoCreated / AutoLinked / NeedsReview(reason) /
// Unavailable). MOCK_OCR=off starts without a gateway (every upload
// `unavailable`, D3). An upload whose file name contains `sheet` is split the
// way the gateway splitter would (sheet-split.md): 3–6 cards (a digit 3–6 in
// the name picks the count, else 3 + size mod 4), each an SVG drawing of the
// next SHEET_OCR person with `sheetId`/`bbox`, plus the sheet (the uploaded
// bytes, `GET /sheets/{id}/image`, owner or admin). Without a gateway nothing is
// split (`me.ocr.sheetSplit` false). Controls:
// - `POST /api/contacts/v1/__mock/reset` → {reset: true}, reseeds everything.
// - `POST /api/contacts/v1/__mock/caller {memberId, admin?}` switches the signed-in member.
// - `POST /api/contacts/v1/__mock/ocr {available?, delayMs?, failNext?, model?, local?}` changes the fake gateway.
// Cursors are base64url offsets, opaque to the SPA.
import { readFileSync } from 'node:fs'
import type {
  ApiError,
  AppConfig,
  BusinessCard,
  Company,
  Contact,
  ContactChange,
  ContactSummary,
  DecisionKind,
  DuplicateCandidate,
  Encounter,
  Extraction,
  Me,
  Member,
  OcrFields,
  OcrState,
  RegistrationSource,
  Settings,
  Sheet,
  Tag,
  Visibility,
} from '../api/contacts'
import { emailDomain, IMAGE_TYPES, knownMemberName, MAX_IMAGE_BYTES, MAX_NAME_LENGTH, normalizeName } from '../model/contact'
import { DEFAULT_SETTINGS } from '../model/registration'
import { cardSvg, COMPANIES, CONTACTS, FAKE_OCR, MEMBERS, REVIEW_CARD, SHEET_OCR, TAGS, type CompanyKey, type MemberKey, type TagKey } from './mock-fixtures'

type StoredMember = Member & { subject: string }
type StoredCompany = Omit<Company, 'contactCount'>
type StoredContact = {
  id: string
  companyId: string | null
  fullName: string
  kana: string | null
  title: string | null
  department: string | null
  emails: string[]
  phones: string[]
  address: string | null
  notes: string | null
  visibility: Visibility
  state: 'draft' | 'active' | 'archived'
  createdByMemberId: string
  registeredBy: RegistrationSource
  version: number
  createdAt: string
  updatedAt: string
  tagIds: string[]
}
type StoredCard = {
  id: string
  contactId: string | null
  ownerMemberId: string
  image: Uint8Array<ArrayBuffer>
  imageContentType: string
  ocrState: OcrState
  /** Every reading, oldest first (R2: immutable, a re-run appends); the card shows the last. */
  extractions: Extraction[]
  decision: DecisionKind | null
  decisionReason: string | null
  ocrError: string | null
  exchangedAt: string | null
  place: string | null
  createdAt: string
  /** The sheet this card was cut from, and where on it (`[x1, y1, x2, y2]`); null for a single upload. */
  sheetId: string | null
  bbox: [number, number, number, number] | null
  /** What the fake OCR reads off this card; null takes the next FAKE_OCR turn. */
  reads: OcrFields | null
  /** When a pending card's fake OCR settles, and how. */
  ocr: { readyAt: number; outcome: 'done' | 'failed'; fields: OcrFields } | null
}
/** An upload that held several cards: the original image, kept for its cards (sheet-split.md S3). */
type StoredSheet = { id: string; ownerMemberId: string; image: Uint8Array<ArrayBuffer>; imageContentType: string; detected: number; createdAt: string }
type StoredEncounter = { contactId: string; memberId: string; firstAt: string; lastAt: string; cardCount: number }
type StoredChange = { id: string; contactId: string; actorMemberId: string; at: string; diff: ContactChange['diff']; source: RegistrationSource }
/** Who a write is recorded for: the caller (`member`), or a card's owner when automatic registration acts for them. */
type Author = { actorMemberId: string; source: RegistrationSource }

const BASE = '/api/contacts/v1'
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DIRECTORY_PUBLIC_URL = process.env.CONTACTS_MOCK_DIRECTORY_PUBLIC_URL ?? 'https://directory.pj-mock.appthrust.ink'
const PUBLIC_URL = process.env.CONTACTS_MOCK_PUBLIC_URL ?? 'https://contacts.pj-mock.appthrust.ink'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID-shaped id: 48-bit time and an 80-bit tail derived from `seq`, both Crockford base32. */
function ulid(time: number, seq: number): string {
  let head = ''
  for (let value = time, i = 0; i < 10; i++, value = Math.floor(value / 32)) head = CROCKFORD[value % 32] + head
  let tail = ''
  for (let value = seq * 2654435761, i = 0; i < 16; i++, value = Math.floor(value / 32) + i * 7919) tail = CROCKFORD[value % 32] + tail
  return head + tail
}

const T0 = Date.parse('2026-09-01T09:00:00Z')
const DAY = 86_400_000

/** Fixed member ids, so tests and links can name them. */
export const MOCK_MEMBER_IDS: Record<MemberKey, string> = { yamada: ulid(T0, 1), sato: ulid(T0, 2), suzuki: ulid(T0, 3) }

function seedContacts() {
  const at = (days: number) => new Date(T0 + days * DAY).toISOString()
  let seq = 100
  const members: StoredMember[] = (Object.keys(MEMBERS) as MemberKey[]).map((key) => ({ id: MOCK_MEMBER_IDS[key], ...MEMBERS[key] }))
  const companyIds = {} as Record<CompanyKey, string>
  const companies: StoredCompany[] = (Object.keys(COMPANIES) as CompanyKey[]).map((key) => {
    const id = ulid(T0, seq++)
    companyIds[key] = id
    return { id, ...COMPANIES[key], mergedIntoId: null, createdAt: at(0), updatedAt: at(0) }
  })
  const tagIds = {} as Record<TagKey, string>
  const tags: Tag[] = (Object.keys(TAGS) as TagKey[]).map((key) => {
    const id = ulid(T0, seq++)
    tagIds[key] = id
    return { id, name: TAGS[key].name, ownerMemberId: TAGS[key].owner ? MOCK_MEMBER_IDS[TAGS[key].owner] : null }
  })
  const contacts: StoredContact[] = []
  const cards: StoredCard[] = []
  const changes: StoredChange[] = []
  for (const seed of CONTACTS) {
    const firstDay = Math.min(...seed.cards.map(([, day]) => day))
    const id = ulid(T0 + firstDay * DAY, seq++)
    const createdBy = MOCK_MEMBER_IDS[seed.createdBy]
    const registeredBy: RegistrationSource = seed.auto ? 'auto' : 'member'
    contacts.push({
      id,
      companyId: seed.company ? companyIds[seed.company] : null,
      fullName: seed.fullName,
      kana: seed.kana,
      title: seed.title,
      department: seed.department,
      emails: seed.emails,
      phones: seed.phones,
      address: null,
      notes: null,
      visibility: seed.visibility,
      state: seed.state,
      createdByMemberId: createdBy,
      registeredBy,
      version: 1,
      createdAt: at(firstDay),
      updatedAt: at(firstDay),
      tagIds: seed.tags.map((tag) => tagIds[tag]),
    })
    changes.push({
      id: ulid(T0 + firstDay * DAY, seq++),
      contactId: id,
      actorMemberId: createdBy,
      at: at(firstDay),
      diff: { fullName: { from: null, to: seed.fullName } },
      source: registeredBy,
    })
    for (const [owner, day, place] of seed.cards) {
      const fields: OcrFields = {
        fullName: seed.fullName,
        kana: seed.kana,
        company: seed.company ? COMPANIES[seed.company].name : null,
        department: seed.department,
        title: seed.title,
        emails: seed.emails,
        phones: seed.phones,
        address: null,
        url: null,
        confidence: 0.9,
      }
      cards.push({
        id: ulid(T0 + day * DAY, seq++),
        contactId: id,
        ownerMemberId: MOCK_MEMBER_IDS[owner],
        image: cardSvg({
          company: fields.company ?? '',
          fullName: seed.fullName,
          title: [seed.department, seed.title].filter(Boolean).join(' '),
          email: seed.emails[0] ?? '',
        }),
        imageContentType: 'image/svg+xml',
        ocrState: 'done',
        extractions: [extractionOf(ulid(T0 + day * DAY, seq++), fields, MOCK_MODEL, at(day))],
        // Cards confirmed before automatic registration existed carry no decision.
        decision: seed.auto ? 'AutoCreated' : null,
        decisionReason: null,
        ocrError: null,
        exchangedAt: at(day),
        place,
        createdAt: at(day),
        ocr: null,
        sheetId: null,
        bbox: null,
        reads: null,
      })
    }
  }
  // One read card automatic registration was unsure about: it waits in 山田's review queue.
  cards.push({
    id: ulid(T0 + REVIEW_CARD.day * DAY, seq++),
    contactId: null,
    ownerMemberId: MOCK_MEMBER_IDS[REVIEW_CARD.owner],
    image: cardSvg({
      company: REVIEW_CARD.fields.company ?? '',
      fullName: REVIEW_CARD.fields.fullName ?? '',
      title: [REVIEW_CARD.fields.department, REVIEW_CARD.fields.title].filter(Boolean).join(' '),
      email: REVIEW_CARD.fields.emails[0] ?? '',
    }),
    imageContentType: 'image/svg+xml',
    ocrState: 'done',
    extractions: [extractionOf(ulid(T0 + REVIEW_CARD.day * DAY, seq++), REVIEW_CARD.fields, MOCK_MODEL, at(REVIEW_CARD.day))],
    decision: 'NeedsReview',
    decisionReason: 'low_confidence',
    ocrError: null,
    exchangedAt: at(REVIEW_CARD.day),
    place: REVIEW_CARD.place,
    createdAt: at(REVIEW_CARD.day),
    ocr: null,
    sheetId: null,
    bbox: null,
    reads: null,
  })
  const ocrMode = process.env.MOCK_OCR ?? 'on'
  const delay = Number(process.env.MOCK_OCR_DELAY_MS ?? 2000)
  const state = {
    members,
    companies,
    contacts,
    cards,
    sheets: [] as StoredSheet[],
    encounters: [] as StoredEncounter[],
    changes,
    tags,
    callerId: MOCK_MEMBER_IDS.yamada,
    admin: (process.env.MOCK_ROLE ?? 'Admin') === 'Admin',
    // No saved row: the defaults (R7).
    settings: structuredClone(DEFAULT_SETTINGS),
    ocr: { available: ocrMode !== 'off', delayMs: Number.isFinite(delay) ? delay : 2000, failNext: false, turn: 0, model: MOCK_MODEL, local: true },
    // Just after the last seeded card; real time takes over for every write.
    clock: T0 + 31 * DAY,
    seq,
  }
  for (const contact of contacts) state.encounters.push(...encountersOf(contact.id, cards))
  return state
}

/** The in-cluster model the fake gateway reports (the `llm` capability's gemma3). */
const MOCK_MODEL = 'gemma3:4b'
export const MOCK_MODELS: Me['ocr']['models'] = [
  { id: 'gemma3:4b', ownedBy: 'appthrust', local: true },
  { id: 'gpt-5-mini', ownedBy: 'openai', local: false },
  { id: 'qwen3-vl-4b-instruct-fp8', ownedBy: 'vision', local: true },
]

/** An extraction of `fields`: `overall` is the read's confidence, and every field that was read carries it too. */
function extractionOf(id: string, fields: OcrFields, model: string, createdAt: string, durationMs = 1800): Extraction {
  const fieldConfidence: Record<string, number> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (name !== 'confidence' && (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '')) fieldConfidence[name] = fields.confidence
  }
  return { id, engine: 'gateway-vision', model, fields, fieldConfidence, overall: fields.confidence, durationMs, createdAt }
}

/** C7: a contact's encounters from its cards (met at = `exchangedAt`, else the upload time). */
function encountersOf(contactId: string, cards: readonly StoredCard[]): StoredEncounter[] {
  const byMember = new Map<string, StoredEncounter>()
  for (const card of cards) {
    if (card.contactId !== contactId) continue
    const metAt = card.exchangedAt ?? card.createdAt
    const current = byMember.get(card.ownerMemberId)
    if (!current) byMember.set(card.ownerMemberId, { contactId, memberId: card.ownerMemberId, firstAt: metAt, lastAt: metAt, cardCount: 1 })
    else {
      current.cardCount++
      if (metAt < current.firstAt) current.firstAt = metAt
      if (metAt > current.lastAt) current.lastAt = metAt
    }
  }
  return [...byMember.values()]
}

let state = seedContacts()

/** Strictly increasing wall-clock time, so two writes in one millisecond still order. */
function now(): string {
  state.clock = Math.max(Date.now(), state.clock + 1)
  return new Date(state.clock).toISOString()
}

const nextId = () => ulid(state.clock, state.seq++)

function recomputeEncounters(contactId: string) {
  state.encounters = [...state.encounters.filter((encounter) => encounter.contactId !== contactId), ...encountersOf(contactId, state.cards)]
}

/**
 * Pending cards whose fake OCR time has come settle on read (no timers to
 * clean up): the worker's claim → extract → resolve → decide → register.
 */
function settleOcr() {
  const time = Date.now()
  for (const card of state.cards) {
    const pending = card.ocr
    if (card.ocrState !== 'pending' || !pending || pending.readyAt > time) continue
    card.ocr = null
    if (!state.ocr.available) {
      markUnavailable(card)
    } else if (pending.outcome === 'failed') {
      card.ocrState = 'failed'
      card.ocrError = 'The AI gateway did not answer within 60 seconds'
    } else {
      const at = now()
      const extraction = extractionOf(nextId(), pending.fields, state.settings.ocrModel || state.ocr.model, at, state.ocr.delayMs)
      card.extractions.push(extraction)
      card.ocrState = 'done'
      register(card, extraction, at)
    }
  }
}

/** `MarkUnavailable`: no gateway to read with, so the card asks for manual entry (D3). */
function markUnavailable(card: StoredCard) {
  card.ocrState = 'unavailable'
  card.ocr = null
  card.decision = 'Unavailable'
  card.decisionReason = null
}

/** Queues the fake OCR for a card: what it `reads` (else the next FAKE_OCR read) after `delayMs`. */
function enqueueOcr(card: StoredCard, delayMs = state.ocr.delayMs) {
  card.decision = null
  card.decisionReason = null
  if (!state.ocr.available) {
    markUnavailable(card)
    return
  }
  const fields = card.reads ?? FAKE_OCR[state.ocr.turn++ % FAKE_OCR.length]!
  card.ocrState = 'pending'
  card.ocrError = null
  card.ocr = { readyAt: Date.now() + delayMs, outcome: state.ocr.failNext ? 'failed' : 'done', fields }
  state.ocr.failNext = false
  settleOcr()
}

/** The fake splitter: a file named `*sheet*` holds 3–6 cards (a digit 3–6 in the name picks the count, else 3 + size mod 4); any other file one. */
function detectedCards(fileName: string, size: number): number {
  if (!/sheet/i.test(fileName)) return 1
  const digit = fileName.match(/[3-6]/)?.[0]
  return digit ? Number(digit) : 3 + (size % 4)
}

/** Where the fake splitter "finds" `count` cards: two 91:55 cards per row on a 1600 px wide sheet, top-left first. */
function sheetRegions(count: number): [number, number, number, number][] {
  return Array.from({ length: count }, (_, index) => {
    const x1 = 60 + (index % 2) * 780
    const y1 = 60 + Math.floor(index / 2) * 484
    return [x1, y1, x1 + 700, y1 + 424]
  })
}

type Candidate = { contact: StoredContact; score: number; reason: 'email' | 'name_company' | 'name' }

/** `resolve.Resolve`: existing contacts matching the read, best first (email 1.0, name + same company 0.95, name only 0.6). */
function resolveContacts(fields: OcrFields): Candidate[] {
  const emails = new Set(fields.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))
  const name = normalizeName(fields.fullName ?? '')
  const company = normalizeName(fields.company ?? '')
  const candidates: Candidate[] = []
  for (const contact of state.contacts) {
    if (contact.state === 'archived') continue
    if (contact.emails.some((email) => emails.has(email.toLowerCase()))) {
      candidates.push({ contact, score: 1, reason: 'email' })
    } else if (name && normalizeName(contact.fullName) === name) {
      const sameCompany = company !== '' && normalizeName(resolveCompany(contact.companyId)?.name ?? '') === company
      candidates.push({ contact, score: sameCompany ? 0.95 : 0.6, reason: sameCompany ? 'name_company' : 'name' })
    }
  }
  return candidates.sort((a, b) => b.score - a.score)
}

/** `registration.fieldPresent`. */
function fieldPresent(fields: OcrFields, name: string): boolean {
  if (name === 'confidence') return fields.confidence > 0
  const value = (fields as Record<string, unknown>)[name]
  if (Array.isArray(value)) return value.some((entry) => typeof entry === 'string' && entry.trim() !== '')
  return typeof value === 'string' && value.trim() !== ''
}

/** `registration.Decide`, branch for branch: mode, required fields, strong link, ambiguous candidate, creation confidence. */
function decide(settings: Settings, extraction: Extraction, candidates: readonly Candidate[]): { kind: DecisionKind; reason: string | null; contact?: StoredContact } {
  if (settings.mode === 'off') return { kind: 'Unavailable', reason: null }
  if (settings.mode === 'review') return { kind: 'NeedsReview', reason: 'policy' }
  for (const name of settings.requiredFields) {
    if (!fieldPresent(extraction.fields, name)) return { kind: 'NeedsReview', reason: `missing_field:${name}` }
  }
  const best = candidates[0]
  if (best && best.score >= settings.autoLinkThreshold && (best.reason === 'email' || best.reason === 'name_company')) {
    return { kind: 'AutoLinked', reason: null, contact: best.contact }
  }
  if (candidates.some((candidate) => candidate.score >= 0.6)) return { kind: 'NeedsReview', reason: 'ambiguous_match' }
  if (extraction.overall >= settings.autoCreateThreshold) return { kind: 'AutoCreated', reason: null }
  return { kind: 'NeedsReview', reason: 'low_confidence' }
}

/**
 * `registration.Registrar.Register` (R1): AutoCreated / AutoLinked go through
 * the same confirm path a member uses, recorded for the card's owner with
 * source `auto`; anything else only records the decision on the card.
 */
function register(card: StoredCard, extraction: Extraction, time: string) {
  const decision = decide(state.settings, extraction, resolveContacts(extraction.fields))
  card.decision = decision.kind
  card.decisionReason = decision.reason
  const author: Author = { actorMemberId: card.ownerMemberId, source: 'auto' }
  if (decision.kind === 'AutoLinked' && decision.contact) {
    linkCard(card, decision.contact, time, author)
    recordChange(decision.contact, { cards: { from: null, to: card.id } }, time, author)
  } else if (decision.kind === 'AutoCreated') {
    const { fields } = extraction
    const text = (value: string | null) => (value?.trim() ? value.trim() : null)
    const contact = createContact(
      {
        fullName: fields.fullName!.trim(),
        kana: text(fields.kana),
        title: text(fields.title),
        department: text(fields.department),
        emails: fields.emails,
        phones: fields.phones,
        address: text(fields.address),
        companyId: text(fields.company) ? companyByName(fields.company!).id : null,
        visibility: state.settings.privateDefault ? 'private' : 'shared',
      },
      time,
      author
    )
    linkCard(card, contact, time, author)
  }
}

function member(memberId: string): Member {
  const stored = state.members.find((candidate) => candidate.id === memberId)
  // A dangling member id renders as "unknown member" (C6).
  if (!stored) return { id: memberId, displayName: '', email: '', directoryPersonId: null }
  return { id: stored.id, displayName: stored.displayName, email: stored.email, directoryPersonId: stored.directoryPersonId }
}

/** Follows `mergedIntoId` to the company that answers for this id (C3). */
function resolveCompany(companyId: string | null): StoredCompany | undefined {
  let company = companyId ? state.companies.find((candidate) => candidate.id === companyId) : undefined
  for (let hops = 0; company?.mergedIntoId && hops < 10; hops++) {
    const target: string = company.mergedIntoId
    company = state.companies.find((candidate) => candidate.id === target)
  }
  return company
}

/** C5: shared contacts for everyone; private ones for their creator, their card owners and admins. */
function visible(contact: StoredContact): boolean {
  if (contact.visibility === 'shared' || state.admin || contact.createdByMemberId === state.callerId) return true
  return state.cards.some((card) => card.contactId === contact.id && card.ownerMemberId === state.callerId)
}

const visibleTags = () => state.tags.filter((tag) => tag.ownerMemberId === null || tag.ownerMemberId === state.callerId)

function summary(contact: StoredContact): ContactSummary {
  const company = resolveCompany(contact.companyId)
  const encounters = state.encounters.filter((encounter) => encounter.contactId === contact.id)
  const tags = visibleTags()
  return {
    id: contact.id,
    fullName: contact.fullName,
    kana: contact.kana,
    title: contact.title,
    department: contact.department,
    company: company ? { id: company.id, name: company.name } : null,
    primaryEmail: contact.emails[0] ?? null,
    visibility: contact.visibility,
    state: contact.state,
    tags: contact.tagIds.flatMap((tagId) => {
      const tag = tags.find((candidate) => candidate.id === tagId)
      return tag ? [{ id: tag.id, name: tag.name }] : []
    }),
    encounterCount: encounters.length,
    knownByMe: encounters.some((encounter) => encounter.memberId === state.callerId),
    lastMetAt: encounters.reduce<string | null>((latest, encounter) => (latest === null || encounter.lastAt > latest ? encounter.lastAt : latest), null),
    updatedAt: contact.updatedAt,
  }
}

function cardView(card: StoredCard): BusinessCard {
  return {
    id: card.id,
    contactId: card.contactId,
    owner: member(card.ownerMemberId),
    imageUrl: `${BASE}/cards/${card.id}/image`,
    ocrState: card.ocrState,
    extraction: card.extractions.at(-1) ?? null,
    decision: card.decision,
    decisionReason: card.decisionReason,
    ocrError: card.ocrError,
    exchangedAt: card.exchangedAt,
    place: card.place,
    createdAt: card.createdAt,
    sheetId: card.sheetId,
    bbox: card.bbox,
  }
}

function detail(contact: StoredContact): Contact {
  return {
    ...summary(contact),
    emails: contact.emails,
    phones: contact.phones,
    address: contact.address,
    notes: contact.notes,
    createdBy: member(contact.createdByMemberId),
    registeredBy: contact.registeredBy,
    version: contact.version,
    createdAt: contact.createdAt,
    cards: state.cards
      .filter((card) => card.contactId === contact.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cardView),
    encounters: state.encounters
      .filter((encounter) => encounter.contactId === contact.id)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .map(
        (encounter): Encounter => ({ member: member(encounter.memberId), firstAt: encounter.firstAt, lastAt: encounter.lastAt, cardCount: encounter.cardCount })
      ),
    changes: state.changes
      .filter((change) => change.contactId === contact.id)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((change): ContactChange => ({ id: change.id, actor: member(change.actorMemberId), at: change.at, diff: change.diff, source: change.source })),
  }
}

function companyView(company: StoredCompany): Company {
  const contactCount = state.contacts.filter((contact) => contact.state !== 'archived' && visible(contact) && resolveCompany(contact.companyId)?.id === company.id).length
  return { ...company, contactCount }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, error: string, message: string) => json({ error, message } satisfies ApiError, status)
const notFound = () => fail(404, 'not_found', 'The requested resource was not found')
const forbidden = () => fail(403, 'forbidden', 'You do not have permission for this action')
const invalid = (message: string) => fail(400, 'invalid_request', message)
const noContent = () => new Response(null, { status: 204 })

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await request.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `limit` and `cursor` → the page window, or a 400. */
function pageWindow(url: URL): { offset: number; limit: number } | Response {
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid(`limit must be between 1 and ${MAX_LIMIT}`)
  const cursor = url.searchParams.get('cursor')
  if (!cursor) return { offset: 0, limit }
  const offset = /^[A-Za-z0-9_-]+$/.test(cursor) ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : NaN
  if (!Number.isInteger(offset) || offset < 1) return invalid('cursor is not valid')
  return { offset, limit }
}

function page<T, R>(items: readonly T[], range: { offset: number; limit: number }, view: (item: T) => R) {
  const end = range.offset + range.limit
  return json({ items: items.slice(range.offset, end).map(view), nextCursor: items.length > end ? Buffer.from(String(end), 'utf8').toString('base64url') : null })
}

/** `If-Match` against the stored version: undefined when it matches, else the 400 / 409 to answer. */
function versionGuard(request: Request, contact: StoredContact): Response | undefined {
  const header = request.headers.get('If-Match')?.replace(/^W\//, '').replace(/"/g, '').trim()
  if (!header || !/^\d+$/.test(header)) return invalid('If-Match must carry the contact version')
  if (Number(header) !== contact.version) return fail(409, 'version_conflict', `The contact is at version ${contact.version}`)
  return undefined
}

/** A write by the signed-in member. */
const callerAuthor = (): Author => ({ actorMemberId: state.callerId, source: 'member' })

/** C2: one change per mutation, and the version moves on. */
function recordChange(contact: StoredContact, diff: ContactChange['diff'], time = now(), author = callerAuthor()) {
  contact.version++
  contact.updatedAt = time
  state.changes.push({ id: nextId(), contactId: contact.id, at: time, diff, ...author })
}

function companyByName(name: string): StoredCompany {
  const key = normalizeName(name)
  const existing = state.companies.find((company) => !company.mergedIntoId && normalizeName(company.name) === key)
  if (existing) return existing
  const time = now()
  const created: StoredCompany = { id: nextId(), name: name.trim(), domain: null, address: null, url: null, mergedIntoId: null, createdAt: time, updatedAt: time }
  state.companies.push(created)
  return created
}

type ParsedInput = Partial<Omit<StoredContact, 'id' | 'state' | 'createdByMemberId' | 'version' | 'createdAt' | 'updatedAt' | 'tagIds'>>

const TEXT_FIELDS = ['kana', 'title', 'department', 'address', 'notes'] as const

/** Validates a `ContactInput`; `create` requires `fullName`. Company names are resolved (or created) here. */
function parseInput(input: Record<string, unknown>, create: boolean): ParsedInput | Response {
  const parsed: ParsedInput = {}
  if (input.fullName !== undefined || create) {
    if (typeof input.fullName !== 'string' || !input.fullName.trim()) return invalid('fullName is required')
    if (Array.from(input.fullName.trim()).length > MAX_NAME_LENGTH) return invalid(`fullName must be at most ${MAX_NAME_LENGTH} characters`)
    parsed.fullName = input.fullName.trim()
  }
  for (const field of TEXT_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value !== null && typeof value !== 'string') return invalid(`${field} must be a string or null`)
    parsed[field] = typeof value === 'string' && value.trim() ? value.trim() : null
  }
  for (const field of ['emails', 'phones'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return invalid(`${field} must be a list of strings`)
    parsed[field] = [...new Set((value as string[]).map((entry) => entry.trim()).filter(Boolean))]
  }
  if (input.visibility !== undefined) {
    if (input.visibility !== 'shared' && input.visibility !== 'private') return invalid('visibility must be shared or private')
    parsed.visibility = input.visibility
  }
  if (typeof input.companyId === 'string') {
    const company = resolveCompany(input.companyId)
    if (!company) return invalid('companyId does not name a company')
    parsed.companyId = company.id
  } else if (input.companyId === null) {
    parsed.companyId = null
  } else if (typeof input.companyName === 'string' && input.companyName.trim()) {
    parsed.companyId = companyByName(input.companyName).id
  } else if (input.companyName === null && !create) {
    parsed.companyId = null
  }
  return parsed
}

function createContact(parsed: ParsedInput, time: string, author = callerAuthor()): StoredContact {
  const contact: StoredContact = {
    id: nextId(),
    companyId: parsed.companyId ?? null,
    fullName: parsed.fullName!,
    kana: parsed.kana ?? null,
    title: parsed.title ?? null,
    department: parsed.department ?? null,
    emails: parsed.emails ?? [],
    phones: parsed.phones ?? [],
    address: parsed.address ?? null,
    notes: parsed.notes ?? null,
    visibility: parsed.visibility ?? 'shared',
    state: 'active',
    createdByMemberId: author.actorMemberId,
    registeredBy: author.source,
    version: 1,
    createdAt: time,
    updatedAt: time,
    tagIds: [],
  }
  state.contacts.push(contact)
  const diff: ContactChange['diff'] = {}
  for (const [field, value] of Object.entries(parsed)) {
    if (value !== null && !(Array.isArray(value) && value.length === 0)) diff[field] = { from: null, to: value }
  }
  state.changes.push({ id: nextId(), contactId: contact.id, at: time, diff, ...author })
  return contact
}

/** Applies a parsed PATCH; the diff of what actually changed. */
function applyInput(contact: StoredContact, parsed: ParsedInput): ContactChange['diff'] {
  const diff: ContactChange['diff'] = {}
  for (const [field, value] of Object.entries(parsed) as [keyof ParsedInput, unknown][]) {
    const before = contact[field]
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    diff[field] = { from: before, to: value }
    Object.assign(contact, { [field]: value })
  }
  return diff
}

/** C4: pairs sharing a normalised name and either an email domain or a company; never merged automatically. */
function duplicates(limit: number): DuplicateCandidate[] {
  const live = state.contacts.filter((contact) => contact.state !== 'archived' && visible(contact))
  const pairs: DuplicateCandidate[] = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!
      const b = live[j]!
      if (normalizeName(a.fullName) !== normalizeName(b.fullName)) continue
      const domains = new Set(a.emails.map(emailDomain).filter(Boolean))
      const reason = b.emails.some((email) => domains.has(emailDomain(email)))
        ? 'name_domain'
        : a.companyId && resolveCompany(a.companyId)?.id === resolveCompany(b.companyId)?.id
          ? 'name_company'
          : undefined
      if (reason) pairs.push({ contacts: [summary(a), summary(b)], reason })
    }
  }
  return pairs.slice(0, limit)
}

function contactMatches(contact: StoredContact, url: URL): boolean {
  const q = url.searchParams.get('q')?.trim()
  if (q) {
    const needle = normalizeName(q)
    const company = resolveCompany(contact.companyId)
    const haystack = [contact.fullName, contact.kana ?? '', company?.name ?? '', ...contact.emails].map(normalizeName)
    if (!haystack.some((value) => value.includes(needle))) return false
  }
  const companyId = url.searchParams.get('companyId')
  if (companyId && resolveCompany(contact.companyId)?.id !== resolveCompany(companyId)?.id) return false
  const tag = url.searchParams.get('tag')
  if (tag && !contact.tagIds.includes(tag)) return false
  const knownBy = url.searchParams.get('knownBy')
  if (knownBy) {
    const memberId = knownBy === 'me' ? state.callerId : knownBy
    if (!state.encounters.some((encounter) => encounter.contactId === contact.id && encounter.memberId === memberId)) return false
  }
  const wanted = url.searchParams.get('state')
  if (wanted ? contact.state !== wanted : contact.state === 'archived') return false
  const visibility = url.searchParams.get('visibility')
  if (visibility && contact.visibility !== visibility) return false
  const updatedAfter = url.searchParams.get('updatedAfter')
  if (updatedAfter && !(Date.parse(contact.updatedAt) > Date.parse(updatedAfter))) return false
  return true
}

const newestFirst = (a: StoredContact, b: StoredContact) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)

const CSV_COLUMNS = ['fullName', 'kana', 'company', 'department', 'title', 'emails', 'phones', 'address', 'visibility', 'firstMetAt', 'lastMetAt', 'metBy'] as const

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

function exportCsv(contacts: readonly StoredContact[]): string {
  const rows = contacts.map((contact) => {
    const encounters = state.encounters.filter((encounter) => encounter.contactId === contact.id)
    const firstMetAt = encounters.reduce<string>((first, encounter) => (!first || encounter.firstAt < first ? encounter.firstAt : first), '')
    const lastMetAt = encounters.reduce<string>((last, encounter) => (encounter.lastAt > last ? encounter.lastAt : last), '')
    return [
      contact.fullName,
      contact.kana ?? '',
      resolveCompany(contact.companyId)?.name ?? '',
      contact.department ?? '',
      contact.title ?? '',
      contact.emails.join(';'),
      contact.phones.join(';'),
      contact.address ?? '',
      contact.visibility,
      firstMetAt,
      lastMetAt,
      // C6: a member without a Directory person is exported as an unknown member.
      encounters.map((encounter) => knownMemberName(member(encounter.memberId)) ?? 'unknown member').join(';'),
    ]
      .map(csvCell)
      .join(',')
  })
  return `\uFEFF${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`
}

/**
 * The server's committed OpenAPI document (`cmd/server/internal/api/openapi.json`,
 * embedded and served byte for byte by the Go server). Read per request so the
 * mock never drifts from it.
 */
export const OPENAPI_FILE = new URL('../../../cmd/server/internal/api/openapi.json', import.meta.url)

function findContact(rawId: string): StoredContact | undefined {
  const contact = state.contacts.find((candidate) => candidate.id === decodeURIComponent(rawId))
  return contact && visible(contact) ? contact : undefined
}

/** Owner, admin, or anyone who can see the contact the card is on. */
function findCard(rawId: string): StoredCard | undefined {
  const card = state.cards.find((candidate) => candidate.id === decodeURIComponent(rawId))
  if (!card) return undefined
  if (card.ownerMemberId === state.callerId || state.admin) return card
  const contact = card.contactId ? state.contacts.find((candidate) => candidate.id === card.contactId) : undefined
  return contact && visible(contact) ? card : undefined
}

/** Links a card to a contact (C7: encounters recomputed, the contact versioned). */
function linkCard(card: StoredCard, contact: StoredContact, time: string, author = callerAuthor()) {
  const previous = card.contactId ? state.contacts.find((candidate) => candidate.id === card.contactId) : undefined
  card.contactId = contact.id
  if (previous && previous !== contact) {
    recomputeEncounters(previous.id)
    recordChange(previous, { cards: { from: card.id, to: null } }, time, author)
  }
  recomputeEncounters(contact.id)
}

/**
 * R3 (`Tx.UnlinkCard`): the card leaves its contact and waits for review; a
 * contact automatic registration created that now has no card and no change
 * by a member is archived in the same change.
 */
function unlinkCard(card: StoredCard) {
  const contact = card.contactId ? state.contacts.find((candidate) => candidate.id === card.contactId) : undefined
  card.contactId = null
  card.decision = 'NeedsReview'
  card.decisionReason = 'unlinked'
  if (!contact) return
  recomputeEncounters(contact.id)
  const untouched =
    !state.cards.some((candidate) => candidate.contactId === contact.id) &&
    !state.changes.some((change) => change.contactId === contact.id && change.source === 'member')
  const diff: ContactChange['diff'] = { cards: { from: card.id, to: null } }
  if (contact.registeredBy === 'auto' && untouched && contact.state !== 'archived') {
    diff.state = { from: contact.state, to: 'archived' }
    contact.state = 'archived'
  }
  recordChange(contact, diff)
}

const SETTINGS_MODES: readonly string[] = ['auto', 'review', 'off']
/** `registration.Validate`'s field names. */
const SETTINGS_FIELDS: readonly string[] = ['fullName', 'kana', 'company', 'department', 'title', 'emails', 'phones', 'address', 'url', 'confidence']

/** A full `Settings` document validated like `registration.Validate`, or the 400 to answer. */
function parseSettings(input: Record<string, unknown> | undefined): Settings | Response {
  if (!input) return invalid('A JSON object is required')
  const { mode, autoCreateThreshold, autoLinkThreshold, requiredFields, privateDefault, extractorPreference, ocrModel = '' } = input
  if (typeof mode !== 'string' || !SETTINGS_MODES.includes(mode)) return invalid('mode must be auto, review, or off')
  for (const [name, value] of [
    ['autoCreateThreshold', autoCreateThreshold],
    ['autoLinkThreshold', autoLinkThreshold],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return invalid(`${name} must be between 0 and 1`)
  }
  const names = requiredFields ?? []
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return invalid('requiredFields must be a list of field names')
  const unknown = (names as string[]).find((name) => !SETTINGS_FIELDS.includes(name))
  if (unknown !== undefined) return invalid(`unknown required field: ${unknown}`)
  if (privateDefault !== undefined && typeof privateDefault !== 'boolean') return invalid('privateDefault must be a boolean')
  const preference = extractorPreference ?? []
  if (!Array.isArray(preference) || preference.some((name) => typeof name !== 'string' || !name.trim())) {
    return invalid('extractorPreference entries must not be empty')
  }
  if (typeof ocrModel !== 'string') return invalid('ocrModel must be a string')
  if ([...ocrModel].length > 128) return invalid('ocrModel must be at most 128 characters')
  if (/[\p{White_Space}\p{Cc}]/u.test(ocrModel)) return invalid('ocrModel must not contain whitespace or control characters')
  return {
    mode: mode as Settings['mode'],
    autoCreateThreshold: autoCreateThreshold as number,
    autoLinkThreshold: autoLinkThreshold as number,
    requiredFields: [...new Set(names as string[])],
    privateDefault: privateDefault === true,
    extractorPreference: preference as string[],
    ocrModel,
  }
}

const config = (): AppConfig => ({ projectId: 'pj-mock', publicUrl: PUBLIC_URL, directoryUrl: DIRECTORY_PUBLIC_URL })

/** Handles `/config` and `/api/contacts/v1/*`; undefined for any other path. */
export async function contactsRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (request.method === 'GET' && url.pathname === '/config') return json(config())
  if (!url.pathname.startsWith(`${BASE}/`)) return undefined
  const route = `${request.method} ${url.pathname.slice(BASE.length)}`
  let match: RegExpMatchArray | null

  if (route === 'POST /__mock/reset') {
    state = seedContacts()
    return json({ reset: true })
  }
  if (route === 'POST /__mock/caller') {
    const input = await body(request)
    if (typeof input?.memberId !== 'string' || !state.members.some((candidate) => candidate.id === input.memberId)) return invalid('memberId must name a seeded member')
    state.callerId = input.memberId
    state.admin = input.admin === true
    return json({ callerId: state.callerId, admin: state.admin })
  }
  if (route === 'POST /__mock/ocr') {
    const input = (await body(request)) ?? {}
    if (typeof input.available === 'boolean') state.ocr.available = input.available
    if (typeof input.delayMs === 'number' && input.delayMs >= 0) state.ocr.delayMs = input.delayMs
    if (typeof input.failNext === 'boolean') state.ocr.failNext = input.failNext
    if (typeof input.model === 'string') state.ocr.model = input.model
    if (typeof input.local === 'boolean') state.ocr.local = input.local
    return json({ available: state.ocr.available, delayMs: state.ocr.delayMs, failNext: state.ocr.failNext, model: state.ocr.model, local: state.ocr.local })
  }

  settleOcr()
  const caller = state.callerId
  const admin = state.admin

  if (route === 'GET /openapi.json') {
    return new Response(readFileSync(OPENAPI_FILE), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }

  if (route === 'GET /me') {
    const me: Me = {
      member: member(caller),
      roles: { contactsAdmin: admin },
      directory: { linked: member(caller).directoryPersonId !== null, publicUrl: DIRECTORY_PUBLIC_URL || null },
      ocr: {
        available: state.ocr.available,
        extractor: state.ocr.available ? 'gateway-vision' : '',
        model: state.settings.ocrModel || state.ocr.model,
        releaseModel: state.ocr.model,
        models: state.ocr.available ? MOCK_MODELS : [],
        local: state.ocr.available && (state.settings.ocrModel ? (MOCK_MODELS.find((model) => model.id === state.settings.ocrModel)?.local ?? false) : state.ocr.local),
        sheetSplit: state.ocr.available,
      },
      counts: {
        myCards: state.cards.filter((card) => card.ownerMemberId === caller).length,
        myContacts: state.contacts.filter(
          (contact) => contact.state !== 'archived' && state.encounters.some((encounter) => encounter.contactId === contact.id && encounter.memberId === caller)
        ).length,
        contacts: state.contacts.filter((contact) => contact.state !== 'archived' && visible(contact)).length,
        companies: state.companies.filter((company) => !company.mergedIntoId).length,
      },
    }
    return json(me)
  }

  if (route === 'GET /me/contacts') {
    const range = pageWindow(url)
    if (range instanceof Response) return range
    const lastMet = (contact: StoredContact) => state.encounters.find((encounter) => encounter.contactId === contact.id && encounter.memberId === caller)?.lastAt ?? ''
    const mine = state.contacts
      .filter((contact) => contact.state !== 'archived' && visible(contact) && lastMet(contact))
      .sort((a, b) => lastMet(b).localeCompare(lastMet(a)) || b.id.localeCompare(a.id))
    return page(mine, range, summary)
  }

  // Cards.
  if (route === 'GET /cards') {
    const range = pageWindow(url)
    if (range instanceof Response) return range
    const owner = url.searchParams.get('owner') ?? 'me'
    if (owner !== 'me' && owner !== 'all') return invalid('owner must be me or all')
    if (owner === 'all' && !admin) return forbidden()
    const cards = state.cards.filter((card) => owner === 'all' || card.ownerMemberId === caller).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return page(cards, range, cardView)
  }
  if (route === 'POST /cards') {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return invalid('multipart/form-data with an image is required')
    }
    const image = form.get('image')
    if (!(image instanceof Blob)) return invalid('image is required')
    if (image.size > MAX_IMAGE_BYTES) return fail(413, 'image_too_large', 'image must be at most 5 MiB')
    const contentType = image.type.split(';')[0]!.trim().toLowerCase()
    if (!(IMAGE_TYPES as readonly string[]).includes(contentType)) return fail(415, 'unsupported_image', 'image must be JPEG, PNG, WebP or HEIC')
    const exchangedAt = form.get('exchangedAt')
    if (typeof exchangedAt === 'string' && exchangedAt && Number.isNaN(Date.parse(exchangedAt))) return invalid('exchangedAt must be an RFC 3339 time')
    const place = form.get('place')
    const contactId = form.get('contactId')
    const contact = typeof contactId === 'string' && contactId ? findContact(contactId) : undefined
    if (typeof contactId === 'string' && contactId && (!contact || contact.state === 'archived')) return invalid('contactId does not name a contact')
    // The fake splitter runs only with a gateway (S1); a multi-card image cannot be filed under one contact.
    const detected = state.ocr.available ? detectedCards(image instanceof File ? image.name : '', image.size) : 1
    if (detected >= 2 && contact) return fail(400, 'sheet_with_contact', 'contactId cannot be used when the image holds more than one card')
    const bytes = new Uint8Array(await image.arrayBuffer())
    const time = now()
    const stored = (cardImage: Uint8Array<ArrayBuffer>, cardType: string, sheet: { id: string; bbox: [number, number, number, number]; reads: OcrFields } | null): StoredCard => ({
      id: nextId(),
      contactId: null,
      ownerMemberId: caller,
      image: cardImage,
      imageContentType: cardType,
      ocrState: 'unavailable',
      extractions: [],
      decision: null,
      decisionReason: null,
      ocrError: null,
      exchangedAt: typeof exchangedAt === 'string' && exchangedAt ? new Date(exchangedAt).toISOString() : null,
      place: typeof place === 'string' && place.trim() ? place.trim() : null,
      createdAt: time,
      sheetId: sheet?.id ?? null,
      bbox: sheet?.bbox ?? null,
      reads: sheet?.reads ?? null,
      ocr: null,
    })
    if (detected >= 2) {
      const sheet: StoredSheet = { id: nextId(), ownerMemberId: caller, image: bytes, imageContentType: contentType, detected, createdAt: time }
      state.sheets.push(sheet)
      const cards = sheetRegions(detected).map((bbox, index) => {
        const reads = SHEET_OCR[index % SHEET_OCR.length]!
        const crop = cardSvg({ company: reads.company ?? '', fullName: reads.fullName ?? '', title: [reads.department, reads.title].filter(Boolean).join(' '), email: reads.emails[0] ?? '' })
        return stored(crop, 'image/svg+xml', { id: sheet.id, bbox, reads })
      })
      state.cards.push(...cards)
      // S4: every card is queued after the upload; they settle one after another.
      cards.forEach((card, index) => enqueueOcr(card, state.ocr.delayMs * (1 + index / 2)))
      const view: Sheet = { id: sheet.id, detected, imageUrl: `${BASE}/sheets/${sheet.id}/image` }
      return json({ cards: cards.map(cardView), sheet: view }, 202)
    }
    const card = stored(bytes, contentType, null)
    state.cards.push(card)
    if (contact) {
      linkCard(card, contact, time)
      recordChange(contact, { cards: { from: null, to: card.id } }, time)
    } else {
      enqueueOcr(card)
    }
    return json({ cards: [cardView(card)], sheet: null }, 202)
  }
  if ((match = route.match(/^(GET|DELETE) \/cards\/([^/]+)$/))) {
    const [, method, id] = match
    const card = findCard(id!)
    if (!card) return notFound()
    if (method === 'GET') return json(cardView(card))
    if (card.ownerMemberId !== caller && !admin) return forbidden()
    state.cards = state.cards.filter((candidate) => candidate !== card)
    // S3: a sheet goes with its last card.
    if (card.sheetId && !state.cards.some((candidate) => candidate.sheetId === card.sheetId)) state.sheets = state.sheets.filter((sheet) => sheet.id !== card.sheetId)
    const contact = card.contactId ? state.contacts.find((candidate) => candidate.id === card.contactId) : undefined
    if (contact) {
      recomputeEncounters(contact.id)
      recordChange(contact, { cards: { from: card.id, to: null } })
    }
    return noContent()
  }
  if ((match = route.match(/^GET \/cards\/([^/]+)\/image$/))) {
    const card = findCard(match[1]!)
    if (!card) return notFound()
    return new Response(card.image, { headers: { 'Content-Type': card.imageContentType, 'Cache-Control': 'private, max-age=3600' } })
  }
  if ((match = route.match(/^GET \/sheets\/([^/]+)\/image$/))) {
    const id = decodeURIComponent(match[1]!)
    // Owner or admin; anyone else gets the same 404 as a missing sheet.
    const sheet = state.sheets.find((candidate) => candidate.id === id && (candidate.ownerMemberId === caller || admin))
    if (!sheet) return notFound()
    return new Response(sheet.image, { headers: { 'Content-Type': sheet.imageContentType, 'Cache-Control': 'private, max-age=3600' } })
  }
  if ((match = route.match(/^POST \/cards\/([^/]+)\/ocr$/))) {
    const card = findCard(match[1]!)
    if (!card) return notFound()
    if (card.ownerMemberId !== caller && !admin) return forbidden()
    if (card.ocrState !== 'failed' && card.ocrState !== 'unavailable') return fail(409, 'conflict', 'OCR can only be re-run for failed or unavailable cards')
    if (!state.ocr.available) return fail(409, 'ocr_unavailable', 'No AI gateway is configured for this Project')
    enqueueOcr(card)
    return json(cardView(card), 202)
  }
  if ((match = route.match(/^POST \/cards\/([^/]+)\/unlink$/))) {
    const card = findCard(match[1]!)
    if (!card) return notFound()
    if (card.ownerMemberId !== caller && !admin) return forbidden()
    unlinkCard(card)
    return json(cardView(card))
  }
  if ((match = route.match(/^POST \/cards\/([^/]+)\/confirm$/))) {
    const card = findCard(match[1]!)
    if (!card) return notFound()
    if (card.ownerMemberId !== caller && !admin) return forbidden()
    const input = await body(request)
    if (!input) return invalid('A JSON object is required')
    const time = now()
    if (typeof input.contactId === 'string') {
      const contact = findContact(input.contactId)
      if (!contact || contact.state === 'archived') return invalid('contactId does not name a contact')
      linkCard(card, contact, time)
      recordChange(contact, { cards: { from: null, to: card.id } }, time)
      return json(detail(contact))
    }
    if (!input.contact || typeof input.contact !== 'object' || Array.isArray(input.contact)) return invalid('contactId or contact is required')
    if (input.companyName !== undefined && input.companyName !== null && typeof input.companyName !== 'string') return invalid('companyName must be a string or null')
    const parsed = parseInput({ ...(input.contact as Record<string, unknown>), ...(typeof input.companyName === 'string' ? { companyName: input.companyName } : {}) }, true)
    if (parsed instanceof Response) return parsed
    const contact = createContact(parsed, time)
    linkCard(card, contact, time)
    return json(detail(contact))
  }

  // Settings (R7): every member reads, admins write.
  if (route === 'GET /settings') return json(state.settings)
  if (route === 'PUT /settings') {
    if (!admin) return forbidden()
    const parsed = parseSettings(await body(request))
    if (parsed instanceof Response) return parsed
    state.settings = parsed
    return json(state.settings)
  }

  // Contacts.
  if (route === 'GET /contacts') {
    const range = pageWindow(url)
    if (range instanceof Response) return range
    return page(state.contacts.filter((contact) => visible(contact) && contactMatches(contact, url)).sort(newestFirst), range, summary)
  }
  if (route === 'POST /contacts') {
    const input = await body(request)
    if (!input) return invalid('A JSON object is required')
    const parsed = parseInput(input, true)
    if (parsed instanceof Response) return parsed
    return json(detail(createContact(parsed, now())), 201)
  }
  if (route === 'GET /contacts/duplicates') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid(`limit must be between 1 and ${MAX_LIMIT}`)
    return json({ items: duplicates(limit) })
  }
  if ((match = route.match(/^(GET|PATCH|DELETE) \/contacts\/([^/]+)$/))) {
    const [, method, id] = match
    const contact = findContact(id!)
    if (!contact) return notFound()
    if (method === 'GET') return json(detail(contact))
    if (method === 'DELETE') {
      if (contact.createdByMemberId !== caller && !admin) return forbidden()
      const guard = versionGuard(request, contact)
      if (guard) return guard
      if (contact.state !== 'archived') {
        recordChange(contact, { state: { from: contact.state, to: 'archived' } })
        contact.state = 'archived'
      }
      return noContent()
    }
    const guard = versionGuard(request, contact)
    if (guard) return guard
    const input = await body(request)
    if (!input) return invalid('A JSON object is required')
    const parsed = parseInput(input, false)
    if (parsed instanceof Response) return parsed
    const diff = applyInput(contact, parsed)
    if (Object.keys(diff).length > 0) {
      // An edit by a member settles a draft (D6).
      if (contact.state === 'draft') {
        diff.state = { from: 'draft', to: 'active' }
        contact.state = 'active'
      }
      recordChange(contact, diff)
    }
    return json(detail(contact))
  }
  if ((match = route.match(/^POST \/contacts\/([^/]+)\/merge$/))) {
    const target = findContact(match[1]!)
    if (!target) return notFound()
    const input = await body(request)
    if (typeof input?.sourceId !== 'string') return invalid('sourceId is required')
    const source = findContact(input.sourceId)
    if (!source) return notFound()
    if (source === target) return invalid('A contact cannot be merged into itself')
    if (source.state === 'archived' || target.state === 'archived') return invalid('Archived contacts cannot be merged')
    const ownsAll = state.cards.filter((card) => card.contactId === source.id || card.contactId === target.id).every((card) => card.ownerMemberId === caller)
    if (!admin && !ownsAll) return forbidden()
    const guard = versionGuard(request, target)
    if (guard) return guard
    const time = now()
    const moved = state.cards.filter((card) => card.contactId === source.id)
    for (const card of moved) card.contactId = target.id
    const tagsBefore = [...target.tagIds]
    target.tagIds = [...new Set([...target.tagIds, ...source.tagIds])]
    source.tagIds = []
    recomputeEncounters(source.id)
    recomputeEncounters(target.id)
    recordChange(source, { state: { from: source.state, to: 'archived' }, mergedInto: { from: null, to: target.id } }, time)
    source.state = 'archived'
    const diff: ContactChange['diff'] = { mergedFrom: { from: null, to: source.id } }
    if (tagsBefore.length !== target.tagIds.length) diff.tags = { from: tagsBefore, to: target.tagIds }
    if (moved.length > 0) diff.cards = { from: null, to: moved.map((card) => card.id) }
    recordChange(target, diff, time)
    return json(detail(target))
  }
  if ((match = route.match(/^(PUT|DELETE) \/contacts\/([^/]+)\/tags\/([^/]+)$/))) {
    const [, method, contactId, tagId] = match
    const contact = findContact(contactId!)
    const tag = visibleTags().find((candidate) => candidate.id === decodeURIComponent(tagId!))
    if (!contact || !tag) return notFound()
    const guard = versionGuard(request, contact)
    if (guard) return guard
    const before = [...contact.tagIds]
    contact.tagIds = method === 'PUT' ? [...new Set([...contact.tagIds, tag.id])] : contact.tagIds.filter((candidate) => candidate !== tag.id)
    if (before.length !== contact.tagIds.length) recordChange(contact, { tags: { from: before, to: contact.tagIds } })
    return noContent()
  }

  // Companies.
  if (route === 'GET /companies') {
    const range = pageWindow(url)
    if (range instanceof Response) return range
    const q = normalizeName(url.searchParams.get('q') ?? '')
    const companies = state.companies
      .filter((company) => !company.mergedIntoId && (!q || normalizeName(company.name).includes(q) || (company.domain ?? '').includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id))
    return page(companies, range, companyView)
  }
  if (route === 'POST /companies') {
    const input = await body(request)
    if (typeof input?.name !== 'string' || !input.name.trim()) return invalid('name is required')
    const key = normalizeName(input.name)
    if (state.companies.some((company) => !company.mergedIntoId && normalizeName(company.name) === key)) return fail(409, 'conflict', 'A company with this name exists')
    const time = now()
    const optional = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    const company: StoredCompany = {
      id: nextId(),
      name: input.name.trim(),
      domain: optional(input.domain),
      address: optional(input.address),
      url: optional(input.url),
      mergedIntoId: null,
      createdAt: time,
      updatedAt: time,
    }
    state.companies.push(company)
    return json(companyView(company), 201)
  }
  if ((match = route.match(/^(GET|PATCH) \/companies\/([^/]+)$/))) {
    const [, method, id] = match
    const company = resolveCompany(decodeURIComponent(id!))
    if (!company) return notFound()
    if (method === 'GET') return json(companyView(company))
    const input = await body(request)
    if (!input) return invalid('A JSON object is required')
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) return invalid('name must not be empty')
    for (const field of ['domain', 'address', 'url'] as const) {
      const value = input[field]
      if (value !== undefined && value !== null && typeof value !== 'string') return invalid(`${field} must be a string or null`)
    }
    if (typeof input.name === 'string') company.name = input.name.trim()
    for (const field of ['domain', 'address', 'url'] as const) {
      const value = input[field]
      if (value !== undefined) company[field] = typeof value === 'string' && value.trim() ? value.trim() : null
    }
    company.updatedAt = now()
    return json(companyView(company))
  }
  if ((match = route.match(/^POST \/companies\/([^/]+)\/merge$/))) {
    if (!admin) return forbidden()
    const target = resolveCompany(decodeURIComponent(match[1]!))
    if (!target) return notFound()
    const input = await body(request)
    if (typeof input?.sourceId !== 'string') return invalid('sourceId is required')
    const source = state.companies.find((company) => company.id === input.sourceId && !company.mergedIntoId)
    if (!source) return notFound()
    if (source === target) return invalid('A company cannot be merged into itself')
    // C3: the loser redirects; its contacts keep their companyId.
    const time = now()
    source.mergedIntoId = target.id
    source.updatedAt = time
    target.updatedAt = time
    return json(companyView(target))
  }

  // Tags.
  if (route === 'GET /tags') return json({ items: visibleTags().sort((a, b) => a.name.localeCompare(b.name, 'ja')) })
  if (route === 'POST /tags') {
    const input = await body(request)
    if (typeof input?.name !== 'string' || !input.name.trim()) return invalid('name is required')
    if (input.shared !== undefined && typeof input.shared !== 'boolean') return invalid('shared must be a boolean')
    const shared = input.shared === true
    if (shared && !admin) return forbidden()
    const name = input.name.trim()
    if (visibleTags().some((tag) => normalizeName(tag.name) === normalizeName(name))) return fail(409, 'conflict', 'A tag with this name exists')
    const tag: Tag = { id: nextId(), name, ownerMemberId: shared ? null : caller }
    state.tags.push(tag)
    return json(tag, 201)
  }
  if ((match = route.match(/^DELETE \/tags\/([^/]+)$/))) {
    const tag = visibleTags().find((candidate) => candidate.id === decodeURIComponent(match![1]!))
    if (!tag) return notFound()
    if (tag.ownerMemberId !== caller && !admin) return forbidden()
    state.tags = state.tags.filter((candidate) => candidate !== tag)
    for (const contact of state.contacts) contact.tagIds = contact.tagIds.filter((tagId) => tagId !== tag.id)
    return noContent()
  }

  if (route === 'GET /export.csv') {
    const scope = url.searchParams.get('scope') ?? 'me'
    if (scope !== 'me' && scope !== 'project') return invalid('scope must be me or project')
    if (scope === 'project' && !admin) return forbidden()
    const contacts = state.contacts
      .filter(
        (contact) =>
          contact.state !== 'archived' &&
          visible(contact) &&
          (scope === 'project' || state.cards.some((card) => card.contactId === contact.id && card.ownerMemberId === caller))
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ja'))
    return new Response(exportCsv(contacts), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="contacts-${scope}.csv"`, 'Cache-Control': 'no-store' },
    })
  }

  // Distinct from a missing resource, so tests can tell an unmocked route apart.
  return fail(404, 'not_found', `no mock for ${route}`)
}

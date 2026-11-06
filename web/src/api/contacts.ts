// Contacts API (`/api/contacts/v1/*`, served by cmd/server from the
// SPA's own origin; design/platform/builtin-app-contacts/README.md "API
// contract"). The OIDC edge (Envoy) in front of the server attaches the
// caller's bearer token; the SPA never sees or requests one. Lists are
// `{items, nextCursor}`, single resources are direct objects, errors are
// `{error, message}`. `GET /config` (outside the API prefix) names the
// Project and the Directory browser origin.

/** A Project member, keyed by OIDC `sub`. `directoryPersonId` is set once the server linked them to Directory. */
export type Member = { id: string; displayName: string; email: string; directoryPersonId: string | null }
export type Company = {
  id: string
  name: string
  domain: string | null
  address: string | null
  url: string | null
  contactCount: number
  mergedIntoId: string | null
  createdAt: string
  updatedAt: string
}
export type Visibility = 'shared' | 'private'
export type ContactState = 'draft' | 'active' | 'archived'
export type TagRef = { id: string; name: string }
export type ContactSummary = {
  id: string
  fullName: string
  kana: string | null
  title: string | null
  department: string | null
  company: { id: string; name: string } | null
  primaryEmail: string | null
  visibility: Visibility
  state: ContactState
  tags: TagRef[]
  /** Distinct members who met this contact. */
  encounterCount: number
  knownByMe: boolean
  lastMetAt: string | null
  updatedAt: string
}
export type OcrState = 'pending' | 'done' | 'failed' | 'unavailable'
/** What OCR read off a card; empty strings (or null) and lists when a field was not on the card. `confidence` is 0..1. */
export type OcrFields = {
  fullName: string | null
  kana: string | null
  company: string | null
  department: string | null
  title: string | null
  emails: string[]
  phones: string[]
  address: string | null
  url: string | null
  confidence: number
}
/**
 * One immutable reading of a card by one engine (a re-run adds another).
 * `model` is '' when the gateway did not name it; `fieldConfidence` keys are `OcrFields` names; `overall` is 0..1.
 */
export type Extraction = {
  id: string
  engine: string
  model: string
  fields: OcrFields
  fieldConfidence: Record<string, number>
  overall: number
  durationMs: number
  createdAt: string
}
/** What automatic registration did with a card's extraction (one per Extraction). */
export type DecisionKind = 'AutoCreated' | 'AutoLinked' | 'NeedsReview' | 'Unavailable'
export type BusinessCard = {
  id: string
  contactId: string | null
  owner: Member
  /** Same-origin `/api/contacts/v1/cards/{id}/image`. */
  imageUrl: string
  /** The extraction state; `decision` is the registration outcome (`done` + `NeedsReview` = waits for a member). */
  ocrState: OcrState
  /** The latest extraction, null until one was read. */
  extraction: Extraction | null
  decision: DecisionKind | null
  /** Why a card needs review: `missing_field:<field>`, `ambiguous_match`, `low_confidence`, `policy`, `unlinked`. */
  decisionReason: string | null
  ocrError: string | null
  exchangedAt: string | null
  place: string | null
  createdAt: string
  /** The sheet this card was cut from when one image held several cards (sheet-split.md), else null. */
  sheetId: string | null
  /** Where on the sheet: `[x1, y1, x2, y2]` in pixels of the normalised sheet image; null for a single upload. */
  bbox: [number, number, number, number] | null
}
/** An uploaded image that held ≥ 2 cards; `imageUrl` is the same-origin `/api/contacts/v1/sheets/{id}/image`. */
export type Sheet = { id: string; detected: number; imageUrl: string }
/** `POST /cards`: the card, or one card per detected region plus the sheet they were cut from. */
export type UploadResult = { cards: BusinessCard[]; sheet: Sheet | null }
/** Who made a contact or a change: a member, or automatic registration from a card. */
export type RegistrationSource = 'member' | 'auto'
export type Encounter = { member: Member; firstAt: string; lastAt: string; cardCount: number }
export type ContactChange = { id: string; actor: Member; at: string; diff: Record<string, { from: unknown; to: unknown }>; source: RegistrationSource }
export type Contact = ContactSummary & {
  emails: string[]
  phones: string[]
  address: string | null
  notes: string | null
  createdBy: Member
  registeredBy: RegistrationSource
  version: number
  createdAt: string
  cards: BusinessCard[]
  encounters: Encounter[]
  changes: ContactChange[]
}
/** `auto`: register without a human unless the policy sends a card to review; `review`: a member confirms every card; `off`: no automatic decision. */
export type RegistrationMode = 'auto' | 'review' | 'off'
/** The Project's registration policy (`GET/PUT /settings`; PUT is admin only). Thresholds are 0..1. */
export type Settings = {
  mode: RegistrationMode
  autoCreateThreshold: number
  autoLinkThreshold: number
  /** `OcrFields` names a card must carry to be registered automatically. */
  requiredFields: string[]
  /** Contacts created automatically start private. */
  privateDefault: boolean
  extractorPreference: string[]
  /** Empty restores the release default, then the gateway default. */
  ocrModel: string
}
/** `ownerMemberId` null = a shared tag. */
export type Tag = { id: string; name: string; ownerMemberId: string | null }
export type DuplicateReason = 'name_domain' | 'name_company'
export type DuplicateCandidate = { contacts: [ContactSummary, ContactSummary]; reason: DuplicateReason }
export type OCRModel = { id: string; ownedBy: string; local: boolean }
/**
 * `directory.publicUrl`: the Directory browser origin (`CONTACTS_DIRECTORY_PUBLIC_URL`), null when unset.
 * `ocr.available`: the AI gateway is configured; false means every card asks for manual entry (D3).
 * `ocr.extractor` / `ocr.model`: the engine and the model it reads with ('' when unknown);
 * `ocr.local`: the model runs inside the Project's cluster, so card images do not leave it;
 * `ocr.sheetSplit`: an image holding several cards is split into one card each (else it stays one card).
 */
export type Me = {
  member: Member
  roles: { contactsAdmin: boolean }
  directory: { linked: boolean; publicUrl: string | null }
  ocr: { available: boolean; extractor: string; model: string; releaseModel: string; models: OCRModel[]; local: boolean; sheetSplit: boolean }
  counts: { myCards: number; myContacts: number; contacts: number; companies: number }
}
/** `GET /config`: the Project and the browser origins the server was given (empty when unset). */
export type AppConfig = { projectId: string; publicUrl: string; directoryUrl: string }
export type Page<T> = { items: T[]; nextCursor: string | null }
export type ApiError = { error: string; message: string }

/**
 * `fullName` is required on create. `companyName` creates or looks up a company by its normalised name when
 * `companyId` is absent. On PATCH every field is optional and only the sent ones change.
 */
export type ContactInput = {
  fullName?: string
  kana?: string | null
  companyId?: string | null
  companyName?: string | null
  title?: string | null
  department?: string | null
  emails?: string[]
  phones?: string[]
  address?: string | null
  notes?: string | null
  visibility?: Visibility
}
export type ConfirmInput = { contactId: string } | { contact: ContactInput; companyName: string | null }
export type CompanyInput = { name?: string; domain?: string | null; address?: string | null; url?: string | null }
export type UploadInput = { image: Blob; fileName?: string; exchangedAt?: string; place?: string; contactId?: string }
export type CardsParams = { owner?: 'me' | 'all'; limit?: number; cursor?: string | null }
export type ContactsParams = {
  q?: string
  companyId?: string
  tag?: string
  knownBy?: string
  state?: ContactState
  visibility?: Visibility
  updatedAfter?: string
  limit?: number
  cursor?: string | null
}
export type CompaniesParams = { q?: string; limit?: number; cursor?: string | null }
export type ExportScope = 'me' | 'project'

/**
 * Non-2xx contacts response. `code` is the server's stable snake_case error.
 * `transient` = no error envelope came back: a 5xx from a proxy in front of the
 * server (e.g. during a rollout), or no response at all (status 0).
 */
export class ContactsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly transient: boolean

  constructor(status: number, body: Partial<ApiError> | undefined) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    super(body?.message || `contacts api ${status}`)
    this.name = 'ContactsApiError'
    this.status = status
    this.code = code ?? (status === 404 ? 'not_found' : 'unknown')
    this.transient = code === undefined && (status === 0 || status >= 500)
  }
}

export function isContactsError(error: unknown, code?: string): error is ContactsApiError {
  return error instanceof ContactsApiError && (code === undefined || error.code === code)
}

export const BASE = '/api/contacts/v1'
const READ_TIMEOUT_MS = 8_000
// A 401 first sends the browser to `/` so the edge re-runs sign-in. Another 401
// within this window means the edge forwards a token the server rejects;
// redirecting again would loop, so that 401 reaches the screens instead.
const REAUTH_WINDOW_MS = 60_000
const REAUTH_AT_KEY = 'contacts:reauth-at'

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/** `?a=1&b=2` with only the set (non-empty) parameters, in the given order; '' when none. */
export function searchOf(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The CSV export URL; a plain link, so the browser downloads it with the session cookie. */
export const exportUrl = (scope: ExportScope) => `${BASE}/export.csv?scope=${scope}`

/** The original image a card was cut from (`GET /sheets/{id}/image`; owner or admin). */
export const sheetImageUrl = (sheetId: string) => `${BASE}/sheets/${encodeURIComponent(sheetId)}/image`

export interface ContactsApi {
  /** `GET /config` from the server root. */
  config(): Promise<AppConfig>
  /** The caller (upserted), their roles, the Directory link, OCR availability and counts. */
  me(): Promise<Me>
  cards: {
    /** `owner=all` is admin only. Newest first. */
    list(params?: CardsParams): Promise<Page<BusinessCard>>
    get(cardId: string): Promise<BusinessCard>
    /**
     * 202 with the stored cards (`ocrState: pending`, OCR queued, unless `contactId` is given) and, when the image held
     * several cards, the sheet they were cut from. 400 when `contactId` meets a multi-card image; 413 `image_too_large`, 415 `unsupported_image`.
     */
    upload(input: UploadInput): Promise<UploadResult>
    /** Links the card to an existing contact or creates one from the confirmed fields. */
    confirm(cardId: string, input: ConfirmInput): Promise<Contact>
    /** Re-runs OCR for a `failed`/`unavailable` card; 409 `ocr_unavailable` without a gateway. */
    retryOcr(cardId: string): Promise<BusinessCard>
    /**
     * Undoes an automatic registration (R3): the card leaves its contact and waits for review
     * (`decision: NeedsReview`, reason `unlinked`); an auto-created contact with no other card and no human edit is archived. Owner or admin.
     */
    unlink(cardId: string): Promise<BusinessCard>
    /** Owner or admin. */
    remove(cardId: string): Promise<void>
  }
  settings: {
    /** The registration policy; defaults (mode `auto`) when never saved. */
    get(): Promise<Settings>
    /** Admin only (403 otherwise); 400 for a mode outside the enum or a threshold outside 0..1. */
    put(settings: Settings): Promise<Settings>
  }
  contacts: {
    list(params?: ContactsParams): Promise<Page<ContactSummary>>
    create(input: ContactInput): Promise<Contact>
    get(contactId: string): Promise<Contact>
    /** 409 `version_conflict` when `version` is not the stored one. */
    update(contactId: string, version: number, input: ContactInput): Promise<Contact>
    /** Archives (`state: archived`); admin or creator. `version` guards it like an edit. */
    archive(contactId: string, version: number): Promise<void>
    /** Moves the source's cards and tags to the target and archives the source; `targetVersion` guards the target. */
    merge(targetId: string, targetVersion: number, sourceId: string): Promise<Contact>
    duplicates(limit?: number): Promise<DuplicateCandidate[]>
    /** Tag changes are contact mutations (C2): guarded by `version`, recorded in the history. */
    addTag(contactId: string, version: number, tagId: string): Promise<void>
    removeTag(contactId: string, version: number, tagId: string): Promise<void>
    /** Contacts the caller met, last met first. */
    mine(params?: { limit?: number; cursor?: string | null }): Promise<Page<ContactSummary>>
  }
  companies: {
    /** Merged companies are excluded. */
    list(params?: CompaniesParams): Promise<Page<Company>>
    create(input: CompanyInput & { name: string }): Promise<Company>
    /** A merged company answers with the company it was merged into. */
    get(companyId: string): Promise<Company>
    update(companyId: string, input: CompanyInput): Promise<Company>
    /** Admin only; the source keeps its contacts and redirects to the target. */
    merge(targetId: string, sourceId: string): Promise<Company>
  }
  tags: {
    list(): Promise<Tag[]>
    /** `shared` requires admin. */
    create(name: string, shared: boolean): Promise<Tag>
    remove(tagId: string): Promise<void>
  }
}

export function createContactsApi(fetcher: Fetcher = (input, init) => fetch(input, init), reauth = browserReauth): ContactsApi {
  type Options = { body?: unknown; form?: FormData; headers?: Record<string, string>; root?: boolean }
  async function call<T>(method: string, path: string, options: Options = {}): Promise<T> {
    const read = method === 'GET'
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await fetcher(`${options.root ? '' : BASE}${path}`, {
        method,
        headers,
        // A FormData body sets its own multipart Content-Type with the boundary.
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
        credentials: 'same-origin',
        signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
      })
    } catch {
      // Network failure or read timeout: nothing answered.
      throw new ContactsApiError(0, undefined)
    }
    if (response.status === 401 && reauth()) return new Promise<T>(() => {})
    if (!response.ok) {
      let parsed: Partial<ApiError> | undefined
      try {
        parsed = (await response.json()) as Partial<ApiError>
      } catch {
        parsed = undefined
      }
      throw new ContactsApiError(response.status, parsed)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
  const id = encodeURIComponent
  const ifMatch = (version: number) => ({ 'If-Match': String(version) })

  return {
    config: () => call<AppConfig>('GET', '/config', { root: true }),
    me: () => call<Me>('GET', '/me'),
    cards: {
      list: (params = {}) => call<Page<BusinessCard>>('GET', `/cards${searchOf(params)}`),
      get: (cardId) => call<BusinessCard>('GET', `/cards/${id(cardId)}`),
      upload: ({ image, fileName, exchangedAt, place, contactId }) => {
        const form = new FormData()
        form.set('image', image, fileName ?? 'card')
        if (exchangedAt) form.set('exchangedAt', exchangedAt)
        if (place) form.set('place', place)
        if (contactId) form.set('contactId', contactId)
        return call<UploadResult>('POST', '/cards', { form })
      },
      confirm: (cardId, input) => call<Contact>('POST', `/cards/${id(cardId)}/confirm`, { body: input }),
      retryOcr: (cardId) => call<BusinessCard>('POST', `/cards/${id(cardId)}/ocr`),
      unlink: (cardId) => call<BusinessCard>('POST', `/cards/${id(cardId)}/unlink`),
      remove: (cardId) => call<void>('DELETE', `/cards/${id(cardId)}`),
    },
    settings: {
      get: () => call<Settings>('GET', '/settings'),
      put: (settings) => call<Settings>('PUT', '/settings', { body: settings }),
    },
    contacts: {
      list: (params = {}) => call<Page<ContactSummary>>('GET', `/contacts${searchOf(params)}`),
      create: (input) => call<Contact>('POST', '/contacts', { body: input }),
      get: (contactId) => call<Contact>('GET', `/contacts/${id(contactId)}`),
      update: (contactId, version, input) => call<Contact>('PATCH', `/contacts/${id(contactId)}`, { body: input, headers: ifMatch(version) }),
      archive: (contactId, version) => call<void>('DELETE', `/contacts/${id(contactId)}`, { headers: ifMatch(version) }),
      merge: (targetId, targetVersion, sourceId) => call<Contact>('POST', `/contacts/${id(targetId)}/merge`, { body: { sourceId }, headers: ifMatch(targetVersion) }),
      duplicates: async (limit) => (await call<{ items: DuplicateCandidate[] }>('GET', `/contacts/duplicates${searchOf({ limit })}`)).items,
      addTag: (contactId, version, tagId) => call<void>('PUT', `/contacts/${id(contactId)}/tags/${id(tagId)}`, { headers: ifMatch(version) }),
      removeTag: (contactId, version, tagId) => call<void>('DELETE', `/contacts/${id(contactId)}/tags/${id(tagId)}`, { headers: ifMatch(version) }),
      mine: (params = {}) => call<Page<ContactSummary>>('GET', `/me/contacts${searchOf(params)}`),
    },
    companies: {
      list: (params = {}) => call<Page<Company>>('GET', `/companies${searchOf(params)}`),
      create: (input) => call<Company>('POST', '/companies', { body: input }),
      get: (companyId) => call<Company>('GET', `/companies/${id(companyId)}`),
      update: (companyId, input) => call<Company>('PATCH', `/companies/${id(companyId)}`, { body: input }),
      merge: (targetId, sourceId) => call<Company>('POST', `/companies/${id(targetId)}/merge`, { body: { sourceId } }),
    },
    tags: {
      list: async () => (await call<{ items: Tag[] }>('GET', '/tags')).items,
      create: (name, shared) => call<Tag>('POST', '/tags', { body: { name, shared } }),
      remove: (tagId) => call<void>('DELETE', `/tags/${id(tagId)}`),
    },
  }
}

function browserReauth(): boolean {
  const lastReauthAt = Number(sessionStorage.getItem(REAUTH_AT_KEY))
  if (Date.now() - lastReauthAt < REAUTH_WINDOW_MS) return false
  sessionStorage.setItem(REAUTH_AT_KEY, String(Date.now()))
  window.location.assign('/')
  return true
}

export const contactsApi = createContactsApi()

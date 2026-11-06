// Contact rules shared by the screens and the dev mock (design/platform/
// builtin-app-contacts/README.md "Domain model"): name normalisation and email
// domains (the duplicate rules C4), the editable form a card or a contact
// fills, and the request bodies built from it.
import type { BusinessCard, Contact, ContactInput, ContactSummary, Member, OcrFields, Visibility } from '../api/contacts'

/** Below this OCR confidence the confirm form asks the member to check every field. */
export const LOW_CONFIDENCE = 0.6
export const MAX_NAME_LENGTH = 200
/** The server's upload limit (D4). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const

/** `domain.normalizedName`: NFKC, lower case, every whitespace removed ("ＡＢＣ 商事" → "abc商事"). */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/** The lower-cased part after the last `@`, else null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : ''
  return domain ? domain : null
}

/** One entry per non-empty trimmed line, first occurrence kept (emails / phones typed one per line). */
export function splitLines(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !seen.has(line)) {
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

/** What the confirm and edit forms hold: plain strings, lists as one entry per line. */
export type ContactForm = {
  fullName: string
  kana: string
  companyName: string
  department: string
  title: string
  emails: string
  phones: string
  address: string
  notes: string
  visibility: Visibility
}

export const EMPTY_FORM: ContactForm = {
  fullName: '',
  kana: '',
  companyName: '',
  department: '',
  title: '',
  emails: '',
  phones: '',
  address: '',
  notes: '',
  visibility: 'shared',
}

/** The confirm form pre-filled from what OCR read; empty for an unread card (D3: manual entry). */
export function formFromOcr(fields: OcrFields | null): ContactForm {
  if (!fields) return { ...EMPTY_FORM }
  return {
    ...EMPTY_FORM,
    fullName: fields.fullName ?? '',
    kana: fields.kana ?? '',
    companyName: fields.company ?? '',
    department: fields.department ?? '',
    title: fields.title ?? '',
    emails: fields.emails.join('\n'),
    phones: fields.phones.join('\n'),
    address: fields.address ?? '',
  }
}

/** The edit form for a stored contact. */
export function formFromContact(contact: Contact): ContactForm {
  return {
    fullName: contact.fullName,
    kana: contact.kana ?? '',
    companyName: contact.company?.name ?? '',
    department: contact.department ?? '',
    title: contact.title ?? '',
    emails: contact.emails.join('\n'),
    phones: contact.phones.join('\n'),
    address: contact.address ?? '',
    notes: contact.notes ?? '',
    visibility: contact.visibility,
  }
}

const optional = (value: string) => {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** A full `ContactInput` (create): trimmed, empty optional text as null, lists split by line. */
export function contactInputFromForm(form: ContactForm): ContactInput {
  return {
    fullName: form.fullName.trim(),
    kana: optional(form.kana),
    companyName: optional(form.companyName),
    title: optional(form.title),
    department: optional(form.department),
    emails: splitLines(form.emails),
    phones: splitLines(form.phones),
    address: optional(form.address),
    notes: optional(form.notes),
    visibility: form.visibility,
  }
}

/**
 * The confirm body that creates a contact from a card: the company travels as
 * `companyName` (the server looks it up by normalised name or creates it).
 */
export function confirmCreateBody(form: ContactForm): { contact: ContactInput; companyName: string | null } {
  const { companyName, ...contact } = contactInputFromForm(form)
  return { contact, companyName: companyName ?? null }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])

/** The partial PATCH body: only the fields the form changed (an empty object when nothing did). */
export function contactPatch(contact: Contact, form: ContactForm): ContactInput {
  const next = contactInputFromForm(form)
  const patch: ContactInput = {}
  if (next.fullName !== contact.fullName) patch.fullName = next.fullName
  if (next.kana !== contact.kana) patch.kana = next.kana
  if (normalizeName(next.companyName ?? '') !== normalizeName(contact.company?.name ?? '')) {
    if (next.companyName) patch.companyName = next.companyName
    else patch.companyId = null
  }
  if (next.title !== contact.title) patch.title = next.title
  if (next.department !== contact.department) patch.department = next.department
  if (!sameList(next.emails ?? [], contact.emails)) patch.emails = next.emails
  if (!sameList(next.phones ?? [], contact.phones)) patch.phones = next.phones
  if (next.address !== contact.address) patch.address = next.address
  if (next.notes !== contact.notes) patch.notes = next.notes
  if (next.visibility !== contact.visibility) patch.visibility = next.visibility
  return patch
}

export type FormProblem = 'nameRequired' | 'nameTooLong' | 'emailInvalid'

/** What the form breaks (empty when the write is valid). */
export function formProblems(form: ContactForm): { fullName?: FormProblem; emails?: FormProblem } {
  const problems: { fullName?: FormProblem; emails?: FormProblem } = {}
  const name = form.fullName.trim()
  if (!name) problems.fullName = 'nameRequired'
  else if (Array.from(name).length > MAX_NAME_LENGTH) problems.fullName = 'nameTooLong'
  if (splitLines(form.emails).some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) problems.emails = 'emailInvalid'
  return problems
}

/** Any card still waiting for OCR; the scan list polls while this holds. */
export const hasPendingCards = (cards: readonly BusinessCard[]) => cards.some((card) => card.ocrState === 'pending')

/** The card's best label: the linked contact's name is not on the card, so the extraction's name, else null. */
export const cardName = (card: Pick<BusinessCard, 'extraction'>) => card.extraction?.fields.fullName?.trim() || null

/** A run of cards in a list: one card (`sheetId` null or a lone sheet card), or consecutive cards cut from the same sheet. */
export type CardRun = { sheetId: string | null; cards: BusinessCard[] }

/** Reading order inside a sheet: two cards whose tops differ by less than half a card height share a row; rows top to bottom, then left to right. Cards without a bbox keep their place. */
const byReadingOrder = (a: BusinessCard, b: BusinessCard) => {
  if (!a.bbox || !b.bbox) return 0
  const rowTolerance = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]) / 2
  if (Math.abs(a.bbox[1] - b.bbox[1]) < rowTolerance) return a.bbox[0] - b.bbox[0]
  return a.bbox[1] - b.bbox[1]
}

/** Consecutive cards of the same sheet become one run, ordered as they sit on the sheet; every other card is a run of its own. */
export function groupSheetRuns(cards: readonly BusinessCard[]): CardRun[] {
  const runs: CardRun[] = []
  for (const card of cards) {
    const last = runs.at(-1)
    if (card.sheetId && last?.sheetId === card.sheetId) last.cards.push(card)
    else runs.push({ sheetId: card.sheetId, cards: [card] })
  }
  for (const run of runs) if (run.sheetId && run.cards.length > 1) run.cards.sort(byReadingOrder)
  return runs
}

export type CompanyGroup = { company: { id: string; name: string } | null; contacts: ContactSummary[] }

/** Contacts grouped by company in first-appearance order; contacts without a company come last. */
export function groupByCompany(contacts: readonly ContactSummary[]): CompanyGroup[] {
  const groups = new Map<string, CompanyGroup>()
  for (const contact of contacts) {
    const key = contact.company?.id ?? ''
    let group = groups.get(key)
    if (!group) {
      group = { company: contact.company, contacts: [] }
      groups.set(key, group)
    }
    group.contacts.push(contact)
  }
  const none = groups.get('')
  groups.delete('')
  return none ? [...groups.values(), none] : [...groups.values()]
}

/**
 * C6: a card owner or encounter member without a Directory person renders as
 * "unknown member" (null here), like the server's CSV export does.
 */
export function knownMemberName(member: Member): string | null {
  return member.directoryPersonId && member.displayName.trim() ? member.displayName : null
}

/** The member's Directory profile, when they are linked and Directory's browser origin is known. */
export function directoryProfileUrl(publicUrl: string | null | undefined, personId: string | null): string | undefined {
  if (!publicUrl || !personId) return undefined
  return `${publicUrl.replace(/\/+$/, '')}/people/${encodeURIComponent(personId)}`
}

/** `<input type="date">` value (local calendar day) → RFC 3339 UTC at local midnight; '' → undefined. */
export function dateInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day).toISOString()
}

/** Today's local calendar day as an `<input type="date">` value. */
export function todayInput(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

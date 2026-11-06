// Automatic registration as the screens see it
// (design/platform/builtin-app-contacts/auto-registration.md): which status a
// scanned card is in, why it waits for review, and the Settings form rules.
// Shared by the scan screen, the settings screen and the dev mock.
import type { BusinessCard, OcrFields, Settings } from '../api/contacts'

/**
 * The scan screen's status for one card, from `(contactId, ocrState, decision)`:
 * - `registered`: automatic registration filed it (AutoCreated / AutoLinked) and it can be undone (R3);
 * - `linked`: a member confirmed it (or uploaded it onto a contact);
 * - `reading`: OCR is running;
 * - `failed`: OCR failed (retry, or enter by hand);
 * - `unavailable`: no reading to register from (no gateway, or the policy is `off`): enter by hand;
 * - `review`: read, waiting for a member (`NeedsReview`, or no decision recorded).
 */
export type CardStatus =
  | { kind: 'registered'; contactId: string; decision: 'AutoCreated' | 'AutoLinked' }
  | { kind: 'linked'; contactId: string }
  | { kind: 'reading' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | { kind: 'review'; reason: string | null }

export function cardStatus(card: Pick<BusinessCard, 'contactId' | 'ocrState' | 'decision' | 'decisionReason'>): CardStatus {
  if (card.contactId) {
    return card.decision === 'AutoCreated' || card.decision === 'AutoLinked'
      ? { kind: 'registered', contactId: card.contactId, decision: card.decision }
      : { kind: 'linked', contactId: card.contactId }
  }
  if (card.ocrState === 'pending') return { kind: 'reading' }
  if (card.ocrState === 'failed') return { kind: 'failed' }
  if (card.ocrState === 'unavailable' || card.decision === 'Unavailable') return { kind: 'unavailable' }
  return { kind: 'review', reason: card.decision === 'NeedsReview' ? card.decisionReason : null }
}

/** What OCR read off the card (its latest extraction), else null. */
export const cardFields = (card: Pick<BusinessCard, 'extraction'>): OcrFields | null => card.extraction?.fields ?? null

/** The reasons `Decide` and unlink record, besides `missing_field:<field>`. */
export const REVIEW_REASONS = ['ambiguous_match', 'low_confidence', 'policy', 'unlinked'] as const
export type ReviewReasonCode = (typeof REVIEW_REASONS)[number]

/** A stored `decisionReason`, parsed: `missing_field:<field>` names the field; anything unknown is `other`. */
export type ReviewReason = { kind: 'missing_field'; field: string } | { kind: ReviewReasonCode } | { kind: 'other' }

export function parseReviewReason(reason: string): ReviewReason {
  const missing = /^missing_field:(.+)$/.exec(reason)
  if (missing) return { kind: 'missing_field', field: missing[1]! }
  return (REVIEW_REASONS as readonly string[]).includes(reason) ? { kind: reason as ReviewReasonCode } : { kind: 'other' }
}

/** The fields the settings screen offers as "required to register automatically". */
export const REQUIRED_FIELD_OPTIONS = ['fullName', 'company', 'emails', 'phones'] as const
export type RequiredFieldOption = (typeof REQUIRED_FIELD_OPTIONS)[number]

/** Slider range for both thresholds; the server accepts 0..1, the screen keeps them where auto registration makes sense. */
export const THRESHOLD_MIN = 0.5
export const THRESHOLD_MAX = 1
export const THRESHOLD_STEP = 0.01

/** `registration.Defaults()`: what a Project without a saved row runs with (R7). */
export const DEFAULT_SETTINGS: Settings = {
  mode: 'auto',
  autoCreateThreshold: 0.85,
  autoLinkThreshold: 0.9,
  requiredFields: ['fullName'],
  privateDefault: false,
  extractorPreference: ['gateway-vision'],
  ocrModel: '',
}

/** A slider value rounded to the step, so 0.8500000001 is stored as 0.85. */
export const roundThreshold = (value: number) => Math.round(value / THRESHOLD_STEP) * THRESHOLD_STEP

export type SettingsProblems = { autoCreateThreshold?: 'thresholdRange'; autoLinkThreshold?: 'thresholdRange' }

/** What blocks saving. Thresholds only matter (and are only editable) in `auto` mode. */
export function settingsProblems(settings: Settings): SettingsProblems {
  const problems: SettingsProblems = {}
  if (settings.mode !== 'auto') return problems
  const outside = (value: number) => !Number.isFinite(value) || value < THRESHOLD_MIN || value > THRESHOLD_MAX
  if (outside(settings.autoCreateThreshold)) problems.autoCreateThreshold = 'thresholdRange'
  if (outside(settings.autoLinkThreshold)) problems.autoLinkThreshold = 'thresholdRange'
  return problems
}

/** Required fields toggled on or off; fields the screen does not offer are kept as they are. */
export function toggleRequiredField(settings: Settings, field: RequiredFieldOption, on: boolean): Settings {
  const rest = settings.requiredFields.filter((name) => name !== field)
  return { ...settings, requiredFields: on ? [...rest, field] : rest }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value))

/** Whether the form differs from what is stored. */
export function settingsChanged(stored: Settings, form: Settings): boolean {
  return (
    stored.mode !== form.mode ||
    stored.autoCreateThreshold !== form.autoCreateThreshold ||
    stored.autoLinkThreshold !== form.autoLinkThreshold ||
    stored.privateDefault !== form.privateDefault ||
    stored.ocrModel !== form.ocrModel ||
    !sameSet(stored.requiredFields, form.requiredFields) ||
    !sameSet(stored.extractorPreference, form.extractorPreference)
  )
}

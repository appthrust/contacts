import { describe, expect, test } from 'bun:test'
import type { BusinessCard, DecisionKind, OcrState } from '../api/contacts'
import {
  cardStatus,
  DEFAULT_SETTINGS,
  parseReviewReason,
  REVIEW_REASONS,
  roundThreshold,
  settingsChanged,
  settingsProblems,
  toggleRequiredField,
} from './registration'

type Row = Pick<BusinessCard, 'contactId' | 'ocrState' | 'decision' | 'decisionReason'>
const row = (ocrState: OcrState, decision: DecisionKind | null, contactId: string | null = null, decisionReason: string | null = null): Row => ({
  ocrState,
  decision,
  contactId,
  decisionReason,
})

describe('card status on the scan screen', () => {
  test('(ocrState, decision, contact) map to one chip each', () => {
    expect(cardStatus(row('pending', null))).toEqual({ kind: 'reading' })
    expect(cardStatus(row('done', 'AutoCreated', 'c1'))).toEqual({ kind: 'registered', contactId: 'c1', decision: 'AutoCreated' })
    expect(cardStatus(row('done', 'AutoLinked', 'c2'))).toEqual({ kind: 'registered', contactId: 'c2', decision: 'AutoLinked' })
    expect(cardStatus(row('done', 'NeedsReview', null, 'low_confidence'))).toEqual({ kind: 'review', reason: 'low_confidence' })
    expect(cardStatus(row('done', null))).toEqual({ kind: 'review', reason: null })
    expect(cardStatus(row('unavailable', 'Unavailable'))).toEqual({ kind: 'unavailable' })
    // The policy `off` reads the card but decides Unavailable: manual entry, pre-filled.
    expect(cardStatus(row('done', 'Unavailable'))).toEqual({ kind: 'unavailable' })
    expect(cardStatus(row('failed', null))).toEqual({ kind: 'failed' })
  })

  test('a member-confirmed card is plainly registered and cannot be undone; an undone one is back in review', () => {
    expect(cardStatus(row('done', 'NeedsReview', 'c1', 'ambiguous_match'))).toEqual({ kind: 'linked', contactId: 'c1' })
    expect(cardStatus(row('done', null, 'c1'))).toEqual({ kind: 'linked', contactId: 'c1' })
    // Uploaded straight onto a contact: never read, already filed.
    expect(cardStatus(row('unavailable', null, 'c1'))).toEqual({ kind: 'linked', contactId: 'c1' })
    expect(cardStatus(row('done', 'NeedsReview', null, 'unlinked'))).toEqual({ kind: 'review', reason: 'unlinked' })
    // A reason only belongs to NeedsReview.
    expect(cardStatus({ ...row('done', 'AutoCreated'), decisionReason: 'stale' })).toEqual({ kind: 'review', reason: null })
  })
})

describe('review reasons', () => {
  test('missing_field names the field; known codes parse; anything else is other', () => {
    expect(parseReviewReason('missing_field:company')).toEqual({ kind: 'missing_field', field: 'company' })
    for (const code of REVIEW_REASONS) expect(parseReviewReason(code)).toEqual({ kind: code })
    expect(parseReviewReason('provider_quota')).toEqual({ kind: 'other' })
  })
})

describe('settings form rules', () => {
  test('thresholds must stay within 0.5–1.0 in auto mode only', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual({})
    expect(settingsProblems({ ...DEFAULT_SETTINGS, autoCreateThreshold: 0.3, autoLinkThreshold: 1.2 })).toEqual({
      autoCreateThreshold: 'thresholdRange',
      autoLinkThreshold: 'thresholdRange',
    })
    expect(settingsProblems({ ...DEFAULT_SETTINGS, autoLinkThreshold: Number.NaN })).toEqual({ autoLinkThreshold: 'thresholdRange' })
    expect(settingsProblems({ ...DEFAULT_SETTINGS, mode: 'review', autoCreateThreshold: 0.3 })).toEqual({})
  })

  test('slider values round to the step; toggling a required field keeps the ones the screen does not offer', () => {
    expect(roundThreshold(0.8500000001)).toBeCloseTo(0.85, 10)
    const withKana = { ...DEFAULT_SETTINGS, requiredFields: ['fullName', 'kana'] }
    expect(toggleRequiredField(withKana, 'company', true).requiredFields).toEqual(['fullName', 'kana', 'company'])
    expect(toggleRequiredField(withKana, 'fullName', false).requiredFields).toEqual(['kana'])
  })

  test('changes are detected field by field; required field order does not matter', () => {
    expect(settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(false)
    expect(settingsChanged({ ...DEFAULT_SETTINGS, requiredFields: ['fullName', 'company'] }, { ...DEFAULT_SETTINGS, requiredFields: ['company', 'fullName'] })).toBe(false)
    expect(settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, mode: 'off' })).toBe(true)
    expect(settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, privateDefault: true })).toBe(true)
    expect(settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, autoLinkThreshold: 0.95 })).toBe(true)
    expect(settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, ocrModel: 'gpt-5-mini' })).toBe(true)
    expect(settingsChanged({ ...DEFAULT_SETTINGS, ocrModel: 'gpt-5-mini' }, DEFAULT_SETTINGS)).toBe(true)
  })
})

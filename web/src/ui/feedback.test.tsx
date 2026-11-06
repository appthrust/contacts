import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContactsApiError } from '../api/contacts'
import { I18nProvider } from '../i18n'
import { ActionError, LoadFailed } from './feedback'

const render = (node: ReactNode, language: 'ja' | 'en' = 'ja') => renderToStaticMarkup(<I18nProvider language={language}>{node}</I18nProvider>)

describe('contacts error feedback', () => {
  test('a stale edit explains the conflict instead of a generic failure', () => {
    const error = new ContactsApiError(409, { error: 'version_conflict', message: 'The contact is at version 3' })
    const html = render(<ActionError error={error} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('その間にほかの人がこの連絡先を変更しました。')
    expect(html).not.toContain('version 3')
    expect(render(<ActionError error={error} />, 'en')).toContain('Someone else changed this contact in the meantime.')
  })

  test('upload refusals name the limit; an invalid_request keeps the server detail; unknown errors stay generic', () => {
    expect(render(<ActionError error={new ContactsApiError(413, { error: 'image_too_large', message: '' })} />)).toContain('画像が 5 MB を超えています。')
    expect(render(<ActionError error={new ContactsApiError(415, { error: 'unsupported_image', message: '' })} />)).toContain('JPEG・PNG・WebP・HEIC')
    const invalid = render(<ActionError error={new ContactsApiError(400, { error: 'invalid_request', message: 'fullName is required' })} />)
    expect(invalid).toContain('入力内容を確認してください。')
    expect(invalid).toContain('fullName is required')
    expect(render(<ActionError error={new Error('boom')} />)).toContain('操作を完了できませんでした')
  })

  test('a 401 load failure offers no retry; a store outage explains itself and offers one', () => {
    const denied = render(<LoadFailed error={new ContactsApiError(401, { error: 'unauthenticated', message: '' })} onRetry={() => {}} />)
    expect(denied).toContain('このアカウントでは名刺を使えません')
    expect(denied).not.toContain('<button')
    const store = render(<LoadFailed error={new ContactsApiError(503, { error: 'contacts_store_unavailable', message: 'database unreachable' })} onRetry={() => {}} />)
    expect(store).toContain('もう一度読み込む')
    expect(store).toContain('データベースに一時的につながりません')
  })
})

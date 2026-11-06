import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Me, Settings } from '../../api/contacts'
import { I18nProvider } from '../../i18n'
import { DEFAULT_SETTINGS } from '../../model/registration'
import { OcrEngineNotice, RegistrationForm } from './settings-page'

const ocr: Me['ocr'] = {
  available: true, extractor: 'gateway-vision', model: 'gemma3:4b', releaseModel: '', local: true, sheetSplit: true,
  models: [
    { id: 'gemma3:4b', ownedBy: 'appthrust', local: true },
    { id: 'gpt-5-mini', ownedBy: 'openai', local: false },
    { id: 'qwen3-vl-4b-instruct-fp8', ownedBy: 'vision', local: true },
  ],
}

function render(node: ReactNode, language: 'ja' | 'en' = 'ja') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider language={language}>{node}</I18nProvider>
    </QueryClientProvider>
  )
}

const form = (stored: Settings, canEdit = true, language: 'ja' | 'en' = 'ja') => render(<RegistrationForm stored={stored} canEdit={canEdit} ocr={ocr} />, language)
/** The opening tag of the `<fieldset>` whose legend is `legend`. */
const fieldset = (html: string, legend: string) => html.match(new RegExp(`(<fieldset[^>]*>)<legend[^>]*>${legend}</legend>`))?.[1] ?? ''
/** Every `<tag>` opening tag of this type; attribute order is React's business, so tests look inside one tag at a time. */
const tags = (html: string, tag: string, type: string) => html.match(new RegExp(`<${tag}[^>]*type="${type}"[^>]*>`, 'g')) ?? []

describe('registration settings form', () => {
  test('an admin edits mode, both thresholds, required fields and the private default; save waits for a change', () => {
    const html = form(DEFAULT_SETTINGS)
    expect(html).not.toContain('この設定を変更できるのは名刺の管理者だけです')
    for (const label of ['自動', '確認してから', 'OCRしない']) expect(html).toContain(`>${label}</span>`)
    const radios = tags(html, 'input', 'radio')
    expect(radios).toHaveLength(3)
    expect(radios.filter((tag) => tag.includes('checked=""'))).toEqual([expect.stringContaining('value="auto"')])
    const sliders = tags(html, 'input', 'range')
    expect(sliders).toHaveLength(2)
    for (const slider of sliders) for (const attribute of ['min="0.5"', 'max="1"', 'step="0.01"']) expect(slider).toContain(attribute)
    expect(html).toContain('0.85</output>')
    expect(html).toContain('0.90</output>')
    expect(html).toContain('新しい連絡先を作る確かさ')
    expect(html).toContain('氏名だけの一致は必ず確認に回します')
    for (const label of ['氏名', '会社', 'メールアドレス', '電話番号']) expect(html).toContain(label)
    const checkboxes = tags(html, 'input', 'checkbox')
    const toggle = checkboxes.find((tag) => tag.includes('role="switch"'))
    expect(toggle).toBeDefined()
    expect(toggle).not.toContain('checked=""')
    // fullName is required by default, the others are not.
    expect(checkboxes.filter((tag) => tag !== toggle && tag.includes('checked=""'))).toHaveLength(1)
    expect(tags(html, 'button', 'submit')).toEqual([expect.stringContaining('disabled=""')])
    expect(html).not.toContain('変更を取り消す')
  })

  test('a threshold outside 0.5–1.0 is flagged on its slider in auto mode', () => {
    const html = form({ ...DEFAULT_SETTINGS, autoCreateThreshold: 0.3 })
    expect(html).toContain('0.5〜1.0 の値を選んでください。')
    expect(tags(html, 'input', 'range').filter((tag) => tag.includes('aria-invalid="true"'))).toHaveLength(1)
    expect(html).toContain('0.30</output>')
    expect(form({ ...DEFAULT_SETTINGS, autoLinkThreshold: 1.5 }, true, 'en')).toContain('Choose a value between 0.5 and 1.0.')
  })

  test('outside auto mode the thresholds are disabled and say they only apply to automatic registration', () => {
    const html = form({ ...DEFAULT_SETTINGS, mode: 'review', autoCreateThreshold: 0.3 })
    expect(fieldset(html, '確かさのしきい値')).toContain('disabled=""')
    expect(html).toContain('登録のしかたが「自動」のときだけ使います。')
    expect(html).not.toContain('0.5〜1.0 の値を選んでください。')
    expect(fieldset(html, '登録のしかた')).toStartWith('<fieldset')
    expect(fieldset(html, '登録のしかた')).not.toContain('disabled=""')
  })

  test('members see the policy read-only, without a save button', () => {
    const html = form(DEFAULT_SETTINGS, false)
    expect(html).toContain('この設定を変更できるのは名刺の管理者だけです。')
    expect(fieldset(html, '登録のしかた')).toContain('disabled=""')
    expect(fieldset(html, '自動登録に必要な項目')).toContain('disabled=""')
    expect(tags(html, 'input', 'checkbox').find((tag) => tag.includes('role="switch"'))).toContain('disabled=""')
    expect(tags(html, 'button', 'submit')).toEqual([])
  })

  test('the model select lists the release default and caller-visible models with locality in both languages', () => {
    const html = form(DEFAULT_SETTINGS)
    expect(html).toContain('読み取りに使うモデル')
    expect(html).toContain('<option value="" selected="">リリース既定 (gateway既定)</option>')
    expect(html).toContain('<option value="gemma3:4b">gemma3:4b — クラスタ内</option>')
    expect(html).toContain('<option value="gpt-5-mini">gpt-5-mini — 外部: openai</option>')
    expect(html).toContain('<option value="qwen3-vl-4b-instruct-fp8">qwen3-vl-4b-instruct-fp8 — クラスタ内</option>')
    const en = render(<RegistrationForm stored={{ ...DEFAULT_SETTINGS, ocrModel: 'gpt-5-mini' }} canEdit ocr={{ ...ocr, releaseModel: 'gemma3:4b' }} />, 'en')
    expect(en).toContain('Release default (gemma3:4b)')
    expect(en).toContain('<option value="gpt-5-mini" selected="">gpt-5-mini — External: openai</option>')
    expect(en).toContain('gemma3:4b — In cluster')
    expect(form(DEFAULT_SETTINGS, false).match(/<select[^>]*>/)?.[0]).toContain('disabled=""')
  })

  test('a saved model absent from the catalog stays selected, including when the gateway catalog fails', () => {
    const html = render(<RegistrationForm stored={{ ...DEFAULT_SETTINGS, ocrModel: 'missing-vision' }} canEdit ocr={{ ...ocr, models: [] }} />)
    expect(html).toContain('<option value="missing-vision" selected="">missing-vision</option>')
    expect(html).toContain('リリース既定 (gateway既定)')
  })
})

describe('OCR engine notice', () => {
  test('a local model keeps card images in the cluster; a remote one names where they go', () => {
    const local = render(<OcrEngineNotice ocr={ocr} />)
    expect(local).toContain('gateway-vision（gemma3:4b）で読み取ります')
    expect(local).toContain('名刺画像はクラスタ外に出ません。')
    const remote = render(<OcrEngineNotice ocr={{ ...ocr, model: 'gpt-4o-mini', local: false }} />, 'en')
    expect(remote).toContain('Card images are sent to gpt-4o-mini.')
    expect(render(<OcrEngineNotice ocr={{ ...ocr, model: '', local: false }} />)).toContain('モデル提供元へ送信されます')
    expect(render(<OcrEngineNotice ocr={{ ...ocr, available: false, extractor: '', model: '', local: false, sheetSplit: false }} />)).toContain('名刺は手入力です')
  })

  test('without sheet splitting one line says a multi-card image stays one card', () => {
    const split = render(<OcrEngineNotice ocr={ocr} />)
    expect(split).not.toContain('1 枚の名刺として保存されます')
    const single = render(<OcrEngineNotice ocr={{ ...ocr, sheetSplit: false }} />)
    expect(single).toContain('複数の名刺を写した画像は、1 枚の名刺として保存されます。')
    expect(render(<OcrEngineNotice ocr={{ ...ocr, available: false, extractor: '', model: '', local: false, sheetSplit: false }} />, 'en')).toContain(
      'An image showing several cards is stored as a single card.'
    )
  })
})

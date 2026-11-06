import { useQueryClient } from '@tanstack/react-query'
import { Camera, CheckCircle2, Loader2, UploadCloud, XCircle } from 'lucide-react'
import { useId, useRef, useState, type DragEvent } from 'react'
import { contactsApi, ContactsApiError, type BusinessCard, type UploadResult } from '../../api/contacts'
import { invalidateContacts } from '../../api/queries'
import { useText } from '../../i18n'
import { dateInputToIso, IMAGE_TYPES, MAX_IMAGE_BYTES, todayInput } from '../../model/contact'
import { Button, buttonClasses, cn, errorMessageId, Field, TextInput } from '../../ui'
import { UploadedSheet } from './sheet'

type Upload = { key: number; name: string; status: 'uploading' | 'done' | 'error'; error?: unknown; result?: UploadResult }

/** At most this many uploads run at once; the rest wait in the queue. */
const PARALLEL_UPLOADS = 3

/** The server's own 413 / 415, answered before the bytes leave the device. */
function localProblem(file: File): ContactsApiError | undefined {
  if (file.size > MAX_IMAGE_BYTES) return new ContactsApiError(413, { error: 'image_too_large', message: 'image must be at most 5 MiB' })
  // Browsers report HEIC from some cameras as '' or 'image/heif'; the server decides those.
  if (file.type && file.type !== 'image/heif' && !(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return new ContactsApiError(415, { error: 'unsupported_image', message: 'image must be JPEG, PNG, WebP or HEIC' })
  }
  return undefined
}

/**
 * Drop zone and camera/file picker (`capture="environment"` opens the back
 * camera on phones). Every chosen image is uploaded with the shared "met on"
 * day and place; each shows its own progress row. An image the server split
 * into several cards (a sheet) shows them as one group under its row, each
 * card with its own status; `onOpen` opens a card from there.
 */
export function UploadPanel({ onOpen }: { onOpen?: (card: BusinessCard) => void }) {
  const { t } = useText()
  const id = useId()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const nextKey = useRef(0)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  const [day, setDay] = useState(todayInput)
  const [place, setPlace] = useState('')

  const update = (key: number, change: Partial<Upload>) => setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)))

  async function uploadAll(files: File[]) {
    const jobs = files.map((file) => ({ file, key: nextKey.current++ }))
    setUploads((current) => [...current, ...jobs.map(({ file, key }): Upload => ({ key, name: file.name, status: 'uploading' }))])
    const exchangedAt = dateInputToIso(day)
    const queue = [...jobs]
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const problem = localProblem(job.file)
        if (problem) {
          update(job.key, { status: 'error', error: problem })
          continue
        }
        try {
          const result = await contactsApi.cards.upload({ image: job.file, fileName: job.file.name, exchangedAt, place: place.trim() || undefined })
          update(job.key, { status: 'done', result })
          // Each card appears as soon as it is stored; the list then polls its OCR.
          void invalidateContacts(client)
        } catch (error) {
          update(job.key, { status: 'error', error })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, jobs.length) }, worker))
  }

  const choose = (files: FileList | null) => {
    if (files && files.length > 0) void uploadAll([...files])
    if (input.current) input.current.value = ''
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    choose(event.dataTransfer.files)
  }
  const done = uploads.filter((upload) => upload.status === 'done').length
  const busy = uploads.some((upload) => upload.status === 'uploading')

  return (
    <section aria-label={t('contacts.scan.uploads')} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-stone-300 bg-white'
        )}
      >
        <span aria-hidden className="mb-3 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-strong [&_svg]:size-6">
          <UploadCloud />
        </span>
        <p className="text-sm font-medium text-stone-800">{t(dragging ? 'contacts.scan.dropActive' : 'contacts.scan.drop')}</p>
        <p className="mt-1 text-xs text-stone-500">{t('contacts.scan.limits')}</p>
        <label htmlFor={`${id}-file`} className={buttonClasses('primary', 'md', 'mt-5 cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent')}>
          <Camera aria-hidden />
          {t('contacts.scan.choose')}
          <input
            ref={input}
            id={`${id}-file`}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            onChange={(event) => choose(event.target.files)}
          />
        </label>
      </div>
      <div className="grid content-start gap-4 rounded-xl border border-line bg-white p-4">
        <Field id={`${id}-day`} label={t('contacts.scan.exchangedAt')}>
          <TextInput id={`${id}-day`} type="date" value={day} onChange={(event) => setDay(event.target.value)} />
        </Field>
        <Field id={`${id}-place`} label={t('contacts.scan.place')}>
          <TextInput id={`${id}-place`} value={place} onChange={(event) => setPlace(event.target.value)} placeholder={t('contacts.scan.placePlaceholder')} />
        </Field>
      </div>
      {uploads.length > 0 ? (
        <div className="rounded-xl border border-line bg-white p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p role="status" className="text-sm font-medium text-stone-800">
              {t('contacts.scan.uploadProgress', { done, total: uploads.length })}
            </p>
            {busy ? null : (
              <Button size="sm" tone="ghost" onClick={() => setUploads((current) => current.filter((upload) => upload.status === 'error'))}>
                {t('contacts.scan.dismiss')}
              </Button>
            )}
          </div>
          <ul className="grid gap-1.5">
            {uploads.map((upload) => {
              const known = upload.status === 'error' ? errorMessageId(upload.error) : undefined
              return (
                <li key={upload.key}>
                  <div className="flex min-w-0 items-center gap-2 text-sm [&>svg]:size-4 [&>svg]:shrink-0">
                    {upload.status === 'uploading' ? (
                      <Loader2 aria-hidden className="animate-spin text-accent" />
                    ) : upload.status === 'done' ? (
                      <CheckCircle2 aria-hidden className="text-accent" />
                    ) : (
                      <XCircle aria-hidden className="text-bad" />
                    )}
                    <span className="min-w-0 truncate text-stone-800">{upload.name}</span>
                    <span className={cn('ml-auto shrink-0 text-xs', upload.status === 'error' ? 'text-bad-ink' : 'text-stone-500')}>
                      {upload.status === 'uploading'
                        ? t('contacts.scan.uploading')
                        : upload.status === 'done'
                          ? t('contacts.scan.uploaded')
                          : known
                            ? t(known)
                            : t('contacts.scan.uploadFailed')}
                    </span>
                  </div>
                  {upload.result?.sheet ? <UploadedSheet sheet={upload.result.sheet} cards={upload.result.cards} onOpen={onOpen} /> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

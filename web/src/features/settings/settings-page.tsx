import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Save, ScanLine, ShieldCheck } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { contactsApi, exportUrl, isContactsError, type Me, type RegistrationMode, type Settings } from '../../api/contacts'
import { meQuery, settingsQuery } from '../../api/queries'
import type { MessageId } from '../../copy'
import { useText } from '../../i18n'
import {
  REQUIRED_FIELD_OPTIONS,
  roundThreshold,
  settingsChanged,
  settingsProblems,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  THRESHOLD_STEP,
  toggleRequiredField,
  type RequiredFieldOption,
} from '../../model/registration'
import { useSession } from '../../shell/use-session'
import { ActionError, Button, buttonClasses, cn, Field, Loading, LoadFailed, Notice, PageHeader, Section, Select, Toast, useDocumentTitle } from '../../ui'

/**
 * `/settings`: which engine reads cards and where the images go, the
 * Project's automatic registration policy (admins edit it, members read it),
 * privacy, CSV export, and the caller's counts.
 */
export function SettingsPage() {
  const { t } = useText()
  const { me, config } = useSession()
  useDocumentTitle(t('contacts.nav.settings'))
  const counts = [
    { label: t('contacts.settings.myCards'), value: me.counts.myCards },
    { label: t('contacts.settings.myContacts'), value: me.counts.myContacts },
    { label: t('contacts.settings.contacts'), value: me.counts.contacts },
    { label: t('contacts.settings.companies'), value: me.counts.companies },
  ]
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('contacts.nav.settings')} lead={config.projectId ? t('contacts.settings.project', { project: config.projectId }) : undefined} />
      <Section title={t('contacts.settings.ocr')}>
        <OcrEngineNotice ocr={me.ocr} />
      </Section>
      <Section title={t('contacts.settings.registration')} lead={t('contacts.settings.registrationLead')}>
        <RegistrationSettings canEdit={me.roles.contactsAdmin} ocr={me.ocr} />
      </Section>
      <Section title={t('contacts.settings.privacy')}>
        <div className="flex gap-3 rounded-lg border border-line bg-white px-4 py-3 text-sm text-stone-700">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
          <div className="grid gap-1.5">
            <p>{t('contacts.settings.privacyGateway')}</p>
            <p>{t('contacts.settings.privacyStorage')}</p>
            <p>{t('contacts.settings.privacyVisibility')}</p>
          </div>
        </div>
      </Section>
      <Section title={t('contacts.settings.export')} lead={t('contacts.settings.exportLead')}>
        <div className="flex flex-wrap gap-2">
          <a href={exportUrl('me')} download className={buttonClasses('secondary')}>
            <Download aria-hidden />
            {t('contacts.settings.exportMine')}
          </a>
          {me.roles.contactsAdmin ? (
            <a href={exportUrl('project')} download className={buttonClasses('secondary')}>
              <Download aria-hidden />
              {t('contacts.settings.exportProject')}
            </a>
          ) : null}
        </div>
      </Section>
      <Section title={t('contacts.settings.counts')}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {counts.map((count) => (
            <div key={count.label} className="rounded-lg border border-line bg-white px-4 py-3">
              <dt className="text-xs text-stone-500">{count.label}</dt>
              <dd className="mt-1 text-xl font-semibold text-stone-900 tabular-nums">{count.value}</dd>
            </div>
          ))}
        </dl>
        {me.counts.myCards === 0 ? (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-stone-500 [&_svg]:size-4">
            <ScanLine aria-hidden />
            {t('contacts.settings.noCardsYet')}
          </p>
        ) : null}
      </Section>
    </div>
  )
}

/**
 * The engine and model that read cards, whether card images leave the cluster (`me.ocr`), and — when the server
 * cannot split one image into several cards (`ocr.sheetSplit` false) — that such an image stays one card.
 */
export function OcrEngineNotice({ ocr }: { ocr: Me['ocr'] }) {
  const { t } = useText()
  return (
    <div className="grid gap-2">
      <EngineNotice ocr={ocr} />
      {ocr.sheetSplit ? null : <p className="text-sm text-stone-600">{t('contacts.settings.noSheetSplit')}</p>}
    </div>
  )
}

function EngineNotice({ ocr }: { ocr: Me['ocr'] }) {
  const { t } = useText()
  if (!ocr.available) {
    return (
      <Notice tone="warning" title={t('contacts.settings.ocrOff')}>
        {t('contacts.settings.ocrOffBody')}
      </Notice>
    )
  }
  const engine = ocr.extractor
    ? ocr.model
      ? t('contacts.settings.engineModel', { extractor: ocr.extractor, model: ocr.model })
      : t('contacts.settings.engine', { extractor: ocr.extractor })
    : undefined
  const locality = ocr.local
    ? t('contacts.settings.local')
    : ocr.model
      ? t('contacts.settings.remote', { model: ocr.model })
      : t('contacts.settings.remoteUnknown')
  return (
    <Notice tone={ocr.local ? 'success' : 'info'} title={engine}>
      {locality}
    </Notice>
  )
}

/** Loads the policy; the rest of the page stays usable when it cannot. */
function RegistrationSettings({ canEdit, ocr }: { canEdit: boolean; ocr: Me['ocr'] }) {
  const settings = useQuery(settingsQuery)
  if (settings.isPending) return <Loading />
  if (settings.isError) return <LoadFailed error={settings.error} onRetry={() => void settings.refetch()} />
  return <RegistrationForm stored={settings.data} canEdit={canEdit} ocr={ocr} />
}

const MODES: { mode: RegistrationMode; label: MessageId; hint: MessageId }[] = [
  { mode: 'auto', label: 'contacts.settings.modeAuto', hint: 'contacts.settings.modeAutoHint' },
  { mode: 'review', label: 'contacts.settings.modeReview', hint: 'contacts.settings.modeReviewHint' },
  { mode: 'off', label: 'contacts.settings.modeOff', hint: 'contacts.settings.modeOffHint' },
]

const REQUIRED_FIELD_LABELS: Record<RequiredFieldOption, MessageId> = {
  fullName: 'contacts.form.fullName',
  company: 'contacts.form.company',
  emails: 'contacts.form.emails',
  phones: 'contacts.form.phones',
}

/**
 * The registration policy form (R7). Admins edit and save it (`PUT /settings`);
 * members see the same controls disabled. A 403 on save means the caller lost
 * the admin role: `/me` is re-read so the form turns read-only.
 */
export function RegistrationForm({ stored, canEdit, ocr }: { stored: Settings; canEdit: boolean; ocr: Me['ocr'] }) {
  const { t } = useText()
  const id = useId()
  const client = useQueryClient()
  const [draft, setDraft] = useState(stored)
  // A member (or an admin who just lost the role) sees what is stored, not an unsaved draft.
  const form = canEdit ? draft : stored
  const [savedAt, setSavedAt] = useState(0)
  const save = useMutation({
    mutationFn: (settings: Settings) => contactsApi.settings.put(settings),
    onSuccess: (next) => {
      client.setQueryData(settingsQuery.queryKey, next)
      setDraft(next)
      setSavedAt(Date.now())
      void client.invalidateQueries({ queryKey: meQuery.queryKey })
    },
    onError: (error) => {
      if (isContactsError(error) && error.status === 403) void client.invalidateQueries({ queryKey: meQuery.queryKey })
    },
  })
  const problems = settingsProblems(form)
  const dirty = settingsChanged(stored, form)
  const valid = !problems.autoCreateThreshold && !problems.autoLinkThreshold
  const locked = !canEdit || save.isPending
  const thresholdsOn = form.mode === 'auto'
  const change = (next: Settings) => {
    if (save.isError) save.reset()
    setDraft(next)
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (canEdit && dirty && valid) save.mutate(form)
      }}
      className="grid gap-5 rounded-lg border border-line bg-white px-4 py-4 sm:px-5"
    >
      {canEdit ? null : <Notice>{t('contacts.settings.adminOnly')}</Notice>}
      <Field id={`${id}-ocr-model`} label={t('contacts.settings.ocrModel')}>
        <Select id={`${id}-ocr-model`} value={form.ocrModel} disabled={locked} onChange={(event) => change({ ...form, ocrModel: event.target.value })}>
          <option value="">{t('contacts.settings.releaseModel', { model: ocr.releaseModel || t('contacts.settings.gatewayDefault') })}</option>
          {form.ocrModel && !ocr.models.some((model) => model.id === form.ocrModel) ? <option value={form.ocrModel}>{form.ocrModel}</option> : null}
          {ocr.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id} — {model.local ? t('contacts.settings.modelLocal') : t('contacts.settings.modelExternal', { owner: model.ownedBy })}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset disabled={locked} className="min-w-0">
        <legend className="text-sm font-medium text-stone-800">{t('contacts.settings.mode')}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {MODES.map(({ mode, label, hint }) => (
            <label
              key={mode}
              className={cn(
                'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                form.mode === mode ? 'border-accent bg-accent-soft' : 'border-line hover:border-stone-300',
                locked && 'cursor-not-allowed opacity-70'
              )}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={form.mode === mode}
                onChange={() => change({ ...form, mode })}
                className="mt-0.5 size-4 shrink-0 accent-accent focus-visible:outline-none"
              />
              <span className="min-w-0">
                <span className="block font-medium text-stone-900">{t(label)}</span>
                <span className="mt-0.5 block text-xs text-stone-600">{t(hint)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={locked || !thresholdsOn} className="min-w-0">
        <legend className="text-sm font-medium text-stone-800">{t('contacts.settings.thresholds')}</legend>
        <p className="mt-0.5 text-xs text-stone-500">{t(thresholdsOn ? 'contacts.settings.thresholdsLead' : 'contacts.settings.thresholdsAutoOnly')}</p>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <ThresholdSlider
            id={`${id}-create`}
            label={t('contacts.settings.autoCreateThreshold')}
            hint={t('contacts.settings.autoCreateThresholdHint')}
            error={problems.autoCreateThreshold ? t('contacts.settings.thresholdRange') : undefined}
            value={form.autoCreateThreshold}
            onChange={(value) => change({ ...form, autoCreateThreshold: value })}
          />
          <ThresholdSlider
            id={`${id}-link`}
            label={t('contacts.settings.autoLinkThreshold')}
            hint={t('contacts.settings.autoLinkThresholdHint')}
            error={problems.autoLinkThreshold ? t('contacts.settings.thresholdRange') : undefined}
            value={form.autoLinkThreshold}
            onChange={(value) => change({ ...form, autoLinkThreshold: value })}
          />
        </div>
      </fieldset>

      <fieldset disabled={locked} className="min-w-0">
        <legend className="text-sm font-medium text-stone-800">{t('contacts.settings.requiredFields')}</legend>
        <p className="mt-0.5 text-xs text-stone-500">{t('contacts.settings.requiredFieldsHint')}</p>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {REQUIRED_FIELD_OPTIONS.map((field) => (
            <label key={field} className={cn('flex items-center gap-2 text-sm text-stone-800', locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer')}>
              <input
                type="checkbox"
                checked={form.requiredFields.includes(field)}
                onChange={(event) => change(toggleRequiredField(form, field, event.target.checked))}
                className="size-4 accent-accent"
              />
              {t(REQUIRED_FIELD_LABELS[field])}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className={cn('flex items-start gap-3 text-sm', locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer')}>
          <input
            type="checkbox"
            role="switch"
            checked={form.privateDefault}
            disabled={locked}
            onChange={(event) => change({ ...form, privateDefault: event.target.checked })}
            aria-describedby={`${id}-private-hint`}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full bg-stone-300 transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4"
          />
          <span className="min-w-0">
            <span className="block font-medium text-stone-800">{t('contacts.settings.privateDefault')}</span>
            <span id={`${id}-private-hint`} className="mt-0.5 block text-xs text-stone-500">
              {t('contacts.settings.privateDefaultHint')}
            </span>
          </span>
        </label>
      </div>

      {save.isError ? (
        isContactsError(save.error) && save.error.status === 403 ? (
          <Notice tone="error">{t('contacts.settings.forbidden')}</Notice>
        ) : (
          <ActionError error={save.error} />
        )
      ) : null}
      {canEdit ? (
        <div className="flex flex-col-reverse gap-2 border-t border-stone-100 pt-4 sm:flex-row sm:justify-end">
          {dirty ? (
            <Button onClick={() => change(stored)} disabled={save.isPending}>
              {t('contacts.settings.discard')}
            </Button>
          ) : null}
          <Button type="submit" tone="primary" icon={<Save />} loading={save.isPending} disabled={!dirty || !valid}>
            {t('contacts.common.save')}
          </Button>
        </div>
      ) : null}
      {savedAt > 0 ? (
        <Toast key={savedAt} onDismiss={() => setSavedAt(0)}>
          {t('contacts.settings.saved')}
        </Toast>
      ) : null}
    </form>
  )
}

/** One 0.5–1.0 threshold: a slider with its current value, an explanation, and the range error. */
function ThresholdSlider({
  id,
  label,
  hint,
  error,
  value,
  onChange,
}: {
  id: string
  label: ReactNode
  hint: ReactNode
  error?: ReactNode
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-stone-800">
          {label}
        </label>
        <output htmlFor={id} className={cn('text-sm font-semibold tabular-nums', error ? 'text-bad-ink' : 'text-accent-strong')}>
          {Number.isFinite(value) ? value.toFixed(2) : '—'}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={THRESHOLD_MIN}
        max={THRESHOLD_MAX}
        step={THRESHOLD_STEP}
        value={value}
        onChange={(event) => onChange(roundThreshold(Number(event.target.value)))}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-${error ? 'error' : 'hint'}`}
        className="mt-2 block h-5 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div aria-hidden className="mt-0.5 flex justify-between text-[11px] text-stone-400 tabular-nums">
        <span>{THRESHOLD_MIN.toFixed(2)}</span>
        <span>{THRESHOLD_MAX.toFixed(2)}</span>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-bad-ink">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="mt-1 text-xs text-stone-500">
          {hint}
        </p>
      )}
    </div>
  )
}

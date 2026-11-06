import { AppSwitcher } from '@appthrust/app-launcher'
import { Building2, Copy, Languages, ScanLine, Settings, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { setLanguage, useText } from '../i18n'
import { paths } from '../routes/paths'
import { Avatar, Button, HrefLink } from '../ui'
import { useSession } from './use-session'

const NAV_LINK =
  'flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0'
const NAV_ACTIVE = { className: 'bg-accent-soft text-accent-strong hover:bg-accent-soft hover:text-accent-strong' }
// Five sections, the language switch, the switcher and the signed-in member do not fit a phone's width;
// below `md` the section links show their icon and keep the label for screen readers and as a tooltip.
const NAV_LABEL = 'max-md:sr-only'

/** Top bar (brand, sections, language, the app switcher, the signed-in member) over the page. */
export function Shell({ children }: { children: ReactNode }) {
  const { t, language } = useText()
  const { me } = useSession()
  const sections = [
    { href: paths.scan, label: t('contacts.nav.scan'), icon: <ScanLine aria-hidden /> },
    { href: paths.contacts(), label: t('contacts.nav.contacts'), icon: <Users aria-hidden /> },
    { href: paths.companies(), label: t('contacts.nav.companies'), icon: <Building2 aria-hidden /> },
    { href: paths.duplicates, label: t('contacts.nav.duplicates'), icon: <Copy aria-hidden /> },
    { href: paths.settings, label: t('contacts.nav.settings'), icon: <Settings aria-hidden /> },
  ]
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 min-h-10 content-center rounded-md bg-white px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('contacts.nav.skipToMain')}
      </a>
      <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-3 sm:gap-2 sm:px-6">
          <HrefLink href={paths.scan} className="mr-2 flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-stone-900" activeOptions={{ includeSearch: false }}>
            <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-white">
              {t('contacts.productMark')}
            </span>
            <span className="hidden lg:inline">{t('contacts.product')}</span>
          </HrefLink>
          <nav aria-label={t('contacts.nav.label')} className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-1">
            {sections.map((section) => (
              <HrefLink
                key={section.href}
                href={section.href}
                title={section.label}
                className={NAV_LINK}
                activeProps={NAV_ACTIVE}
                // A section stays current on its detail pages (`/contacts/<id>`) and with filters set.
                activeOptions={{ exact: section.href === paths.scan, includeSearch: false }}
              >
                {section.icon}
                <span className={NAV_LABEL}>{section.label}</span>
              </HrefLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <Button
              tone="ghost"
              size="sm"
              icon={<Languages />}
              aria-label={`${t('contacts.nav.language')}: ${t(language === 'ja' ? 'contacts.language.en' : 'contacts.language.ja')}`}
              onClick={() => setLanguage(language === 'ja' ? 'en' : 'ja')}
            >
              <span lang={language === 'ja' ? 'en' : 'ja'} className="hidden sm:inline">
                {t(language === 'ja' ? 'contacts.language.en' : 'contacts.language.ja')}
              </span>
            </Button>
            <AppSwitcher language={language} />
            <span className="flex min-h-10 items-center gap-1.5 pl-1.5 text-sm font-medium text-stone-600 md:min-h-9">
              <Avatar name={me.member.displayName || t('contacts.common.unknownMember')} size="sm" />
              <span className="max-w-32 truncate max-lg:sr-only">
                <span className="sr-only">{t('contacts.nav.you')}: </span>
                {me.member.displayName}
              </span>
            </span>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 focus:outline-none sm:px-6 md:py-8">
        {children}
      </main>
    </div>
  )
}

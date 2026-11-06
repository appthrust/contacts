// Page routes. List pages with a search box (`/contacts`, `/companies`) have
// no loader: their results suspend inside the page, so typing never swaps the
// whole page (and the focused input) for the pending screen.
import { createRoute } from '@tanstack/react-router'
import { companyQuery, contactQuery, duplicatesQuery, myCardsQuery } from '../api/queries'
import { CompaniesPage } from '../features/companies/companies-page'
import { CompanyPage } from '../features/companies/company-page'
import { ContactPage } from '../features/contacts/contact-page'
import { ContactsPage } from '../features/contacts/contacts-page'
import { DuplicatesPage } from '../features/duplicates/duplicates-page'
import { ScanPage } from '../features/scan/scan-page'
import { SettingsPage } from '../features/settings/settings-page'
import type { ContactsSearch } from './paths'
import { notFoundOn404, rootRoute } from './root'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export const scanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { card?: string } => (text(search.card) ? { card: text(search.card) } : {}),
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(myCardsQuery),
  component: function ScanRoute() {
    const { card } = scanRoute.useSearch()
    return <ScanPage cardId={card} />
  },
})

export const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts',
  validateSearch: (search: Record<string, unknown>): ContactsSearch => {
    const parsed: ContactsSearch = {}
    if (text(search.q)) parsed.q = text(search.q)
    if (text(search.company)) parsed.company = text(search.company)
    if (text(search.tag)) parsed.tag = text(search.tag)
    if (search.known === 'me') parsed.known = 'me'
    return parsed
  },
  component: function ContactsRoute() {
    return <ContactsPage search={contactsRoute.useSearch()} />
  },
})

export const contactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts/$contactId',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(contactQuery(params.contactId)).catch(notFoundOn404),
  component: function ContactRoute() {
    const { contactId } = contactRoute.useParams()
    return <ContactPage key={contactId} contactId={contactId} />
  },
})

export const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/companies',
  validateSearch: (search: Record<string, unknown>): { q?: string } => (text(search.q) ? { q: text(search.q) } : {}),
  component: function CompaniesRoute() {
    const { q } = companiesRoute.useSearch()
    return <CompaniesPage q={q} />
  },
})

export const companyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/companies/$companyId',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(companyQuery(params.companyId)).catch(notFoundOn404),
  component: function CompanyRoute() {
    const { companyId } = companyRoute.useParams()
    return <CompanyPage key={companyId} companyId={companyId} />
  },
})

export const duplicatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/duplicates',
  loader: ({ context }) => context.queryClient.ensureQueryData(duplicatesQuery),
  component: DuplicatesPage,
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([scanRoute, contactsRoute, contactRoute, companiesRoute, companyRoute, duplicatesRoute, settingsRoute])

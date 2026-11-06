// Read-model loading (React Query). Every query is a `queryOptions()` /
// `infiniteQueryOptions()` factory so route loaders (`ensureQueryData`) and
// components share one key and fetcher.
import { infiniteQueryOptions, QueryClient, queryOptions } from '@tanstack/react-query'
import { hasPendingCards } from '../model/contact'
import { contactsApi, ContactsApiError, type CompaniesParams, type ContactsParams } from './contacts'

/** Retries for a call nothing answered (rollout gap, network blip). */
const TRANSIENT_RETRIES = 3

/** Any answer with a status (4xx, coded 5xx) is final; unanswered calls are retried with backoff. */
export const retryQuery = (failureCount: number, error: unknown) =>
  error instanceof ContactsApiError && !error.transient ? false : failureCount < TRANSIENT_RETRIES

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: retryQuery, retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000), staleTime: 10_000 },
  },
})

/** Every contacts key starts with this, so one invalidation refreshes everything after a write. */
export const CONTACTS_KEY = ['contacts'] as const

/** A write (confirm, edit, merge, tag) changes lists, counts and detail pages; everything lives under CONTACTS_KEY. */
export const invalidateContacts = (client: QueryClient) => client.invalidateQueries({ queryKey: CONTACTS_KEY })

/** Pending cards are re-read this often until OCR settles. */
export const OCR_POLL_MS = 3_000
/** List page size. */
export const PAGE_SIZE = 30

export const configQuery = queryOptions({ queryKey: [...CONTACTS_KEY, 'config'], queryFn: () => contactsApi.config(), staleTime: Infinity })

export const meQuery = queryOptions({ queryKey: [...CONTACTS_KEY, 'me'], queryFn: () => contactsApi.me(), staleTime: 60_000 })

/** The caller's cards, newest first; re-read every 3 s while any loaded card waits for OCR. */
export const myCardsQuery = infiniteQueryOptions({
  queryKey: [...CONTACTS_KEY, 'cards', 'me'],
  queryFn: ({ pageParam }) => contactsApi.cards.list({ owner: 'me', limit: PAGE_SIZE, cursor: pageParam }),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.nextCursor,
  refetchInterval: (query) => (query.state.data && hasPendingCards(query.state.data.pages.flatMap((page) => page.items)) ? OCR_POLL_MS : false),
})

export const cardQuery = (cardId: string) => queryOptions({ queryKey: [...CONTACTS_KEY, 'cards', 'one', cardId], queryFn: () => contactsApi.cards.get(cardId) })

/** The list filters a URL carries; unset ones are left out of the key and the request. */
export type ContactFilters = Pick<ContactsParams, 'q' | 'companyId' | 'tag' | 'knownBy'>

export const contactsQuery = (filters: ContactFilters) =>
  infiniteQueryOptions({
    queryKey: [...CONTACTS_KEY, 'contacts', 'list', filters.q ?? '', filters.companyId ?? '', filters.tag ?? '', filters.knownBy ?? ''],
    queryFn: ({ pageParam }) => contactsApi.contacts.list({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })

/** The first few contacts matching `q`: duplicate candidates beside the confirm form, the merge picker. */
export const contactSearchQuery = (q: string) =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'contacts', 'search', q],
    queryFn: async () => (await contactsApi.contacts.list({ q, limit: 5 })).items,
    enabled: q.trim() !== '',
  })

export const contactQuery = (contactId: string) =>
  queryOptions({ queryKey: [...CONTACTS_KEY, 'contacts', 'one', contactId], queryFn: () => contactsApi.contacts.get(contactId) })

export const duplicatesQuery = queryOptions({ queryKey: [...CONTACTS_KEY, 'duplicates'], queryFn: () => contactsApi.contacts.duplicates(50) })

export const companiesQuery = (params: Pick<CompaniesParams, 'q'>) =>
  infiniteQueryOptions({
    queryKey: [...CONTACTS_KEY, 'companies', 'list', params.q ?? ''],
    queryFn: ({ pageParam }) => contactsApi.companies.list({ q: params.q, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })

/** The company filter's options: the first 100 companies by the server's order. */
export const companyOptionsQuery = queryOptions({
  queryKey: [...CONTACTS_KEY, 'companies', 'options'],
  queryFn: async () => (await contactsApi.companies.list({ limit: 100 })).items,
})

export const companyQuery = (companyId: string) =>
  queryOptions({ queryKey: [...CONTACTS_KEY, 'companies', 'one', companyId], queryFn: () => contactsApi.companies.get(companyId) })

export const tagsQuery = queryOptions({ queryKey: [...CONTACTS_KEY, 'tags'], queryFn: () => contactsApi.tags.list() })

/** The Project's registration policy (`GET /settings`); every member reads it, admins change it. */
export const settingsQuery = queryOptions({ queryKey: [...CONTACTS_KEY, 'settings'], queryFn: () => contactsApi.settings.get() })

// Every contacts URL. `/` is the scan screen (upload, OCR state, confirm);
// `?card=<id>` opens a card's confirm panel over it.

/** `/contacts` list filters as they appear in the URL. */
export type ContactsSearch = { q?: string; company?: string; tag?: string; known?: 'me' }

function withSearch(path: string, search: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) if (value) params.set(key, value)
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export const paths = {
  scan: '/',
  card: (cardId: string) => withSearch('/', { card: cardId }),
  contacts: (search: ContactsSearch = {}) => withSearch('/contacts', search),
  contact: (contactId: string) => `/contacts/${encodeURIComponent(contactId)}`,
  companies: (q?: string) => withSearch('/companies', { q }),
  company: (companyId: string) => `/companies/${encodeURIComponent(companyId)}`,
  duplicates: '/duplicates',
  settings: '/settings',
}

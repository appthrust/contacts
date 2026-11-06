// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the contacts contract (`/config`, `/api/contacts/v1/*`, ./mock-contacts) and the
// app switcher's `GET /launcher` on one port; Vite proxies all three here (vite.config.ts).
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { contactsRoutes } from './mock-contacts'

const port = Number(process.env.CONTACTS_MOCK_PORT ?? 5246)
const launcher = createMockLauncherHandler(mockLauncherEntries('contacts'))

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  // Card uploads are up to 5 MiB; leave room for the multipart envelope so the mock answers 413 itself.
  maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url)
    return launcher(request) ?? (await contactsRoutes(request, url)) ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
  },
})

console.log(
  `contacts mock API on http://${server.hostname}:${server.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'}, MOCK_OCR=${process.env.MOCK_OCR ?? 'on'}, MOCK_OCR_DELAY_MS=${process.env.MOCK_OCR_DELAY_MS ?? 2000})`
)

import { createRouter } from '@tanstack/react-router'
import { queryClient } from './api/queries'
import { routeTree } from './routes/pages'
import { NotFound, RouteError, RoutePending } from './routes/root'

// Search params are plain strings (`?q=山田&known=me`), so the URL keeps the
// URLSearchParams shape instead of TanStack's JSON-encoded default.
function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  // Loaders read through React Query, which owns freshness.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingMs: 150,
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

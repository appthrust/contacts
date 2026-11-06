import { useQueryErrorResetBoundary, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, notFound, Outlet, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { SearchX } from 'lucide-react'
import { useEffect } from 'react'
import { isContactsError } from '../api/contacts'
import { configQuery, meQuery } from '../api/queries'
import { useText } from '../i18n'
import { Shell } from '../shell/shell'
import { EmptyState, LinkButton, Loading, LoadFailed, useDocumentTitle } from '../ui'
import { paths } from './paths'

export type RouterContext = { queryClient: QueryClient }

/** Loader helper: an unknown (or someone else's private) contact or company renders the not-found page instead of an error. */
export function notFoundOn404(error: unknown): never {
  if (isContactsError(error, 'not_found')) throw notFound()
  throw error
}

export function NotFound() {
  const { t } = useText()
  useDocumentTitle(t('contacts.notFound.title'))
  return (
    <div className="mx-auto max-w-md py-12">
      <EmptyState
        icon={<SearchX />}
        heading="h1"
        title={t('contacts.notFound.title')}
        body={t('contacts.notFound.body')}
        action={
          <LinkButton href={paths.scan} tone="primary">
            {t('contacts.notFound.home')}
          </LinkButton>
        }
      />
    </div>
  )
}

/** In-page load failure (inside the shell). Retry re-runs the loaders and resets failed suspense queries. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const queryErrorResetBoundary = useQueryErrorResetBoundary()
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary])
  if (isContactsError(error, 'not_found')) return <NotFound />
  return (
    <div className="mx-auto max-w-xl py-8">
      <LoadFailed error={error} onRetry={() => void router.invalidate()} />
    </div>
  )
}

export function RoutePending() {
  return <Loading />
}

/** The caller could not be loaded: there is no shell yet. */
function RootError(props: ErrorComponentProps) {
  const { t } = useText()
  useDocumentTitle(t('contacts.common.loadFailed'))
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <RouteError {...props} />
    </div>
  )
}

function RootPending() {
  return (
    <div className="mx-auto flex max-w-xl justify-center px-6 py-24">
      <Loading />
    </div>
  )
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  // `GET /me` upserts the signed-in member (and links Directory) first; everything else reads after it.
  beforeLoad: ({ context }) => Promise.all([context.queryClient.ensureQueryData(meQuery), context.queryClient.ensureQueryData(configQuery)]),
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  errorComponent: RootError,
  pendingComponent: RootPending,
  notFoundComponent: NotFound,
})

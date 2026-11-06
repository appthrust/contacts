import { useSuspenseQuery } from '@tanstack/react-query'
import { configQuery, meQuery } from '../api/queries'

/**
 * The signed-in member, their roles, the Directory link, OCR availability and
 * counts (`GET /api/contacts/v1/me`), plus the Project config (`GET /config`).
 * The root route loads both before any page renders, so this never suspends
 * there; the live queries keep pages current after writes.
 * `directoryUrl`: Directory's browser origin from `/me`, else from `/config`; null when neither knows it.
 */
export function useSession() {
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: config } = useSuspenseQuery(configQuery)
  return { me, config, directoryUrl: me.directory.publicUrl || config.directoryUrl || null }
}

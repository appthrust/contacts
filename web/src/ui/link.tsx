// Router-aware anchor for Contacts' string hrefs (`paths.*`). Pages build
// URLs as strings; this turns a string into TanStack `to` + `search` + `hash` so
// the rendered `href`, preloading and active state are all correct (a bare
// `<Link href>` would render the current URL as its href).
import { Link, type LinkProps } from '@tanstack/react-router'
import type { AnchorHTMLAttributes, Ref } from 'react'

export type HrefParts = { to: string; search: Record<string, string>; hash: string | undefined }

/** "/a/b?x=1#h" → { to: "/a/b", search: { x: "1" }, hash: "h" }. */
export function splitHref(href: string): HrefParts {
  const hashAt = href.indexOf('#')
  const hash = hashAt === -1 ? undefined : href.slice(hashAt + 1)
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  const to = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
  const search = queryAt === -1 ? {} : Object.fromEntries(new URLSearchParams(beforeHash.slice(queryAt + 1)))
  return { to: to || '/', search, hash: hash || undefined }
}

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onFocus'>

export type HrefLinkProps = AnchorProps & {
  href: string
  ref?: Ref<HTMLAnchorElement>
  /** Extra props (usually `className`) while the link's URL is the current one. */
  activeProps?: AnchorProps
  /**
   * When the link counts as current (TanStack then sets aria-current="page" and data-status="active").
   * Default: exact path and query — a link that leaves a search/filter is not current.
   */
  activeOptions?: { exact?: boolean; includeSearch?: boolean }
  replace?: boolean
  preload?: false | 'intent'
}

export function HrefLink({ href, activeOptions, ...rest }: HrefLinkProps) {
  const { to, search, hash } = splitHref(href)
  // `to` is a runtime path string, which the registered route types cannot express for splat URLs.
  const target = {
    to,
    search,
    hash,
    activeOptions: { exact: activeOptions?.exact ?? true, includeSearch: activeOptions?.includeSearch ?? true },
  } as unknown as LinkProps
  return <Link {...target} {...(rest as Omit<LinkProps, 'to'>)} />
}

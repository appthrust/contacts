import { useState } from 'react'

/** Capture the opener at the open transition, before a child input's autoFocus can steal focus. */
export function useReturnFocus(open: boolean) {
  const [wasOpen, setWasOpen] = useState(false)
  const [opener, setOpener] = useState<HTMLElement | null>(null)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const active = document.activeElement
      if (active instanceof HTMLElement) {
        // A menu item disappears when it opens a dialog. Return to its trigger instead.
        const menu = active.closest('[role="menu"]')
        setOpener(menu?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? active : active)
      }
    }
  }
  return {
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    },
  }
}

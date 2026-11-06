import { useEffect } from 'react'
import { useText } from '../i18n'

/** Page-owned title, restored on unmount so loading/error routes never retain the previous page. */
export function useDocumentTitle(title: string): void {
  const { t } = useText()
  const product = t('contacts.product')
  useEffect(() => {
    const previous = document.title
    const next = `${title} – ${product}`
    document.title = next
    return () => {
      if (document.title === next) document.title = previous
    }
  }, [title, product])
}

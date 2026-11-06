import { useEffect, useState } from 'react'

/** `value` once it stopped changing for `delayMs` (search-as-you-type without a request per keystroke). */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

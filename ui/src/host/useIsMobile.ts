/**
 * Whether the viewport is phone-narrow (below the dashboard's 768px breakpoint).
 *
 * The dashboard's own hook is private; this is the same media query read through
 * `useSyncExternalStore`, rechecked on resize and orientation changes so a missed
 * `change` event cannot strand it.
 */
import { useSyncExternalStore } from 'react'

export const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function mql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(MOBILE_QUERY)
}

function subscribe(cb: () => void) {
  const list = mql()
  list?.addEventListener?.('change', cb)
  window.addEventListener('resize', cb)
  window.addEventListener('orientationchange', cb)
  return () => {
    list?.removeEventListener?.('change', cb)
    window.removeEventListener('resize', cb)
    window.removeEventListener('orientationchange', cb)
  }
}

const getSnapshot = () => mql()?.matches ?? false
const getServerSnapshot = () => false

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

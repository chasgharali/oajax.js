import type { StorageAdapter } from './types'

/** Returns `window.localStorage` if it exists and can be written, else `undefined`. */
export function getLocalStorage(): Storage | undefined {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage
    if (!ls) return undefined
    const probe = '__oajax_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return ls
  } catch {
    // Safari private mode, disabled storage, sandboxed iframes.
    return undefined
  }
}

/**
 * Stores each value as JSON under `"<name>:<key>"` in `localStorage`.
 *
 * localStorage is synchronous and small (about 5 MB per origin in most
 * browsers), so prefer IndexedDB when it is available. A full store makes
 * `set` reject with the browser's quota error.
 */
export function createLocalStorage(name = 'oajax', storage?: Storage): StorageAdapter {
  const prefix = `${name}:`
  const ls = (): Storage => {
    const s = storage ?? getLocalStorage()
    if (!s) throw new Error('oajax: localStorage is not available')
    return s
  }
  return {
    kind: 'localstorage',
    async get<T>(key: string) {
      const raw = ls().getItem(prefix + key)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw) as T
      } catch {
        return undefined
      }
    },
    async set(key, value) {
      ls().setItem(prefix + key, JSON.stringify(value))
    },
    async delete(key) {
      ls().removeItem(prefix + key)
    },
    async keys(keyPrefix) {
      const s = ls()
      const full = prefix + keyPrefix
      const out: string[] = []
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)
        if (k !== null && k.startsWith(full)) out.push(k.slice(prefix.length))
      }
      return out
    },
  }
}

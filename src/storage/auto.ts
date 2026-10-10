import { createIndexedDBStorage, getIndexedDB, openDatabase } from './indexeddb'
import { createLocalStorage, getLocalStorage } from './local'
import { createMemoryStorage } from './memory'
import type { StorageAdapter } from './types'

/**
 * Picks the best store the first time it is used: IndexedDB, then
 * localStorage, then memory. Nothing is touched until then, so creating it on
 * the server is safe.
 */
export function createAutoStorage(name = 'oajax'): StorageAdapter {
  let chosen: Promise<StorageAdapter> | undefined
  const pick = (): Promise<StorageAdapter> => {
    chosen ??= (async () => {
      if (getIndexedDB()) {
        try {
          const db = await openDatabase(name)
          db.close()
          return createIndexedDBStorage(name)
        } catch {
          // Blocked or broken IndexedDB (some private modes, old WebViews).
        }
      }
      if (getLocalStorage()) return createLocalStorage(name)
      return createMemoryStorage()
    })()
    return chosen
  }

  const adapter: StorageAdapter & { resolve(): Promise<StorageAdapter> } = {
    get kind() {
      return 'auto'
    },
    async get(key) {
      return (await pick()).get(key)
    },
    async set(key, value) {
      return (await pick()).set(key, value)
    },
    async delete(key) {
      return (await pick()).delete(key)
    },
    async keys(prefix) {
      return (await pick()).keys(prefix)
    },
    /** The adapter that was chosen; useful for showing it in a debug panel. */
    resolve: pick,
  }
  return adapter
}

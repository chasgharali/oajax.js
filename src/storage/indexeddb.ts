import type { StorageAdapter } from './types'

const STORE = 'kv'

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Returns the global `indexedDB` factory, or `undefined` (server, old WebViews). */
export function getIndexedDB(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined
  } catch {
    return undefined
  }
}

/** Opens (or creates) the database. Rejects if IndexedDB is missing or blocked. */
export function openDatabase(name: string, factory = getIndexedDB()): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new Error('oajax: IndexedDB is not available'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = factory.open(name, 1)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      // Let a newer version of the page upgrade the database instead of hanging.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('oajax: could not open IndexedDB'))
    req.onblocked = () => reject(new Error('oajax: IndexedDB open was blocked'))
  })
}

/**
 * Stores values in an IndexedDB database called `name`, in one object store.
 * This is the default where IndexedDB exists: it is asynchronous and has far
 * more room than localStorage.
 */
export function createIndexedDBStorage(name = 'oajax', factory?: IDBFactory): StorageAdapter {
  let dbPromise: Promise<IDBDatabase> | undefined
  const db = () => {
    dbPromise ??= openDatabase(name, factory ?? getIndexedDB()).catch((err) => {
      dbPromise = undefined // allow a later retry
      throw err
    })
    return dbPromise
  }
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE)

  return {
    kind: 'indexeddb',
    async get<T>(key: string) {
      const value = await promisify((await store('readonly')).get(key))
      return value === undefined ? undefined : (value as T)
    },
    async set(key, value) {
      // Structured clone cannot copy functions or class instances; a JSON round
      // trip keeps the behaviour identical to the other adapters.
      await promisify((await store('readwrite')).put(JSON.parse(JSON.stringify(value)), key))
    },
    async delete(key) {
      await promisify((await store('readwrite')).delete(key))
    },
    async keys(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
      const keys = await promisify((await store('readonly')).getAllKeys(range))
      return keys.map(String)
    },
  }
}

import type { StorageAdapter } from './types'

/**
 * Keeps everything in a `Map`. Nothing survives a reload: use it for tests,
 * server rendering, or when you want the queue only for the life of the page.
 *
 * Pass the same `map` to two adapters to simulate a reload in tests.
 */
export function createMemoryStorage(map: Map<string, string> = new Map()): StorageAdapter {
  return {
    kind: 'memory',
    async get<T>(key: string) {
      const raw = map.get(key)
      return raw === undefined ? undefined : (JSON.parse(raw) as T)
    },
    async set(key, value) {
      // Serialise so callers cannot mutate stored values by reference, and so
      // the memory store behaves like the persistent ones.
      map.set(key, JSON.stringify(value))
    },
    async delete(key) {
      map.delete(key)
    },
    async keys(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

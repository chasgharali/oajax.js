import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createOajax } from '../src/client'
import { createAutoStorage } from '../src/storage/auto'
import { createIndexedDBStorage } from '../src/storage/indexeddb'
import { createLocalStorage } from '../src/storage/local'
import { createMemoryStorage } from '../src/storage/memory'
import type { StorageAdapter } from '../src/storage/types'
import type { OajaxOptions } from '../src/types'
import { fakeServer, json, until } from './helpers'

let dbCount = 0

const adapters: [string, () => () => StorageAdapter][] = [
  [
    'memory (shared map)',
    () => {
      const map = new Map<string, string>()
      return () => createMemoryStorage(map)
    },
  ],
  [
    'localStorage',
    () => {
      const name = `ls-${++dbCount}`
      return () => createLocalStorage(name)
    },
  ],
  [
    'IndexedDB (fake-indexeddb)',
    () => {
      const name = `idb-${++dbCount}`
      return () => createIndexedDBStorage(name)
    },
  ],
]

describe.each(adapters)('persistence with %s', (_label, makeFactory) => {
  it('survives a reload: a new client on the same storage serves the cache and replays the outbox', async () => {
    const storageFor = makeFactory()
    const server = fakeServer((req) => json({ url: req.url, body: req.body }))
    const online = { value: true }
    const base: OajaxOptions = {
      fetch: server.fetch,
      isOnline: () => online.value,
      retry: { jitter: false },
    }

    // Page 1: one read cached, then two writes queued while offline.
    const page1 = createOajax({ ...base, storage: storageFor(), autoStart: false })
    await page1('/api/profile')
    online.value = false
    await page1({ url: '/api/notes', method: 'POST', body: { n: 1 } })
    await page1({ url: '/api/notes', method: 'POST', body: { n: 2 } })
    const keys = (await page1.outbox.list()).map((i) => i.idempotencyKey)
    page1.stop()

    // "Reload": a fresh client, same storage, still offline.
    const page2 = createOajax({ ...base, storage: storageFor(), autoStart: false })
    expect(await page2.outbox.size()).toBe(2)
    await expect(page2('/api/profile')).resolves.toMatchObject({ fromCache: true, data: { url: '/api/profile' } })

    // Back online: starting the new client replays what page 1 left behind.
    online.value = true
    let drained = false
    page2.on('drained', () => (drained = true))
    page2.start()
    await until(() => drained)
    const posts = server.seen.filter((s) => s.method === 'POST')
    expect(posts.map((p) => p.body)).toEqual(['{"n":1}', '{"n":2}'])
    expect(posts.map((p) => p.headers['idempotency-key'])).toEqual(keys)
    page2.stop()
  })
})

describe('storage adapters', () => {
  it('auto picks IndexedDB when it is available', async () => {
    const auto = createAutoStorage(`auto-${++dbCount}`) as StorageAdapter & { resolve(): Promise<StorageAdapter> }
    expect((await auto.resolve()).kind).toBe('indexeddb')
    await auto.set('k', { a: 1 })
    expect(await auto.get('k')).toEqual({ a: 1 })
  })

  it('keys(prefix) only returns matching keys', async () => {
    for (const s of [createMemoryStorage(), createLocalStorage(`k-${++dbCount}`), createIndexedDBStorage(`k-${++dbCount}`)]) {
      await s.set('outbox:1', 1)
      await s.set('outbox:2', 2)
      await s.set('cache:x', 3)
      await s.set('cachemeta:x', 4)
      expect((await s.keys('outbox:')).sort()).toEqual(['outbox:1', 'outbox:2'])
      expect(await s.keys('cache:')).toEqual(['cache:x'])
      await s.delete('outbox:1')
      expect(await s.get('outbox:1')).toBeUndefined()
    }
  })
})

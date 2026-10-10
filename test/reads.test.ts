import { describe, expect, it } from 'vitest'
import { OajaxHttpError, OajaxNetworkError, OajaxTimeoutError } from '../src/errors'
import { json, setup } from './helpers'

describe('reads (GET / HEAD)', () => {
  it('serves the cached copy when the network fails (network-first)', async () => {
    const { client, server } = setup({}, () => json({ items: [1, 2] }))
    const live = await client('/api/items')
    expect(live).toMatchObject({ queued: false, fromCache: false, status: 200, data: { items: [1, 2] } })

    server.down = true
    const offline = await client('/api/items')
    expect(offline).toMatchObject({ queued: false, fromCache: true, status: 200, data: { items: [1, 2] } })
    expect(offline.queued === false && typeof offline.storedAt).toBe('number')
  })

  it('rejects with OajaxNetworkError when offline and nothing is cached', async () => {
    const { client, server } = setup()
    server.down = true
    const err = await client('/api/none').catch((e) => e)
    expect(err).toBeInstanceOf(OajaxNetworkError)
    expect((err as OajaxNetworkError).cause).toBeInstanceOf(TypeError)
  })

  it('a 404 is a real answer: it rejects with OajaxHttpError and never falls back', async () => {
    let n = 0
    const { client } = setup({}, () => (++n === 1 ? json({ v: 1 }) : json({ message: 'gone' }, 404)))
    await client('/api/thing')
    const err = await client('/api/thing').catch((e) => e)
    expect(err).toBeInstanceOf(OajaxHttpError)
    expect(err).toMatchObject({ status: 404, data: { message: 'gone' } })
  })

  it('a retryable status (503) falls back to the cache', async () => {
    let n = 0
    const { client } = setup({}, () => (++n === 1 ? json({ v: 1 }) : json({}, 503)))
    await client('/api/thing')
    const r = await client('/api/thing')
    expect(r).toMatchObject({ fromCache: true, data: { v: 1 } })
  })

  it('cache-first answers from a fresh entry without touching the network', async () => {
    const { client, server } = setup({ strategy: 'cache-first' })
    await client('/api/a')
    expect(server.seen).toHaveLength(1)
    const r = await client('/api/a')
    expect(r).toMatchObject({ fromCache: true })
    expect(server.seen).toHaveLength(1)
  })

  it('network-only never answers from the cache', async () => {
    const { client, server } = setup()
    await client('/api/a')
    server.down = true
    await expect(client({ url: '/api/a', strategy: 'network-only' })).rejects.toBeInstanceOf(OajaxNetworkError)
  })

  it('cache: false skips the cache for that request', async () => {
    const { client, server } = setup()
    await client({ url: '/api/a', cache: false })
    server.down = true
    await expect(client('/api/a')).rejects.toBeInstanceOf(OajaxNetworkError)
  })

  it('serves the cache without trying the network when the browser reports offline', async () => {
    const { client, server, online } = setup()
    await client('/api/a')
    online.value = false
    const r = await client('/api/a')
    expect(r).toMatchObject({ fromCache: true })
    expect(server.seen).toHaveLength(1)
  })

  it('expires entries after maxAge', async () => {
    let t = 1_000_000
    const { client, server } = setup({ now: () => t, cache: { maxAge: 1000 } })
    await client('/api/a')
    server.down = true
    t += 999
    await expect(client('/api/a')).resolves.toMatchObject({ fromCache: true })
    t += 2
    await expect(client('/api/a')).rejects.toBeInstanceOf(OajaxNetworkError)
  })

  it('keeps at most maxEntries, dropping the oldest', async () => {
    let t = 0
    const { client, server } = setup({ now: () => ++t, cache: { maxEntries: 2 } })
    await client('/a')
    await client('/b')
    await client('/c')
    server.down = true
    await expect(client('/a')).rejects.toBeInstanceOf(OajaxNetworkError)
    await expect(client('/b')).resolves.toMatchObject({ fromCache: true })
    await expect(client('/c')).resolves.toMatchObject({ fromCache: true })
  })

  it('keys the cache by method, url and params', async () => {
    const { client, server } = setup({}, (req) => json({ url: req.url }))
    await client({ url: '/search', params: { q: 'one' } })
    await client({ url: '/search', params: { q: 'two' } })
    expect(server.seen.map((s) => s.url)).toEqual(['/search?q=one', '/search?q=two'])
    server.down = true
    await expect(client({ url: '/search', params: { q: 'one' } })).resolves.toMatchObject({ data: { url: '/search?q=one' } })
    await expect(client({ url: '/search', params: { q: 'two' } })).resolves.toMatchObject({ data: { url: '/search?q=two' } })
    await expect(client({ url: '/search', method: 'HEAD', params: { q: 'one' } })).rejects.toBeInstanceOf(
      OajaxNetworkError,
    )
  })

  it('cache.delete and cache.clear remove entries', async () => {
    const { client, server } = setup()
    await client('/a')
    await client('/b')
    await client.cache.delete('/a')
    server.down = true
    await expect(client('/a')).rejects.toBeInstanceOf(OajaxNetworkError)
    await expect(client('/b')).resolves.toMatchObject({ fromCache: true })
    await client.cache.clear()
    await expect(client('/b')).rejects.toBeInstanceOf(OajaxNetworkError)
  })

  it('does not cache binary responses', async () => {
    const { client, server } = setup({}, () => new Response('xx', { headers: { 'content-type': 'image/png' } }))
    await client('/logo.png')
    server.down = true
    await expect(client('/logo.png')).rejects.toBeInstanceOf(OajaxNetworkError)
  })

  it('parses JSON only when asked or when the server says JSON', async () => {
    const { client } = setup({}, () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain' } }))
    await expect(client('/t')).resolves.toMatchObject({ data: '{"a":1}' })
    await expect(client({ url: '/t', responseType: 'json' })).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('a timeout falls back to the cache, or rejects with OajaxTimeoutError', async () => {
    let slow = false
    const { client } = setup({ timeout: 20 }, async (_req) => {
      if (slow) await new Promise((r) => setTimeout(r, 200))
      return json({ v: 1 })
    })
    await client('/a')
    slow = true
    await expect(client('/a')).resolves.toMatchObject({ fromCache: true })
    await expect(client('/b')).rejects.toBeInstanceOf(OajaxTimeoutError)
  })

  it('a caller abort is passed through, not hidden by the cache', async () => {
    const { client } = setup()
    await client('/a')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(client({ url: '/a', signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

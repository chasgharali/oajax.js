import { afterEach, describe, expect, it, vi } from 'vitest'
import { OajaxHttpError, OajaxNetworkError } from '../src/errors'
import type { OajaxEvents } from '../src/types'
import { json, setup, until } from './helpers'

afterEach(() => {
  vi.useRealTimers()
})

describe('writes and the outbox', () => {
  it('sends normally when the network is up', async () => {
    const { client, server } = setup()
    const r = await client({ url: '/notes', method: 'POST', body: { text: 'hi' } })
    expect(r).toMatchObject({ queued: false, status: 200, data: { method: 'POST', body: '{"text":"hi"}' } })
    expect(server.seen[0]!.headers['content-type']).toBe('application/json')
    expect(server.seen[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(await client.outbox.size()).toBe(0)
  })

  it('queues a write on a network error and resolves with { queued: true, id }', async () => {
    const { client, server } = setup()
    const events: OajaxEvents['queued'][] = []
    client.on('queued', (e) => events.push(e))
    server.down = true

    const r = await client({ url: '/notes', method: 'POST', body: { text: 'hi' }, meta: { localId: 7 } })
    expect(r).toMatchObject({ queued: true })
    if (!r.queued) throw new Error('expected queued')
    expect(r.id).toEqual(expect.any(String))

    const [item] = await client.outbox.list()
    expect(item).toMatchObject({
      id: r.id,
      method: 'POST',
      url: '/notes',
      body: '{"text":"hi"}',
      attempts: 1,
      idempotencyKey: r.idempotencyKey,
      meta: { localId: 7 },
    })
    expect(item!.lastError).toContain('Failed to fetch')
    expect(events).toHaveLength(1)
    expect(events[0]!.item.id).toBe(r.id)
  })

  it('queues without trying when the browser reports offline', async () => {
    const { client, server, online } = setup()
    online.value = false
    const r = await client({ url: '/notes', method: 'PUT', body: 'x' })
    expect(r.queued).toBe(true)
    expect(server.seen).toHaveLength(0)
    expect((await client.outbox.list())[0]!.attempts).toBe(0)
  })

  it('queues a new write behind waiting ones, even when the network is back', async () => {
    const { client, server } = setup()
    server.down = true
    await client({ url: '/a', method: 'POST', body: '1' })
    server.down = false
    const r = await client({ url: '/b', method: 'POST', body: '2' })
    expect(r.queued).toBe(true)
    expect(server.seen).toHaveLength(1) // only the first, failed attempt
    expect((await client.outbox.list()).map((i) => i.url)).toEqual(['/a', '/b'])
  })

  it('queue: false rejects instead of queueing', async () => {
    const { client, server } = setup()
    server.down = true
    await expect(client({ url: '/a', method: 'POST', body: '1', queue: false })).rejects.toBeInstanceOf(
      OajaxNetworkError,
    )
    expect(await client.outbox.size()).toBe(0)
  })

  it('a write with a body that cannot be stored (FormData) rejects instead of queueing', async () => {
    const { client, server } = setup()
    server.down = true
    const form = new FormData()
    form.append('a', '1')
    await expect(client({ url: '/upload', method: 'POST', body: form })).rejects.toBeInstanceOf(OajaxNetworkError)
    expect(await client.outbox.size()).toBe(0)
  })

  it('a 4xx answer to a live write rejects and is not queued', async () => {
    const { client } = setup({}, () => json({ error: 'bad' }, 422))
    const err = await client({ url: '/a', method: 'POST', body: '{}' }).catch((e) => e)
    expect(err).toBeInstanceOf(OajaxHttpError)
    expect(err).toMatchObject({ status: 422, data: { error: 'bad' } })
  })

  it('a 503 answer to a live write is queued', async () => {
    const { client } = setup({}, () => json({}, 503))
    await expect(client({ url: '/a', method: 'DELETE' })).resolves.toMatchObject({ queued: true })
  })

  it('replays queued writes in order when the online event fires', async () => {
    const { client, server, online } = setup({ autoStart: true })
    online.value = false
    for (const n of [1, 2, 3]) await client({ url: `/notes/${n}`, method: 'POST', body: { n } })
    expect(server.seen).toHaveLength(0)

    const replayed: string[] = []
    let drained = 0
    client.on('replayed', (e) => replayed.push(e.item.url))
    client.on('drained', (e) => (drained = e.replayed))

    online.value = true
    window.dispatchEvent(new Event('online'))
    await until(() => drained === 3)

    expect(server.seen.map((s) => s.url)).toEqual(['/notes/1', '/notes/2', '/notes/3'])
    expect(replayed).toEqual(['/notes/1', '/notes/2', '/notes/3'])
    expect(await client.outbox.size()).toBe(0)
    client.stop()
  })

  it('stops the batch at the first failure so later writes never overtake it', async () => {
    const { client, server, online } = setup()
    online.value = false
    for (const n of [1, 2, 3]) await client({ url: `/n/${n}`, method: 'POST', body: String(n) })
    online.value = true
    server.handler = (req) => (req.url === '/n/2' ? 'network-error' : json({ ok: true }))

    const failed: OajaxEvents['failed'][] = []
    client.on('failed', (e) => failed.push(e))
    const result = await client.flush()

    expect(result).toEqual({ replayed: 1, failed: 1, dead: 0, pending: 2 })
    expect(server.seen.map((s) => s.url)).toEqual(['/n/1', '/n/2']) // /n/3 was not tried
    expect((await client.outbox.list()).map((i) => i.url)).toEqual(['/n/2', '/n/3'])
    expect(failed[0]!.item).toMatchObject({ url: '/n/2', attempts: 1 })

    server.handler = () => json({ ok: true })
    await client.flush()
    expect(server.seen.map((s) => s.url)).toEqual(['/n/1', '/n/2', '/n/2', '/n/3'])
  })

  it('a non-retryable rejection during replay goes to the dead-letter list and the batch continues', async () => {
    const { client, online, server } = setup()
    online.value = false
    await client({ url: '/bad', method: 'POST', body: '1' })
    await client({ url: '/good', method: 'POST', body: '2' })
    online.value = true
    server.handler = (req) => (req.url === '/bad' ? json({ error: 'invalid' }, 400) : json({ ok: true }))
    const dead: OajaxEvents['dead'][] = []
    client.on('dead', (e) => dead.push(e))

    expect(await client.flush()).toEqual({ replayed: 1, failed: 0, dead: 1, pending: 0 })
    expect(dead[0]!.item).toMatchObject({ url: '/bad', reason: 'rejected', status: 400 })
    expect((await client.outbox.dead()).map((d) => d.url)).toEqual(['/bad'])
  })

  it('retries with exponential backoff and moves the item to dead letters after maxAttempts', async () => {
    vi.useFakeTimers({ now: 0 })
    const { client, server } = setup({
      autoStart: true,
      retry: { baseDelay: 1000, maxAttempts: 4, jitter: false },
    })
    server.down = true
    const failedAt: number[] = []
    const nextAt: number[] = []
    client.on('failed', (e) => {
      failedAt.push(Date.now())
      nextAt.push(e.nextAttemptAt)
    })
    const dead: OajaxEvents['dead'][] = []
    client.on('dead', (e) => dead.push(e))

    await client({ url: '/a', method: 'POST', body: '1' }) // attempt 1 fails, queued
    expect((await client.outbox.list())[0]).toMatchObject({ attempts: 1, nextAttemptAt: 1000 })

    await vi.advanceTimersByTimeAsync(1000) // attempt 2 at t=1000, next in 2000
    await vi.advanceTimersByTimeAsync(2000) // attempt 3 at t=3000, next in 4000
    expect(failedAt).toEqual([1000, 3000])
    expect(nextAt).toEqual([3000, 7000])
    expect(dead).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(4000) // attempt 4 at t=7000 reaches maxAttempts
    expect(dead).toHaveLength(1)
    expect(dead[0]!.item).toMatchObject({ url: '/a', reason: 'max-attempts', attempts: 4 })
    expect(await client.outbox.size()).toBe(0)
    expect(server.seen).toHaveLength(4)

    // retryDead puts it back with attempts reset and the same idempotency key.
    server.down = false
    expect(await client.outbox.retryDead()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await client.outbox.dead()).toHaveLength(0)
    expect(await client.outbox.size()).toBe(0)
    expect(new Set(server.seen.map((s) => s.headers['idempotency-key'])).size).toBe(1)
    client.stop()
  })

  it('keeps the same Idempotency-Key on the first attempt and every retry', async () => {
    const { client, server } = setup()
    server.down = true
    const r = await client({ url: '/pay', method: 'POST', body: { amount: 5 } })
    if (!r.queued) throw new Error('expected queued')
    await client.flush()
    await client.flush()
    server.down = false
    await client.flush()
    const keys = server.seen.map((s) => s.headers['idempotency-key'])
    expect(keys).toHaveLength(4)
    expect(new Set(keys)).toEqual(new Set([r.idempotencyKey]))
  })

  it('uses a caller-supplied idempotency key and header name', async () => {
    const { client, server } = setup({ idempotencyHeader: 'X-Request-Id' })
    server.down = true
    const r = await client({ url: '/a', method: 'POST', body: '1', idempotencyKey: 'order-42' })
    expect(r).toMatchObject({ queued: true, idempotencyKey: 'order-42' })
    expect(server.seen[0]!.headers['x-request-id']).toBe('order-42')
    expect(server.seen[0]!.headers['idempotency-key']).toBeUndefined()
  })

  it('prepareReplay can add a fresh auth header at replay time', async () => {
    const { client, server, online } = setup({
      prepareReplay: (req) => ({ ...req, headers: { ...req.headers, authorization: 'Bearer fresh' } }),
    })
    online.value = false
    await client({ url: '/a', method: 'POST', body: '1' })
    expect((await client.outbox.list())[0]!.headers.authorization).toBeUndefined()
    online.value = true
    await client.flush()
    expect(server.seen[0]!.headers.authorization).toBe('Bearer fresh')
  })

  it('discard and clear remove waiting writes', async () => {
    const { client, online } = setup()
    online.value = false
    const a = await client({ url: '/a', method: 'POST', body: '1' })
    await client({ url: '/b', method: 'POST', body: '2' })
    if (!a.queued) throw new Error('expected queued')
    expect(await client.outbox.discard(a.id)).toBe(true)
    expect(await client.outbox.discard(a.id)).toBe(false)
    expect((await client.outbox.list()).map((i) => i.url)).toEqual(['/b'])
    await client.outbox.clear()
    expect(await client.outbox.size()).toBe(0)
  })

  it('a throwing listener does not break replay', async () => {
    const { client, server, online } = setup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    online.value = false
    await client({ url: '/a', method: 'POST', body: '1' })
    online.value = true
    client.on('replayed', () => {
      throw new Error('boom')
    })
    await expect(client.flush()).resolves.toMatchObject({ replayed: 1 })
    expect(server.seen).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
  })
})

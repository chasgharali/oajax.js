import { describe, expect, it, vi } from 'vitest'
import { createAjax, installJQuery, param, toRequest } from '../src/jquery'
import { json, setup, until } from './helpers'

function track() {
  const calls: { name: string; args: unknown[] }[] = []
  const cb =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push({ name, args })
  return { calls, success: cb('success'), error: cb('error'), complete: cb('complete'), queued: cb('queued') }
}

describe('oajax.js/jquery', () => {
  it('calls success(data, textStatus, xhr) then complete', async () => {
    const { client } = setup({}, () => json({ id: 1 }))
    const $oajax = createAjax(client)
    const t = track()
    const xhr = $oajax({ url: '/api/item', success: t.success, error: t.error, complete: t.complete })
    await until(() => t.calls.length === 2)
    expect(t.calls.map((c) => c.name)).toEqual(['success', 'complete'])
    expect(t.calls[0]!.args.slice(0, 2)).toEqual([{ id: 1 }, 'success'])
    expect(xhr.status).toBe(200)
    expect(xhr.responseJSON).toEqual({ id: 1 })
    expect(xhr.getResponseHeader('Content-Type')).toBe('application/json')
  })

  it('calls error, not success, when a request fails (the v1 bug)', async () => {
    const { client, server } = setup()
    server.down = true
    const t = track()
    createAjax(client)({ url: '/api/nothing-cached', success: t.success, error: t.error, complete: t.complete })
    await until(() => t.calls.length === 2)
    expect(t.calls.map((c) => c.name)).toEqual(['error', 'complete'])
    expect(t.calls[0]!.args[1]).toBe('error')
  })

  it('reports an HTTP error with the status on the xhr', async () => {
    const { client } = setup({}, () => json({ message: 'no' }, 404))
    const t = track()
    createAjax(client)({ url: '/x', success: t.success, error: t.error })
    await until(() => t.calls.length === 1)
    const [xhr, status] = t.calls[0]!.args as [{ status: number; responseJSON: unknown }, string]
    expect(t.calls[0]!.name).toBe('error')
    expect(status).toBe('error')
    expect(xhr.status).toBe(404)
    expect(xhr.responseJSON).toEqual({ message: 'no' })
  })

  it('serves the cached copy through success when offline, flagged on the xhr', async () => {
    const { client, server } = setup({}, () => json({ v: 1 }))
    const $oajax = createAjax(client)
    await $oajax({ url: '/a' })
    server.down = true
    const t = track()
    const xhr = $oajax({ url: '/a', success: t.success, error: t.error })
    await until(() => t.calls.length === 1)
    expect(t.calls[0]!.name).toBe('success')
    expect(t.calls[0]!.args[0]).toEqual({ v: 1 })
    expect(xhr.fromCache).toBe(true)
  })

  it('a queued write goes to error with textStatus "queued" when there is no queued callback', async () => {
    const { client, server } = setup()
    server.down = true
    const t = track()
    const xhr = createAjax(client)({ url: '/a', type: 'POST', data: { a: 1 }, success: t.success, error: t.error })
    await until(() => t.calls.length === 1)
    expect(t.calls[0]!.name).toBe('error')
    expect(t.calls[0]!.args[1]).toBe('queued')
    expect(xhr.queued).toMatchObject({ queued: true })
    await expect(Promise.resolve(xhr)).rejects.toBe(xhr)
  })

  it('a queued write calls queued (and not error) when given, and the promise resolves', async () => {
    const { client, server } = setup()
    server.down = true
    const t = track()
    const xhr = createAjax(client)({ url: '/a', type: 'POST', data: 'x=1', error: t.error, queued: t.queued })
    await expect(Promise.resolve(xhr)).resolves.toMatchObject({ queued: true })
    await until(() => t.calls.length === 1)
    expect(t.calls.map((c) => c.name)).toEqual(['queued'])
  })

  it('done / fail / always and then work like a jqXHR', async () => {
    const { client } = setup({}, () => json({ ok: 1 }))
    const done = vi.fn()
    const always = vi.fn()
    const data = await createAjax(client)('/a').done(done).always(always)
    expect(data).toEqual({ ok: 1 })
    await until(() => done.mock.calls.length === 1 && always.mock.calls.length === 1)
    expect(done.mock.calls[0]![0]).toEqual({ ok: 1 })

    const fail = vi.fn()
    const { client: down, server } = setup()
    server.down = true
    createAjax(down)('/b').fail(fail)
    await until(() => fail.mock.calls.length === 1)
    expect(fail.mock.calls[0]![1]).toBe('error')
  })

  it('runs callbacks with context as this', async () => {
    const { client } = setup()
    const ctx = { name: 'ctx' }
    let seen: unknown
    createAjax(client)({
      url: '/a',
      context: ctx,
      success(this: unknown) {
        seen = this
      },
    })
    await until(() => seen !== undefined)
    expect(seen).toBe(ctx)
  })

  it('maps jQuery options: data as query for GET, form body for POST, JSON when contentType says so', () => {
    expect(toRequest({ url: '/s?x=1', data: { q: 'a b', tags: ['x', 'y'] } }).url).toBe(
      '/s?x=1&q=a%20b&tags%5B%5D=x&tags%5B%5D=y',
    )
    expect(toRequest({ url: '/p', type: 'post', data: { a: 1, o: { b: 2 } } })).toMatchObject({
      method: 'POST',
      body: 'a=1&o%5Bb%5D=2',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    })
    expect(
      toRequest({ url: '/p', method: 'PUT', data: { a: 1 }, contentType: 'application/json', dataType: 'json', cache: false }),
    ).toMatchObject({ method: 'PUT', body: '{"a":1}', responseType: 'json', cache: false })
    expect(param([{ name: 'a', value: '1' }])).toBe('a=1')
  })

  it('installJQuery adds $.oajax, optionally patches $.ajax, and undoes it', async () => {
    const original = vi.fn()
    const $ = { ajax: original } as { ajax: (...a: unknown[]) => unknown; oajax?: unknown }
    const { client } = setup()
    const undo = installJQuery($, { client, patchAjax: true })
    expect(typeof $.oajax).toBe('function')
    expect($.ajax).not.toBe(original)
    const data = await ($.ajax as (s: object) => PromiseLike<unknown>)({ url: '/a' })
    expect(data).toMatchObject({ ok: true })
    expect(original).not.toHaveBeenCalled()
    undo()
    expect($.ajax).toBe(original)
    expect('oajax' in $).toBe(false)
  })

  it('accepts the $.ajax(url, settings) signature', async () => {
    const { client, server } = setup()
    await createAjax(client)('/a', { type: 'DELETE' })
    expect(server.seen[0]).toMatchObject({ method: 'DELETE', url: '/a' })
  })
})

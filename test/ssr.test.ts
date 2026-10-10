// @vitest-environment node
import { describe, expect, it } from 'vitest'

describe('server rendering', () => {
  it('imports and creates clients without touching browser globals', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
    const mod = await import('../src/index')
    const jq = await import('../src/jquery')
    expect(typeof mod.oajax).toBe('function')
    expect(typeof jq.$oajax).toBe('function')

    // No window, so no auto-start; memory storage works on the server.
    const client = mod.createOajax({
      storage: 'memory',
      fetch: (async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    await expect(client('https://example.test/a')).resolves.toMatchObject({ data: { ok: true } })
  })

  it('auto storage falls back to memory when there is no IndexedDB or localStorage', async () => {
    const { createAutoStorage } = await import('../src/storage/auto')
    const s = createAutoStorage('ssr') as ReturnType<typeof createAutoStorage> & { resolve(): Promise<{ kind: string }> }
    expect((await s.resolve()).kind).toBe('memory')
  })
})

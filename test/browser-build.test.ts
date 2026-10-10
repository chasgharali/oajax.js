import { describe, expect, it } from 'vitest'

describe('script-tag entry', () => {
  it('defines window.oajax, window.$oajax and jQuery.oajax', async () => {
    const g = globalThis as Record<string, any>
    const fakeJQuery = { ajax: () => undefined }
    g.jQuery = fakeJQuery
    try {
      await import('../src/browser')
      expect(typeof g.oajax).toBe('function')
      expect(typeof g.oajax.createOajax).toBe('function')
      expect(typeof g.oajax.installJQuery).toBe('function')
      expect(g.oajax.version).toBe('2.0.0')
      expect(typeof g.$oajax).toBe('function')
      expect(typeof (fakeJQuery as Record<string, unknown>).oajax).toBe('function')
    } finally {
      delete g.jQuery
      delete g.oajax
      delete g.$oajax
    }
  })
})

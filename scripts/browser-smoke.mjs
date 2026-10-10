// Real-browser smoke test (not part of npm test): npm run build, then
// npx -y -p playwright@1.48.2 node scripts/browser-smoke.mjs  (needs: npx playwright install chromium webkit)
import { chromium, webkit } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
const log = []
const srv = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type','text/html'); return res.end('<!doctype html><script src="/oajax.min.js"></script>') }
  if (req.url === '/oajax.min.js') { res.setHeader('content-type','text/javascript'); return res.end(fs.readFileSync(new URL('../dist/oajax.min.js', import.meta.url))) }
  let body=''; req.on('data', c => body += c); req.on('end', () => {
    if (req.method !== 'GET') log.push({ m: req.method, body, key: req.headers['idempotency-key'] })
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true, n: log.length, at: Date.now() }))
  })
}).listen(3591)
for (const [name, eng] of [['chromium', chromium], ['webkit', webkit]]) {
  log.length = 0
  const b = await eng.launch(); const ctx = await b.newContext(); const p = await ctx.newPage()
  await p.goto('http://localhost:3591/')
  const r1 = await p.evaluate(async () => { const api = window.oajax.createOajax({ name: 'test' }); window.api = api; const r = await api('/api/notes'); return { queued: r.queued, fromCache: r.fromCache, data: r.data } })
  await ctx.setOffline(true)
  const r2 = await p.evaluate(async () => { const r = await window.api('/api/notes'); return { fromCache: r.fromCache, online: navigator.onLine } })
  const r3 = await p.evaluate(async () => { const a = await window.api({ url: '/api/notes', method: 'POST', body: { text: 'one' } }); const b = await window.api({ url: '/api/notes', method: 'POST', body: { text: 'two' } }); return [a.queued, b.queued] })
  const sentWhileOffline = log.length
  // simulate reload while offline: new page, same storage
  await p.reload().catch(()=>{})
  await ctx.setOffline(false)
  await p.goto('http://localhost:3591/')
  await p.evaluate(async () => { window.api = window.oajax.createOajax({ name: 'test' }); await window.api.flush() })
  await p.waitForTimeout(1500)
  console.log(name, JSON.stringify({ r1, r2, r3, sentWhileOffline, replayed: log.map(x => x.body + ' key:' + (x.key||'').slice(0,8)) }))
  await b.close()
}
srv.close()

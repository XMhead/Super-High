import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { ensureEmbeddedMobileUi } from './superhigh-html.mjs'
import { createDesktopPreviewOptions } from './superhigh-desktop-preview.mjs'

test('desktop preview data supports sandboxed origin without opening other origins', async () => {
  let middleware
  const plugin = createDesktopPreviewOptions(process.cwd()).plugins[0]
  plugin.configureServer({ middlewares: { use(_path, handler) { middleware = handler } } })
  async function request(origin) {
    const headers = {}
    const response = { setHeader(name, value) { headers[name] = value }, end(body) { this.body = body } }
    await middleware({ url: '/info', headers: { origin } }, response)
    return { headers, body: JSON.parse(response.body) }
  }
  const sandboxed = await request('null')
  assert.equal(sandboxed.headers['Access-Control-Allow-Origin'], 'null')
  assert.ok(sandboxed.body.rootPath)
  assert.equal((await request('https://example.com')).headers['Access-Control-Allow-Origin'], undefined)
})

test('embedded mobile preview creates or reuses its IUI without overwriting edits', async t => {
  const tempRoot = await realpath(tmpdir())
  const workspace = await realpath(await mkdtemp(join(tempRoot, 'superhigh-embed-test-')))
  assert.ok(workspace.startsWith(`${tempRoot}${sep}`))
  t.after(async () => { await rm(workspace, { recursive: true, force: true }) })
  const path = await ensureEmbeddedMobileUi(workspace)
  const original = await readFile(path, 'utf8')
  assert.match(original, /Editor\(src: "http:\/\/127\.0\.0\.1:1421\/"/)
  assert.equal(await ensureEmbeddedMobileUi(workspace), path)
  await writeFile(path, 'root = Text("user edit")\n')
  await assert.rejects(ensureEmbeddedMobileUi(workspace), /IUI 已修改，未覆盖/)
  assert.equal(await readFile(path, 'utf8'), 'root = Text("user edit")\n')
})

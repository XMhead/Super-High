import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

test('DSH plugin cards show source and follow host theme', async () => {
  const dom = new JSDOM('<!doctype html><html><head><style>body { --dsw-alias-bg-base: #151517; --dsw-specific-sidebar-fill: #1b1b1c; }</style></head><body><ul><li data-plugin-module="@deepseek-ai/dsh-agent-instructions" data-open="true"></li></ul></body></html>', { runScripts: 'dangerously', url: 'http://127.0.0.1:1234/' })
  const { window } = dom
  let request
  window.HTMLAnchorElement.prototype.click = function () { request = new URL(this.href) }
  window.eval(await readFile(new URL('./dsh_integration.js', import.meta.url), 'utf8'))
  window.__superhighDshSetTheme({ colorScheme: 'light', vars: { '--color-bg-primary': 'rgba(30, 30, 46, 0.74)', '--color-bg-secondary': 'rgba(24, 24, 37, 0.86)', '--color-text-primary': '#112233', '--font-ui': 'test-font' } })
  await new Promise(resolve => window.setTimeout(resolve, 0))
  assert.equal(window.document.documentElement.style.getPropertyValue('--dsw-alias-bg-base'), 'rgb(30, 30, 46)')
  assert.equal(window.getComputedStyle(window.document.body).getPropertyValue('--dsw-alias-bg-base'), 'rgb(30, 30, 46)')
  assert.equal(window.getComputedStyle(window.document.body).getPropertyValue('--dsw-specific-sidebar-fill'), 'rgb(24, 24, 37)')
  assert.equal(window.document.body.hasAttribute('data-ds-dark-theme'), false)
  assert.equal(window.document.documentElement.style.getPropertyValue('--dsw-alias-label-primary'), '#112233')
  const buttons = window.document.querySelectorAll('.superhigh-dsh-actions button')
  assert.equal(buttons.length, 2)
  buttons[0].click()
  assert.equal(request.searchParams.get('module'), '@deepseek-ai/dsh-agent-instructions')
  assert.equal(request.searchParams.get('action'), 'preview')
  const output = window.document.querySelector('.superhigh-dsh-source')
  window.__superhighDshResult({ request: request.searchParams.get('request'), result: { path: 'C:/plugin/lib/index.js', source: '<script>example</script>' } })
  assert.match(output.textContent, /<script>example<\/script>/)
  assert.equal(output.querySelector('script'), null)
  buttons[0].click()
  assert.equal(output.hidden, true)
  buttons[1].click()
  assert.equal(request.searchParams.get('action'), 'directory')
  window.__superhighDshResult({ request: request.searchParams.get('request'), error: '未找到目录' })
  assert.equal(window.document.querySelector('.superhigh-dsh-status').textContent, '未找到目录')
  assert.match(output.textContent, /<script>example<\/script>/)
  window.__superhighDshSetTheme({ colorScheme: 'dark', vars: { '--color-bg-primary': '#111111' } })
  assert.equal(window.document.documentElement.style.getPropertyValue('--dsw-alias-bg-base'), '#111111')
  assert.equal(window.getComputedStyle(window.document.body).getPropertyValue('--dsw-alias-bg-base'), '#111111')
  assert.equal(window.document.body.hasAttribute('data-ds-dark-theme'), true)
})

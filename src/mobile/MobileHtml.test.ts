import { createApp, nextTick } from 'vue'
import { expect, it, vi } from 'vitest'
import { MobileHostApi } from '@/lib/hostApi'
import MobileHtml from './MobileHtml.vue'

it('sends structured-cloneable theme and context data from reactive state to the sandbox', async () => {
  vi.spyOn(MobileHostApi.prototype, 'view').mockResolvedValue({ document: '<p>HTML</p>', contextMessages: [{ type: 'superhigh-editor:theme', vars: { '--color-text-primary': '#fff' } }] })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(MobileHtml, { api: new MobileHostApi({ baseUrl: 'http://host', token: 'test' }), root: 'D:/project', path: 'D:/project/a.html', revision: 1 })
  try {
    app.mount(root)
    for (let i = 0; i < 5; i++) await nextTick()
    const frame = root.querySelector('iframe')!
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(data => { structuredClone(data) })
    frame.dispatchEvent(new Event('load'))
    expect(post).toHaveBeenCalledWith({ type: 'superhigh-editor:theme', vars: { '--color-text-primary': '#fff' } }, '*')
  } finally { app.unmount(); root.remove(); vi.restoreAllMocks() }
})

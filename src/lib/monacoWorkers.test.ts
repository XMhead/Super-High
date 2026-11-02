import { expect, it, vi } from 'vitest'
import { initializeMonacoWorkers } from './monacoWorkers'
const workers = vi.hoisted(() => ({ editor: vi.fn(), ts: vi.fn(), json: vi.fn(), css: vi.fn(), html: vi.fn() }))
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: workers.editor }))
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: workers.ts }))
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: workers.json }))
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: workers.css }))
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: workers.html }))
it('routes editor and language services to real ESM worker constructors', () => {
  const route = initializeMonacoWorkers().getWorker!
  for (const label of ['typescript', 'javascript']) route('', label)
  route('', 'json')
  for (const label of ['css', 'scss', 'less']) route('', label)
  for (const label of ['html', 'handlebars', 'razor']) route('', label)
  route('', 'editorWorkerService')
  expect(workers.ts).toHaveBeenCalledTimes(2)
  expect(workers.json).toHaveBeenCalledTimes(1)
  expect(workers.css).toHaveBeenCalledTimes(3)
  expect(workers.html).toHaveBeenCalledTimes(3)
  expect(workers.editor).toHaveBeenCalledTimes(1)
})

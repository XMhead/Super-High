import type { Environment } from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

/** Register real ESM workers before either desktop entry loads Monaco. */
export function initializeMonacoWorkers(): Environment {
  const workerGlobal = globalThis as typeof globalThis & { MonacoEnvironment?: Environment }
  const environment: Environment = {
    ...workerGlobal.MonacoEnvironment,
    getWorker(_moduleId, label) {
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
      if (label === 'json') return new JsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
      return new EditorWorker()
    },
  }
  workerGlobal.MonacoEnvironment = environment
  return environment
}


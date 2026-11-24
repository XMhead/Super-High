import YamlSyntaxWorker from './yamlSyntax.worker?worker'
import type { YamlSyntaxIssue } from './yamlPreview'

export interface YamlSyntaxRequest {
  id: number
  text: string
}

export type YamlSyntaxResponse = { id: number; issues: YamlSyntaxIssue[] } | { id: number; error: string }

export function createYamlSyntaxAnalysis(createWorker: () => Worker = () => new YamlSyntaxWorker()) {
  let worker: Worker | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let busy = false

  function stopWorker() {
    worker?.terminate()
    worker = null
    busy = false
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    schedule(text: string, accept: (issues: YamlSyntaxIssue[]) => void, fail: (error: unknown) => void) {
      const id = ++generation
      clearTimer()
      const delay = text.length >= 1024 * 1024 ? 1000 : text.length >= 256 * 1024 ? 500 : 160
      timer = setTimeout(() => {
        timer = null
        if (busy) stopWorker()
        try {
          worker ??= createWorker()
          const current = worker
          const failed = (error: unknown) => {
            if (current !== worker) return
            stopWorker()
            if (id === generation) fail(error)
          }
          current.onerror = failed
          current.onmessageerror = failed
          current.onmessage = (event: MessageEvent<YamlSyntaxResponse>) => {
            if (current !== worker || event.data.id !== id) return
            busy = false
            if (id !== generation) return
            if ('error' in event.data) failed(event.data.error)
            else accept(event.data.issues)
          }
          busy = true
          current.postMessage({ id, text } satisfies YamlSyntaxRequest)
        } catch (error) {
          stopWorker()
          if (id === generation) fail(error)
        }
      }, delay)
    },
    cancel() {
      generation += 1
      clearTimer()
      stopWorker()
    },
  }
}

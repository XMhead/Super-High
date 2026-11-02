/** Monaco change offsets refer to the document before the event. */
export function applyEditorContentChanges(content: string, changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]): string {
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    content = content.slice(0, change.rangeOffset) + change.text + content.slice(change.rangeOffset + change.rangeLength)
  }
  return content
}

/** Only the latest version is retained for each live model. */
export function createVersionCache<Model extends object>() {
  const models = new WeakMap<Model, { version: number; values: Map<string, unknown> }>()
  return {
    get<T>(model: Model, version: number, key: string, compute: () => T): T {
      let entry = models.get(model)
      if (!entry || entry.version !== version) {
        entry = { version, values: new Map() }
        models.set(model, entry)
      }
      if (!entry.values.has(key)) entry.values.set(key, compute())
      return entry.values.get(key) as T
    },
  }
}

export function createTrailingTask(run: () => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  function cancel() {
    clearTimeout(timer)
    timer = undefined
  }
  return {
    cancel,
    get pending() { return timer !== undefined },
    schedule() {
      cancel()
      timer = setTimeout(() => { timer = undefined; run() }, delay)
    },
  }
}

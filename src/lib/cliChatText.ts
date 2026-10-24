/** Native CLI logs can contain terminal styling. Remove it before Markdown parsing. */
export function cleanCliChatText(text: string): string {
  return text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** A local /model command need not generate an assistant record with a model field. */
export function modelFromCommandOutput(answer: string): string | undefined {
  const text = cleanCliChatText(answer)
  const changes = [...text.matchAll(/(?:Model changed to\s+([^\r\n]+)|Set model to\s+(.+?)\s+and saved\b)/gi)]
  const value = changes.at(-1)?.slice(1).find(Boolean)?.replace(/`/g, '').trim()
  return value ? concreteModelOption(value) : undefined
}

export function modelFromScreen(lines: { text: string }[], currentOnly = false): string | undefined {
  // The current status line wins over old startup banners and earlier /model output.
  const rows = lines.map(({ text }) => cleanCliChatText(text))
  const latest = [...rows].reverse()
  for (const text of latest) {
    const status = text.match(/^\s*(?:[│┃]\s*)?((?:gpt|o\d|codex|claude|gemini|deepseek|qwen|kimi|grok)[\w.\-[\]]*(?:\s+(?:with\s+)?(?:none|minimal|low|medium|high|xhigh|extra high|max|maximum|ultra)(?:\s+effort)?)?)\s*[·•]\s*.+?\s*[·•]\s*(?:Context\b|\d+%)/i)
    if (status) return status[1]!.trim()
  }
  // Claude repaints its header after /model; old command output can remain below it.
  for (const text of latest) {
    const banner = text.match(/^\s*(.+?)\s*[·•]\s*(?:API Usage Billing|Claude (?:Pro|Max)|.*account)/i)
    if (banner) {
      const value = concreteModelOption(banner[1]!.replace(/^[\s\u2500-\u259f]+/u, '').trim())
      if (value) return value
    }
  }
  // The active picker row is newer than Codex's startup banner or old /model output.
  for (const text of latest) {
    const current = text.match(/^\s*[›❯>▶▸➤→]?\s*\d+[.)]\s+(.+?)\s+\(current\)(?:\s|$)/i)
    if (current) {
      const value = concreteModelOption(current[1]!)
      if (value) return value
    }
  }
  if (currentOnly) return undefined
  const changed = modelFromCommandOutput(rows.join('\n'))
  if (changed) return changed
  for (const text of latest) {
    const model = text.match(/\bmodel:\s*(.+?)(?:\s{2,}|$)/i)
    if (model) {
      const value = concreteModelOption(model[1]!.trim())
      if (value) return value
    }
  }
}

/** Claude describes the effective Default model in the option's detail. */
export function modelFromMenuOption(label: string, detail: string): string | undefined {
  return concreteModelOption(label) ?? (/^default\b/i.test(modelOptionLabel(label))
    ? concreteModelOption(detail.match(/\bcurrently\s+(.+)\)\s*$/i)?.[1] ?? '') : undefined)
}

/** Navigation rows and the CLI's Default alias do not identify an effective model. */
export function concreteModelOption(label: string): string | undefined {
  const value = modelOptionLabel(label)
  if (!value || reasoningOption(value) || /^(?:(?:default|custom)(?:\s+\([^)]*\))?$|more\s+reasoning(?:\b|…))/i.test(value)) return undefined
  return value
}

export function modelOptionLabel(label: string): string {
  return cleanCliChatText(label).replace(/\s*\((?:current|default)\)/gi, '').replace(/\s*[✓✔]\s*$/, '').trim()
}

/** The second Codex /model page selects effort, not another model. */
export function reasoningOption(label: string): string | undefined {
  const value = modelOptionLabel(label).toLowerCase()
  if (value === 'extra high') return 'xhigh'
  return /^(?:none|minimal|low|medium|high|xhigh|max|maximum|ultra)$/.test(value) ? value : undefined
}

export function modelWithReasoning(model: string, effort: string): string {
  if (!effort) return model
  return `${model.replace(/\s+(?:with\s+)?(?:none|minimal|low|medium|high|xhigh|extra high|max|maximum|ultra)(?:\s+effort)?$/i, '')} ${effort}`.trim()
}

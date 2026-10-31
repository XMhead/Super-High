import { expect, it } from 'vitest'
import { cleanCliChatText, concreteModelOption, modelFromCommandOutput, modelFromMenuOption, modelFromScreen, modelWithReasoning, reasoningOption } from './cliChatText'

it('renders native async reply envelopes as readable questions and answers', () => {
  const wrap = (body: string) => `<send_user_message_question_reply>\n${body}\n</send_user_message_question_reply>`
  expect(cleanCliChatText(wrap(JSON.stringify([
    { question: '颜色？', answer: '绿色；补充说明', questionItemId: 'internal-call-id' },
    { question: '备注？', answer: '详细' },
  ])))).toBe('颜色？\n回答：绿色；补充说明\n\n备注？\n回答：详细')
  expect(cleanCliChatText(wrap('{broken'))).toBe(wrap('{broken'))
  expect(cleanCliChatText(wrap('[{"question":"missing answer"}]'))).toBe(wrap('[{"question":"missing answer"}]'))
  expect(cleanCliChatText('ordinary [{"answer":"hi"}]')).toBe('ordinary [{"answer":"hi"}]')
})

it('removes nested styling and OSC hyperlinks while preserving Markdown and model context', () => {
  const answer = 'Set model to \u001b[1m`Claude Haiku 5.5`\u001b[22m and saved as your default for new sessions\u001b[2m\u001b[22m\n\u001b[2mANTHROPIC_MODEL is set to `Claude Opus 5.5[1M]`\u001b[22m'
  expect(cleanCliChatText(answer)).toBe('Set model to `Claude Haiku 5.5` and saved as your default for new sessions\nANTHROPIC_MODEL is set to `Claude Opus 5.5[1M]`')
  expect(modelFromCommandOutput(answer)).toBe('Claude Haiku 5.5')
  expect(cleanCliChatText('\u001b]8;;https://example.com\u0007link\u001b]8;;\u001b\\')).toBe('link')
  expect(cleanCliChatText('正常 [1M] \u009b2mdim\u009b22m')).toBe('正常 [1M] dim')
})

it('reads the active model from the native header before the first answer', () => {
  expect(modelFromScreen([{ text: '  Claude Haiku 5.5 · API Usage Billing' }])).toBe('Claude Haiku 5.5')
  expect(modelFromScreen([{ text: '▝▜██████▀  Claude Opus 5.5[1M] with xhigh effort · API Usage Billing' }])).toBe('Claude Opus 5.5[1M] with xhigh effort')
  expect(modelFromScreen([{ text: '│ model: gpt-6.1-sol high    /model to change │' }])).toBe('gpt-6.1-sol high')
})

it('reads the current Codex model without mistaking highlighted rows or effort for a model', () => {
  expect(modelFromScreen([{ text: '  1. GPT-6.1-Sol (current)  Latest workhorse model' }, { text: '› 2. GPT-6-Astra  Frontier intelligence' }])).toBe('GPT-6.1-Sol')
  expect(modelFromScreen([{ text: '› 2. Medium (current)  Default effort' }])).toBeUndefined()
  expect(reasoningOption('Medium (default)')).toBe('medium')
  expect(reasoningOption('Extra high')).toBe('xhigh')
  expect(reasoningOption('GPT-6.1-Sol (current)')).toBeUndefined()
  expect(modelWithReasoning('GPT-6.1-Sol high', 'medium')).toBe('GPT-6.1-Sol medium')
})

it('reads the live Codex footer and latest model change instead of an old banner', () => {
  const old = { text: '│ model: gpt-6-astra medium    /model to change │' }
  expect(modelFromScreen([old, { text: 'GPT-6.1-Sol high · D:\\demo · Context 0% used · private' }])).toBe('GPT-6.1-Sol high')
  expect(modelFromScreen([old, { text: '• Model changed to gpt-6-astra high' }, { text: '• Model changed to gpt-6.1-sol high' }])).toBe('gpt-6.1-sol high')
  expect(modelFromCommandOutput('Model changed to gpt-6-astra high\nModel changed to gpt-6.1-sol high')).toBe('gpt-6.1-sol high')
  expect(concreteModelOption('Default (recommended)')).toBeUndefined()
  expect(concreteModelOption('More reasoning…')).toBeUndefined()
})

it('prefers the repainted Claude header and active Codex picker over historical output', () => {
  expect(modelFromScreen([
    { text: '▝▜██████▀  Claude Opus 5.5[1m] with xhigh effort · API Usage Billing' },
    { text: 'Set model to Claude Haiku 5.5 and saved as your default for new sessions' },
  ])).toBe('Claude Opus 5.5[1m] with xhigh effort')
  expect(modelFromScreen([
    { text: '│ model: gpt-6.1-sol high    /model to change │' },
    { text: '• Model changed to gpt-6.1-sol high' },
    { text: '› 1. GPT-6-Astra (current)  Frontier' },
  ])).toBe('GPT-6-Astra')
})

it('resolves Default only from the CLI supplied effective model', () => {
  expect(modelFromMenuOption('Default (recommended)', 'Use the default model (currently Claude Opus 5.5[1m])')).toBe('Claude Opus 5.5[1m]')
  expect(modelFromMenuOption('Default', 'Use the default model')).toBeUndefined()
  expect(modelFromMenuOption('Claude Haiku 5.5 ✔', 'Custom Haiku model')).toBe('Claude Haiku 5.5')
})

import { reactive } from 'vue'

export type AppDialogKind = 'confirm' | 'prompt'

export interface AppDialogRequest {
  kind: AppDialogKind
  title: string
  message: string
  defaultValue?: string
  confirmLabel?: string
  placeholder?: string
  resolve: (value: boolean | string | null) => void
}

export const appDialogState = reactive<{ request: AppDialogRequest | null }>({ request: null })

function open(request: Omit<AppDialogRequest, 'resolve'>): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    appDialogState.request = { ...request, resolve }
  })
}

export function appConfirm(message: string, title = 'Super High', confirmLabel = '确认'): Promise<boolean> {
  return open({ kind: 'confirm', title, message, confirmLabel }).then((value) => value === true)
}

export function appPrompt(message: string, defaultValue = '', title = 'Super High'): Promise<string | null> {
  return open({ kind: 'prompt', title, message, defaultValue }).then((value) => typeof value === 'string' ? value : null)
}

export function resolveAppDialog(value: boolean | string | null) {
  const request = appDialogState.request
  if (!request) return
  appDialogState.request = null
  request.resolve(value)
}

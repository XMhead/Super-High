import { computed, onBeforeUnmount, ref } from 'vue'

import { backend, isTauri } from '@/lib/tauri'

interface VoiceRecognitionAlternative {
  transcript: string
}

interface VoiceRecognitionResult {
  isFinal: boolean
  [index: number]: VoiceRecognitionAlternative
}

interface VoiceRecognitionResultList {
  length: number
  [index: number]: VoiceRecognitionResult
}

interface VoiceRecognitionEvent extends Event {
  resultIndex: number
  results: VoiceRecognitionResultList
}

interface VoiceRecognitionErrorEvent extends Event {
  error?: string
  message?: string
}

interface VoiceRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onresult: ((event: VoiceRecognitionEvent) => void) | null
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type VoiceRecognitionConstructor = new () => VoiceRecognition
export type VoiceInputState = 'idle' | 'starting' | 'listening'
type VoiceInputMode = 'browser' | 'system'

export function getVoiceRecognitionConstructor(): VoiceRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const speechWindow = window as Window & {
    SpeechRecognition?: VoiceRecognitionConstructor
    webkitSpeechRecognition?: VoiceRecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

export function appendVoiceText(current: string, text: string): string {
  const nextText = text.trim()
  if (!nextText) return current
  const separator = current.length > 0 && !/\s$/.test(current) ? ' ' : ''
  return `${current}${separator}${nextText}`
}

export function useVoiceInput(options: {
  focusInput: () => Promise<void> | void
  appendText: (text: string) => void
}) {
  const voiceRecognition = ref<VoiceRecognition | null>(null)
  const voiceInputState = ref<VoiceInputState>('idle')
  const voiceInputError = ref('')
  const voiceInputMode = ref<VoiceInputMode | null>(null)
  const isVoiceListening = computed(() => voiceInputState.value === 'listening')
  const voiceInputAvailable = computed(() => isTauri() || !!getVoiceRecognitionConstructor())
  const voiceButtonTitle = computed(() => {
    if (!voiceInputAvailable.value) return '当前环境不支持语音输入'
    if (isVoiceListening.value) return '停止语音输入'
    return '语音输入'
  })
  const voiceStatusMessage = computed(() => {
    if (voiceInputError.value) return voiceInputError.value
    if (voiceInputState.value === 'starting') return '正在启动语音输入...'
    if (voiceInputState.value === 'listening') return '正在听...'
    return ''
  })

  async function toggleVoiceInput() {
    voiceInputError.value = ''
    if (voiceInputState.value === 'listening' || voiceRecognition.value) {
      await stopVoiceInput()
      return
    }
    await options.focusInput()
    if (isTauri()) {
      await openSystemVoiceInput()
      return
    }
    startBrowserVoiceInput()
  }

  async function openSystemVoiceInput() {
    voiceInputState.value = 'starting'
    try {
      await backend.openSystemVoiceInput()
      voiceInputMode.value = 'system'
      voiceInputState.value = 'listening'
    } catch (error) {
      voiceInputError.value = `语音输入启动失败：${error instanceof Error ? error.message : String(error)}`
      voiceInputState.value = 'idle'
    }
  }

  async function stopVoiceInput() {
    voiceInputError.value = ''
    const recognition = voiceRecognition.value
    if (recognition) {
      recognition.stop()
      return
    }
    if (voiceInputMode.value === 'system') {
      try {
        await backend.closeSystemVoiceInput()
      } catch (error) {
        voiceInputError.value = `语音输入停止失败：${error instanceof Error ? error.message : String(error)}`
      } finally {
        voiceInputMode.value = null
        voiceInputState.value = 'idle'
      }
    }
  }

  function startBrowserVoiceInput() {
    const Recognition = getVoiceRecognitionConstructor()
    if (!Recognition) {
      voiceInputState.value = 'idle'
      voiceInputError.value = '当前环境不支持语音输入'
      return
    }

    const recognition = new Recognition()
    recognition.lang = navigator.language || 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onstart = () => {
      voiceInputMode.value = 'browser'
      voiceInputState.value = 'listening'
    }
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal) transcript += result[0]?.transcript ?? ''
      }
      if (transcript) options.appendText(transcript)
    }
    recognition.onerror = (event) => {
      const message = event.message || event.error || '浏览器语音识别不可用'
      voiceInputError.value = `语音输入失败：${message}`
    }
    recognition.onend = () => {
      if (voiceRecognition.value === recognition) {
        voiceRecognition.value = null
        voiceInputMode.value = null
        voiceInputState.value = 'idle'
      }
    }

    voiceRecognition.value = recognition
    voiceInputState.value = 'starting'
    try {
      recognition.start()
    } catch (error) {
      voiceRecognition.value = null
      voiceInputMode.value = null
      voiceInputState.value = 'idle'
      voiceInputError.value = `语音输入启动失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  onBeforeUnmount(() => {
    voiceRecognition.value?.abort()
    if (voiceInputMode.value === 'system') void backend.closeSystemVoiceInput().catch(() => undefined)
  })

  return {
    isVoiceListening,
    voiceButtonTitle,
    voiceInputAvailable,
    voiceInputError,
    voiceInputState,
    voiceStatusMessage,
    stopVoiceInput,
    toggleVoiceInput,
  }
}

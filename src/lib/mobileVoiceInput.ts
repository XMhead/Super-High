import { computed, onBeforeUnmount, ref } from 'vue'
import { useVoiceInput } from '@/lib/voiceInput'

interface AndroidVoiceBridge {
  isAvailable: () => boolean
  start: (requestId: string) => void
  cancel: (requestId: string) => void
}

function getAndroidVoiceBridge(): AndroidVoiceBridge | undefined {
  return (window as Window & { SuperHighVoice?: AndroidVoiceBridge }).SuperHighVoice
}

/** Android uses the system recognizer; ordinary browsers retain Web Speech support. */
export function useMobileVoiceInput(options: {
  focusInput: () => Promise<void> | void
  appendText: (text: string) => void
}) {
  const browserVoice = useVoiceInput(options)
  const nativeBridge = getAndroidVoiceBridge()
  const nativeAvailable = nativeBridge?.isAvailable() ?? false
  const requestId = ref<string | null>(null)
  const error = ref('')
  const voiceInputAvailable = computed(() => nativeAvailable || browserVoice.voiceInputAvailable.value)
  const isVoiceListening = computed(() => !!requestId.value || browserVoice.isVoiceListening.value)
  const voiceButtonTitle = computed(() => !voiceInputAvailable.value
    ? '当前环境不支持语音输入'
    : isVoiceListening.value ? '取消语音输入' : '语音输入')
  const voiceStatusMessage = computed(() => error.value || (requestId.value
    ? '请在系统语音界面说话'
    : browserVoice.voiceStatusMessage.value))

  function onVoiceResult(event: Event) {
    const detail = (event as CustomEvent).detail
    if (!requestId.value || detail?.requestId !== requestId.value) return
    requestId.value = null
    if (detail.state === 'result' && typeof detail.text === 'string' && detail.text.trim()) {
      options.appendText(detail.text.trim())
      void options.focusInput()
    } else if (detail.state === 'error') {
      error.value = typeof detail.error === 'string' ? detail.error : '语音输入失败，请重试'
    }
  }

  async function toggleVoiceInput() {
    if (!nativeAvailable || !nativeBridge) return browserVoice.toggleVoiceInput()
    error.value = ''
    try {
      if (requestId.value) {
        nativeBridge.cancel(requestId.value)
        requestId.value = null
        return
      }
      requestId.value = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      nativeBridge.start(requestId.value)
    } catch {
      requestId.value = null
      error.value = '无法启动系统语音输入，请重试'
    }
  }

  window.addEventListener('superhigh:voice-result', onVoiceResult)
  onBeforeUnmount(() => {
    window.removeEventListener('superhigh:voice-result', onVoiceResult)
    if (requestId.value) nativeBridge?.cancel(requestId.value)
  })

  return { voiceInputAvailable, isVoiceListening, voiceButtonTitle, voiceStatusMessage, toggleVoiceInput }
}

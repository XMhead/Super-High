// 图片切换会暂时卸载正文；保留悬停前的高度，避免滚动钳位再次触发移入/移出。
const locks = new WeakMap<HTMLElement, { users: number; release(): void; cancel(): void }>()

export function holdUiPreviewLayout(trigger: HTMLElement) {
  const viewport = trigger.closest<HTMLElement>('.shui-scroll:not(.has-page), .shui-page-body, .shui-page-footer')
  const candidate = viewport?.firstElementChild
  if (!(candidate instanceof HTMLElement)) return () => undefined
  const content = candidate

  let lock = locks.get(content)
  if (!lock) {
    const original = content.style.minHeight
    let timer = 0
    let deadline = 0
    const observer = new MutationObserver(check)
    const cancel = () => {
      window.clearTimeout(timer)
      window.clearTimeout(deadline)
      observer.disconnect()
      content.removeEventListener('load', check, true)
      content.removeEventListener('error', check, true)
    }
    const restore = () => {
      cancel()
      content.style.minHeight = original
      locks.delete(content)
    }
    function check() {
      if (lock!.users || content.querySelector('.shui-image-pending')) return
      if ([...content.querySelectorAll('img')].some((image) => !image.complete)) return
      restore()
    }
    lock = {
      users: 0,
      cancel,
      release: () => {
        // 等恢复页完成渲染和图片加载后再释放，否则移出时也会先塌缩一次。
        timer = window.setTimeout(() => {
          observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'class'] })
          content.addEventListener('load', check, true)
          content.addEventListener('error', check, true)
          deadline = window.setTimeout(restore, 5000)
          check()
        }, 0)
      },
    }
    locks.set(content, lock)
  }
  lock.cancel()
  lock.users++
  content.style.minHeight = `${Math.max(content.getBoundingClientRect().height, parseFloat(content.style.minHeight) || 0)}px`
  let released = false
  return () => {
    if (released) return
    released = true
    if (--lock!.users === 0) lock!.release()
  }
}

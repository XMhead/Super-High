import type { Span, UiArrayInfo } from './superhighUi'

export interface UiArrayPosition {
  array: UiArrayInfo
  /** 目标位置按移动前的兄弟顺序计算，取值 0..length */
  index: number
}

const contains = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end

function separatorFor(source: string, array: UiArrayInfo) {
  const [first, second] = array.itemSpans
  const gap = second
    ? source.slice(first.end, second.start)
    : first
      ? source.slice(array.span.start + 1, first.start)
      : ''
  const newline = gap.lastIndexOf('\n')
  if (newline < 0) return ', '
  return `,\n${gap.slice(newline + 1).replace(/[^ \t]/g, '')}`
}

/**
 * 把数组字面量中的一个元素移到另一个（或同一个）数组的指定位置，原样搬动元素源码。
 * 两个位置必须来自对 source 的同一次解析；无法移动或位置不变时返回 null。
 */
export function moveSuperhighUiArrayItem(source: string, from: UiArrayPosition, to: UiArrayPosition): string | null {
  const items = from.array.itemSpans
  const item = items[from.index]
  if (!item) return null
  if (contains(item, to.array.span)) return null
  const sameArray = from.array.span.start === to.array.span.start && from.array.span.end === to.array.span.end
  let targetIndex = Math.max(0, Math.min(to.index, to.array.itemSpans.length))
  if (sameArray) {
    if (targetIndex === from.index || targetIndex === from.index + 1) return null
    if (targetIndex > from.index) targetIndex -= 1
  }

  const text = source.slice(item.start, item.end)
  const separator = separatorFor(source, to.array)
  const removal: Span = items.length === 1
    ? item
    : from.index < items.length - 1
      ? { start: item.start, end: items[from.index + 1].start }
      : { start: items[from.index - 1].end, end: item.end }
  const removedLength = removal.end - removal.start
  const shift = (offset: number) => offset >= removal.end
    ? offset - removedLength
    : offset > removal.start ? removal.start : offset
  const shiftSpan = (span: Span): Span => ({ start: shift(span.start), end: shift(span.end) })

  const afterRemoval = source.slice(0, removal.start) + source.slice(removal.end)
  const targetSpan = shiftSpan(to.array.span)
  const targetItems = to.array.itemSpans
    .filter((_, index) => !(sameArray && index === from.index))
    .map(shiftSpan)

  let insertAt: number
  let insertText: string
  if (!targetItems.length) {
    insertAt = targetSpan.start + 1
    insertText = text
  } else if (targetIndex < targetItems.length) {
    insertAt = targetItems[targetIndex].start
    insertText = text + separator
  } else {
    insertAt = targetItems[targetItems.length - 1].end
    insertText = separator + text
  }
  return afterRemoval.slice(0, insertAt) + insertText + afterRemoval.slice(insertAt)
}

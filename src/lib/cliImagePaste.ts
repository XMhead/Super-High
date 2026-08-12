/** Clipboard / paste helpers for CLI image attachments. */

export interface PastedImageCandidate {
  dataUrl: string
  mimeType: string
  preferredName?: string
  previewUrl: string
}

export interface CliImageAttachment {
  id: string
  path: string
  previewUrl: string
  fileName: string
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('failed to read image blob'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image blob'))
    reader.readAsDataURL(blob)
  })
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('bmp')) return 'bmp'
  return 'png'
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file.name)
}

export function clipboardEventHasImages(event: ClipboardEvent): boolean {
  const data = event.clipboardData
  return Array.from(data?.files ?? []).some(isImageFile)
    || Array.from(data?.items ?? []).some((item) => item.type.startsWith('image/'))
}

export async function extractPastedImagesFromClipboardEvent(
  event: ClipboardEvent,
): Promise<PastedImageCandidate[]> {
  const data = event.clipboardData
  const clipboardFiles = Array.from(data?.files ?? []).filter(isImageFile)
  const items = Array.from(data?.items ?? [])
  // Capture File references synchronously; clipboardData can become unavailable after awaits.
  const imageFiles = clipboardFiles.length
    ? clipboardFiles.map((file) => ({ file, mimeType: file.type || 'image/png' }))
    : items
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => {
          const file = item.getAsFile()
          if (!file) return null
          return {
            file,
            mimeType: file.type || item.type || 'image/png',
          }
        })
        .filter((value): value is { file: File; mimeType: string } => value != null)

  return Promise.all(imageFiles.map(async (image) => {
    const dataUrl = await blobToDataUrl(image.file)
    return {
      dataUrl,
      mimeType: image.mimeType,
      preferredName: image.file.name || `clipboard.${extensionFromMime(image.mimeType)}`,
      previewUrl: dataUrl,
    }
  }))
}

export async function extractPastedImagesFromClipboardApi(): Promise<PastedImageCandidate[]> {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return []
  try {
    const items = await navigator.clipboard.read()
    const images: PastedImageCandidate[] = []
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (!imageType) continue
      const blob = await item.getType(imageType)
      const dataUrl = await blobToDataUrl(blob)
      images.push({
        dataUrl,
        mimeType: imageType,
        preferredName: `clipboard.${extensionFromMime(imageType)}`,
        previewUrl: dataUrl,
      })
    }
    return images
  } catch {
    return []
  }
}

export function buildCliMessageWithImages(text: string, imagePaths: string[]): string {
  const trimmed = text.trim()
  const uniquePaths = Array.from(new Set(imagePaths.map((path) => path.trim()).filter(Boolean)))
  if (!uniquePaths.length) return trimmed
  const imageBlock = uniquePaths
    .map((path, index) => {
      const label = uniquePaths.length === 1 ? '图片' : `图片${index + 1}`
      return `${label}路径：${path}`
    })
    .join('\n')
  if (!trimmed) {
    return `${imageBlock}\n请查看上面的图片。`
  }
  return `${imageBlock}\n${trimmed}`
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}

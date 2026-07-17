import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl, fileToDataUrl } from './dataUrl'
import { getDataUrlDecodedByteSize } from './imageApiShared'

export const MAX_REFERENCE_IMAGES = 3
export const MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS = 600
export const REFERENCE_IMAGE_MAX_EDGE = 2048
export const REFERENCE_IMAGE_TARGET_BYTES = 5 * 1024 * 1024

const REFERENCE_IMAGE_MIN_EDGE = 1280
const WEBP_QUALITY_STEPS = [0.9, 0.82, 0.74]

export function getReferenceRequestTimeoutSeconds(timeoutSeconds: number, hasReferenceImages: boolean): number {
  const normalized = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 0
  return hasReferenceImages
    ? Math.max(MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS, normalized)
    : normalized
}

export function getConstrainedReferenceImageSize(width: number, height: number, maxEdge = REFERENCE_IMAGE_MAX_EDGE) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

async function encodeReferenceImage(image: HTMLImageElement, maxEdge: number): Promise<Blob> {
  const size = getConstrainedReferenceImageSize(image.naturalWidth, image.naturalHeight, maxEdge)
  const canvas = createCanvas(size.width, size.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法优化参考图')
  context.drawImage(image, 0, 0, size.width, size.height)

  let smallest: Blob | null = null
  for (const quality of WEBP_QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, 'image/webp', quality)
    if (!smallest || blob.size < smallest.size) smallest = blob
    if (blob.size <= REFERENCE_IMAGE_TARGET_BYTES) return blob
  }
  return smallest ?? canvasToBlob(canvas, 'image/png')
}

export async function optimizeReferenceImageDataUrl(dataUrl: string): Promise<{ dataUrl: string; optimized: boolean }> {
  const image = await loadImage(dataUrl)
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase()
  const supportedMimeType = mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp'
  const shouldOptimize =
    !supportedMimeType ||
    getDataUrlDecodedByteSize(dataUrl) > REFERENCE_IMAGE_TARGET_BYTES ||
    Math.max(image.naturalWidth, image.naturalHeight) > REFERENCE_IMAGE_MAX_EDGE

  if (!shouldOptimize) return { dataUrl, optimized: false }

  let maxEdge = REFERENCE_IMAGE_MAX_EDGE
  let blob = await encodeReferenceImage(image, maxEdge)
  while (blob.size > REFERENCE_IMAGE_TARGET_BYTES && maxEdge > REFERENCE_IMAGE_MIN_EDGE) {
    maxEdge = Math.max(REFERENCE_IMAGE_MIN_EDGE, Math.round(maxEdge * 0.8))
    blob = await encodeReferenceImage(image, maxEdge)
  }

  return { dataUrl: await blobToDataUrl(blob, 'image/webp'), optimized: true }
}

export async function prepareReferenceImageFile(file: File): Promise<{ dataUrl: string; optimized: boolean }> {
  if (!file.type.startsWith('image/')) throw new Error('请选择有效的图片文件')
  return optimizeReferenceImageDataUrl(await fileToDataUrl(file))
}

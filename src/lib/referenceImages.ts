import type { ApiProfile } from '../types'
import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl, fileToDataUrl } from './dataUrl'
import { MACODE_API_BASE_URL, MACODE_DEFAULT_ORIGIN } from './macodeConfig'

export const MAX_REFERENCE_IMAGES = 3
export const MIN_REFERENCE_REQUEST_TIMEOUT_SECONDS = 600
export const REFERENCE_IMAGE_MAX_EDGE = 2048
export const REFERENCE_IMAGE_TARGET_BYTES = 5 * 1024 * 1024

const REFERENCE_IMAGE_MIN_EDGE = 1280
const JPEG_QUALITY_STEPS = [0.92, 0.86, 0.78]
const REFERENCE_SHEET_GAP = 24
const REFERENCE_SHEET_BACKGROUND = '#f3f4f6'
const REFERENCE_SHEET_CELL_BACKGROUND = '#ffffff'
const REFERENCE_SHEET_BORDER = '#d1d5db'

export const MACODE_REFERENCE_SHEET_PROMPT = '参考图已按从左到右、从上到下排列在同一张参考板中。请把每个分区视为独立参考图综合使用，不要在生成结果中保留参考板的边框、留白或拼版结构。'

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
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(image, 0, 0, size.width, size.height)

  let smallest: Blob | null = null
  for (const quality of JPEG_QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    if (!smallest || blob.size < smallest.size) smallest = blob
    if (blob.size <= REFERENCE_IMAGE_TARGET_BYTES) return blob
  }
  return smallest ?? canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY_STEPS.at(-1))
}

export async function optimizeReferenceImageDataUrl(dataUrl: string): Promise<{ dataUrl: string; optimized: boolean }> {
  const image = await loadImage(dataUrl)

  let maxEdge = REFERENCE_IMAGE_MAX_EDGE
  let blob = await encodeReferenceImage(image, maxEdge)
  while (blob.size > REFERENCE_IMAGE_TARGET_BYTES && maxEdge > REFERENCE_IMAGE_MIN_EDGE) {
    maxEdge = Math.max(REFERENCE_IMAGE_MIN_EDGE, Math.round(maxEdge * 0.8))
    blob = await encodeReferenceImage(image, maxEdge)
  }

  return { dataUrl: await blobToDataUrl(blob, 'image/jpeg'), optimized: true }
}

export function getReferenceSheetLayout(count: number) {
  if (count !== 2 && count !== 3) throw new Error('参考板仅支持 2 或 3 张图片')

  const width = REFERENCE_IMAGE_MAX_EDGE
  const height = count === 2 ? REFERENCE_IMAGE_MAX_EDGE / 2 : REFERENCE_IMAGE_MAX_EDGE
  const cellSize = (width - REFERENCE_SHEET_GAP * 3) / 2
  const top = REFERENCE_SHEET_GAP
  const left = REFERENCE_SHEET_GAP
  const right = left + cellSize + REFERENCE_SHEET_GAP
  const cells = [
    { x: left, y: top, width: cellSize, height: height - REFERENCE_SHEET_GAP * 2 },
    { x: right, y: top, width: cellSize, height: height - REFERENCE_SHEET_GAP * 2 },
  ]

  if (count === 3) {
    cells[0].height = cellSize
    cells[1].height = cellSize
    cells.push({
      x: (width - cellSize) / 2,
      y: top + cellSize + REFERENCE_SHEET_GAP,
      width: cellSize,
      height: cellSize,
    })
  }

  return { width, height, cells }
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  cell: { x: number; y: number; width: number; height: number },
) {
  context.fillStyle = REFERENCE_SHEET_CELL_BACKGROUND
  context.fillRect(cell.x, cell.y, cell.width, cell.height)

  const scale = Math.min(cell.width / image.naturalWidth, cell.height / image.naturalHeight)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const x = Math.round(cell.x + (cell.width - width) / 2)
  const y = Math.round(cell.y + (cell.height - height) / 2)
  context.drawImage(image, x, y, width, height)
  context.strokeStyle = REFERENCE_SHEET_BORDER
  context.lineWidth = 2
  context.strokeRect(cell.x, cell.y, cell.width, cell.height)
}

export async function createReferenceImageSheetDataUrl(dataUrls: string[]): Promise<string> {
  const layout = getReferenceSheetLayout(dataUrls.length)
  const images = await Promise.all(dataUrls.map(loadImage))
  const canvas = createCanvas(layout.width, layout.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法合并参考图')

  context.fillStyle = REFERENCE_SHEET_BACKGROUND
  context.fillRect(0, 0, layout.width, layout.height)
  images.forEach((image, index) => drawContainedImage(context, image, layout.cells[index]))

  const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY_STEPS[0])
  return blobToDataUrl(blob, 'image/jpeg')
}

function getUrlHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function shouldComposeMacodeReferenceImages(
  profile: Pick<ApiProfile, 'provider' | 'apiMode' | 'baseUrl' | 'model'>,
  referenceCount: number,
) {
  if (referenceCount < 2 || referenceCount > MAX_REFERENCE_IMAGES) return false
  if (profile.provider !== 'openai' || profile.apiMode !== 'images') return false
  if (!/(?:^|\/)gpt-image-2$/i.test(profile.model.trim())) return false

  const profileHost = getUrlHost(profile.baseUrl)
  const configuredHost = getUrlHost(MACODE_API_BASE_URL)
  const defaultHost = getUrlHost(MACODE_DEFAULT_ORIGIN)
  return profileHost === configuredHost || profileHost === defaultHost || /(?:^|\.)macode\.(?:cloud|online)$/.test(profileHost)
}

export async function prepareReferenceImageFile(file: File): Promise<{ dataUrl: string; optimized: boolean }> {
  if (!file.type.startsWith('image/')) throw new Error('请选择有效的图片文件')
  return optimizeReferenceImageDataUrl(await fileToDataUrl(file))
}

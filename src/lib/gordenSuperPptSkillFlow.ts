import { zipSync } from 'fflate'
import { callImageApi } from './api'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  createLinkedAbortController,
  getApiErrorMessage,
  isDataUrl,
  MIME_MAP,
} from './imageApiShared'
import { clampPptConcurrency, runWithConcurrency } from './pptConcurrency'
import { DEFAULT_PPT_PARAMS } from './pptPromptPlan'
import {
  createGordenSkillEditablePptx,
  createImageSlidesPptx,
  ensurePptxExtension,
  sanitizePptxFileName,
  type GordenSkillLayerSlide,
  type GordenSkillIconLayer,
  type GordenSkillTextBox,
  type ImageSlide,
} from './pptxExport'
import type { ApiProfile, AppSettings, ResponsesApiResponse, TaskParams } from '../types'
import type { PptSlidePlan } from './pptPromptPlan'

export interface GordenSkillSourceSlide {
  plan: PptSlidePlan
  image: string
  sourceImageUrl?: string
}

export interface GordenSkillProgress {
  slideIndex?: number
  stage: 'stage-a' | 'background' | 'frame' | 'icons' | 'text' | 'compose' | 'package'
  message: string
}

export interface GordenSuperPptSkillResult {
  baseName: string
  imageDeckFileName: string
  editableFileName: string
  artifactZipFileName: string
  imageDeckBlob: Blob
  editableBlob: Blob
  artifactZipBlob: Blob
  imageDeckSlides: ImageSlide[]
  editableSlides: GordenSkillLayerSlide[]
}

interface PreparedSlide {
  plan: PptSlidePlan
  sourceImage: string
  originalSource: string
  keyColor: string
  width: number
  height: number
}

interface ConvertedSlide {
  layerSlide: GordenSkillLayerSlide
  sourceImage: string
  keyColor: string
  backgroundRaw: string
  frameRaw: string
  iconsRaw: string
  prompts: {
    slide: string
    background: string
    frame: string
    icons: string
    text: string
  }
  assetManifest: unknown
  layout: unknown
}

const TARGET_ASPECT = 16 / 9
const TARGET_WIDTH = 1536
const TARGET_HEIGHT = 864
const KEY_GREEN = '#00ff00'
const KEY_MAGENTA = '#ff00ff'
const LAYER_ATTEMPTS = 3
const GORDEN_CONVERSION_MAX_CONCURRENCY = 2
const ICON_ALPHA_THRESHOLD = 24
const ICON_MIN_AREA = 80
const ICON_PADDING_PX = 8
const ICON_MAX_COMPONENTS = 80

const LAYER_PARAMS: TaskParams = {
  ...DEFAULT_PPT_PARAMS,
  size: `${TARGET_WIDTH}x${TARGET_HEIGHT}`,
  quality: 'high',
  output_format: 'png',
  n: 1,
  transparent_output: false,
}

function padSlide(index: number): string {
  return String(index).padStart(2, '0')
}

function stripPptxExtension(value: string): string {
  return value.replace(/\.pptx$/i, '')
}

function toSafeBaseName(value: string): string {
  return stripPptxExtension(sanitizePptxFileName(value) || 'gorden-super-ppt')
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadGordenSuperPptSkillResult(result: GordenSuperPptSkillResult) {
  triggerDownload(result.imageDeckBlob, result.imageDeckFileName)
  window.setTimeout(() => triggerDownload(result.editableBlob, result.editableFileName), 150)
  window.setTimeout(() => triggerDownload(result.artifactZipBlob, result.artifactZipFileName), 300)
}

async function pptxToBlob(pptx: ReturnType<typeof createImageSlidesPptx> | ReturnType<typeof createGordenSkillEditablePptx>): Promise<Blob> {
  const output = await (pptx as any).write({ outputType: 'blob', compression: true })
  if (output instanceof Blob) return output
  if (output instanceof ArrayBuffer) {
    return new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  }
  throw new Error('Unable to serialize PPTX')
}

function assertNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted')
}

function getRequestTimeoutSeconds(settings: AppSettings, profile: ApiProfile): number {
  return Math.max(1, profile.timeout || settings.timeout || 600)
}

function getAbortError(signal: AbortSignal, fallback: string): Error {
  if (signal.reason instanceof Error) return signal.reason
  if (typeof signal.reason === 'string' && signal.reason.trim()) return new Error(signal.reason)
  return new Error(fallback)
}

function createTimedAbortController(label: string, timeoutSeconds: number, callerSignal?: AbortSignal) {
  const controller = new AbortController()
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000
  const timeoutId = window.setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${timeoutSeconds}s`))
  }, timeoutMs)
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason ?? new Error(`${label} aborted`))
  }

  if (callerSignal?.aborted) {
    abortFromCaller()
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }

  return {
    controller,
    cleanup: () => {
      window.clearTimeout(timeoutId)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

async function runAttemptWithTimeout<T>(
  label: string,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  fn: (attemptSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { controller, cleanup } = createTimedAbortController(label, timeoutSeconds, signal)
  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(getAbortError(controller.signal, `${label} aborted`))
    if (controller.signal.aborted) {
      onAbort()
      return
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([fn(controller.signal), abortPromise])
  } finally {
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    cleanup()
  }
}

function waitBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'))
      return
    }
    let timeoutId = 0
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    function onAbort() {
      window.clearTimeout(timeoutId)
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'))
    }
    timeoutId = window.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function withRetries<T>(
  label: string,
  signal: AbortSignal | undefined,
  timeoutSeconds: number,
  fn: (attemptSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= LAYER_ATTEMPTS; attempt++) {
    assertNotAborted(signal)
    try {
      return await runAttemptWithTimeout(`${label} attempt ${attempt}`, timeoutSeconds, signal, fn)
    } catch (err) {
      lastError = err
      if (attempt >= LAYER_ATTEMPTS || signal?.aborted) break
      await waitBeforeRetry(1000 * attempt, signal)
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${label} failed after ${LAYER_ATTEMPTS} attempts: ${message}`)
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw new Error('Invalid data URL')
  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) {
    return new TextEncoder().encode(decodeURIComponent(payload))
  }
  const binary = atob(payload.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function blobToDataUrl(blob: Blob, fallbackMime = 'image/png'): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function ensureDataUrlImage(value: string, signal?: AbortSignal): Promise<string> {
  if (isDataUrl(value)) return value
  const response = await fetch(value, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Failed to download slide image: HTTP ${response.status}`)
  return blobToDataUrl(await response.blob())
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode image'))
    image.src = dataUrl
  })
}

async function normalizeSlideTo16x9(dataUrl: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const image = await loadImage(dataUrl)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const sourceAspect = sourceWidth / sourceHeight
  let cropWidth = sourceWidth
  let cropHeight = sourceHeight
  let cropX = 0
  let cropY = 0

  if (Math.abs(sourceAspect - TARGET_ASPECT) > 0.01) {
    if (sourceAspect > TARGET_ASPECT) {
      cropWidth = Math.round(sourceHeight * TARGET_ASPECT)
      cropX = Math.round((sourceWidth - cropWidth) / 2)
    } else {
      cropHeight = Math.round(sourceWidth / TARGET_ASPECT)
      cropY = Math.round((sourceHeight - cropHeight) / 2)
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = TARGET_WIDTH
  canvas.height = TARGET_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, TARGET_WIDTH, TARGET_HEIGHT)
  return { dataUrl: canvas.toDataURL('image/png'), width: TARGET_WIDTH, height: TARGET_HEIGHT }
}

function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.replace(/^#/, '')
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ]
}

async function pickKeyColor(sourceImage: string): Promise<string> {
  const image = await loadImage(sourceImage)
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 54
  const ctx = canvas.getContext('2d')
  if (!ctx) return KEY_GREEN
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let greenLike = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    if (g > 150 && g > r * 1.35 && g > b * 1.35) greenLike++
  }
  return greenLike / (pixels.length / 4) > 0.01 ? KEY_MAGENTA : KEY_GREEN
}

async function chromaKeyDataUrl(dataUrl: string, keyColor: string): Promise<string> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  ctx.drawImage(image, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const [kr, kg, kb] = hexToRgb(keyColor)
  const pixels = imageData.data
  for (let index = 0; index < pixels.length; index += 4) {
    const dr = pixels[index] - kr
    const dg = pixels[index + 1] - kg
    const db = pixels[index + 2] - kb
    const distance = Math.sqrt(dr * dr + dg * dg + db * db)
    const greenRule = keyColor === KEY_GREEN && pixels[index + 1] > 150 && pixels[index] < 130 && pixels[index + 2] < 130
    const magentaRule = keyColor === KEY_MAGENTA && pixels[index] > 150 && pixels[index + 2] > 150 && pixels[index + 1] < 130
    if (distance < 90 || greenRule || magentaRule) pixels[index + 3] = 0
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

async function sliceTransparentLayer(dataUrl: string): Promise<GordenSkillIconLayer[]> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, width, height).data
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  const components: Array<{ x1: number; y1: number; x2: number; y2: number; area: number }> = []

  const isSolid = (index: number) => pixels[index * 4 + 3] > ICON_ALPHA_THRESHOLD

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || !isSolid(start)) continue
    visited[start] = 1
    let head = 0
    let tail = 0
    queue[tail++] = start
    let area = 0
    let x1 = width
    let y1 = height
    let x2 = 0
    let y2 = 0

    while (head < tail) {
      const current = queue[head++]
      const x = current % width
      const y = Math.floor(current / width)
      area++
      if (x < x1) x1 = x
      if (x > x2) x2 = x
      if (y < y1) y1 = y
      if (y > y2) y2 = y

      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ]
      for (const next of neighbors) {
        if (next < 0 || visited[next] || !isSolid(next)) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }

    if (area >= ICON_MIN_AREA) {
      components.push({ x1, y1, x2, y2, area })
    }
  }

  components.sort((a, b) => b.area - a.area)
  return components.slice(0, ICON_MAX_COMPONENTS).map((component, index) => {
    const x = Math.max(0, component.x1 - ICON_PADDING_PX)
    const y = Math.max(0, component.y1 - ICON_PADDING_PX)
    const w = Math.min(width - x, component.x2 - component.x1 + 1 + ICON_PADDING_PX * 2)
    const h = Math.min(height - y, component.y2 - component.y1 + 1 + ICON_PADDING_PX * 2)
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const outCtx = out.getContext('2d')
    if (!outCtx) throw new Error('Canvas is unavailable')
    outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
    return {
      dataUrl: out.toDataURL('image/png'),
      x: x / width,
      y: y / height,
      w: w / width,
      h: h / height,
      role: `icon_${String(index + 1).padStart(2, '0')}`,
    }
  })
}

function buildLayerPrompt(kind: 'background' | 'frame' | 'icons', plan: PptSlidePlan, keyColor: string): string {
  const context = [
    `Slide title: ${plan.title}`,
    `Slide content: ${plan.content}`,
    'Use the attached slide image as the only edit target. Preserve the same 16:9 canvas, scale, palette, and object positions.',
  ].join('\n')

  if (kind === 'background') {
    return [
      context,
      'Generate the clean background layer only.',
      'Remove all ordinary text, labels, icons, decorative marks, cards, chart shapes, arrows, connectors, and frames.',
      'Keep only the ambient background, subtle texture, lighting, and overall color system. Do not add placeholders.',
    ].join('\n')
  }

  if (kind === 'frame') {
    return [
      context,
      `Generate a full-slide framework/skeleton layer on a solid ${keyColor} background.`,
      'Include cards, containers, title bars, panels, separators, connector lines, chart geometry, axes, grids, trend lines, funnels, steps, ribbons, and non-icon decorative structure.',
      'Do not include ordinary readable text, labels, logos, pictogram icons, or artistic words.',
      'Keep shapes, fills, strokes, sizes, and positions as close to the source slide as possible.',
    ].join('\n')
  }

  return [
    context,
    `Generate a full-slide icon and decoration layer on a solid ${keyColor} background.`,
    'Include pictogram icons, small symbols, decorative badges, illustration fragments, ornamental marks, and artistic lettering that should remain as image elements.',
    'Do not include ordinary readable paragraph text. Do not include cards, containers, chart axes, or framework panels already covered by the skeleton layer.',
    'Keep each element at its original location and size. Leave empty areas as the key-color background.',
  ].join('\n')
}

function buildTextPrompt(plan: PptSlidePlan): string {
  return [
    'Extract editable ordinary text from the attached 16:9 slide image.',
    'Return JSON only. Do not wrap it in markdown.',
    'Schema:',
    '{"texts":[{"text":"...","x":0.0,"y":0.0,"w":0.0,"h":0.0,"size_ratio":0.035,"color":"#111111","bold":false,"align":"left","valign":"top","font":"Microsoft YaHei"}]}',
    'Coordinates must be fractions of the full slide canvas. x/y are the top-left corner; w/h are width and height.',
    'Extract all normal readable slide text. Skip decorative/artistic lettering only if it cannot be represented as a normal text box.',
    'Preserve line breaks inside a text box when they appear as one visual block.',
    'Use approximate font size, color, bold, and alignment based on the visual appearance.',
    `Expected slide title/context: ${plan.title}`,
    `Expected content hints: ${plan.content}`,
  ].join('\n')
}

async function generateLayerImage(opts: {
  settings: AppSettings
  prompt: string
  sourceImage: string
  signal?: AbortSignal
}): Promise<string> {
  const result = await callImageApi({
    settings: opts.settings,
    prompt: opts.prompt,
    params: LAYER_PARAMS,
    inputImageDataUrls: [opts.sourceImage],
    signal: opts.signal,
  })
  const image = result.images[0]
  if (!image) throw new Error('Layer image generation returned no image')
  return ensureDataUrlImage(image, opts.signal)
}

function createResponseHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'Content-Type': 'application/json',
  }
}

function getStringByPath(source: unknown, path: string[]): string {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : ''
}

function extractResponsesText(payload: ResponsesApiResponse | Record<string, unknown>): string {
  const direct =
    getStringByPath(payload, ['output_text']) ||
    getStringByPath(payload, ['text']) ||
    getStringByPath(payload, ['message', 'content'])
  if (direct.trim()) return direct.trim()

  const output = Array.isArray((payload as ResponsesApiResponse).output)
    ? (payload as ResponsesApiResponse).output ?? []
    : []
  const parts: string[] = []
  for (const item of output) {
    const record = item as Record<string, unknown>
    if (typeof record.text === 'string') parts.push(record.text)
    if (typeof record.output_text === 'string') parts.push(record.output_text)
    const content = record.content
    if (typeof content === 'string') parts.push(content)
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      }
    }
  }
  return parts.join('\n').trim()
}

function parseMaybeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace('%', '').trim())
    if (Number.isFinite(parsed)) return value.includes('%') ? parsed / 100 : parsed
  }
  return fallback
}

function normalizeFraction(value: unknown, fallback: number): number {
  const parsed = parseMaybeNumber(value, fallback)
  if (parsed > 1 && parsed <= 100) return Math.max(0, Math.min(1, parsed / 100))
  return Math.max(0, Math.min(1, parsed))
}

function normalizeTextBoxes(rawText: string): GordenSkillTextBox[] {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/g, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Vision layout response did not contain JSON')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  const sourceTexts = Array.isArray(parsed.texts) ? parsed.texts : []

  return sourceTexts.flatMap((item): GordenSkillTextBox[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) return []
    const align = ['left', 'center', 'right', 'justify'].includes(String(record.align)) ? record.align as GordenSkillTextBox['align'] : 'left'
    const valign = ['top', 'middle', 'bottom'].includes(String(record.valign)) ? record.valign as GordenSkillTextBox['valign'] : 'top'
    const sizeRatio = record.size_ratio ?? record.sizeRatio ?? record.size_pct
    return [{
      text,
      x: normalizeFraction(record.x, 0.05),
      y: normalizeFraction(record.y, 0.05),
      w: Math.max(0.01, normalizeFraction(record.w, 0.35)),
      h: Math.max(0.01, normalizeFraction(record.h, 0.08)),
      size: record.size != null ? Math.max(6, Math.min(72, parseMaybeNumber(record.size, 14))) : undefined,
      sizeRatio: sizeRatio != null ? Math.max(0.005, Math.min(0.2, parseMaybeNumber(sizeRatio, 0.028))) : undefined,
      color: typeof record.color === 'string' ? record.color : '#111111',
      bold: Boolean(record.bold),
      align,
      valign,
      font: typeof record.font === 'string' && record.font.trim() ? record.font.trim() : 'Microsoft YaHei',
    }]
  })
}

async function callVisionLayoutApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  prompt: string
  sourceImage: string
  signal?: AbortSignal
}): Promise<GordenSkillTextBox[]> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(opts.profile.apiProxy, proxyConfig)
  const { controller, cleanup } = createLinkedAbortController(opts.profile.timeout || opts.settings.timeout || 600, opts.signal)

  try {
    const response = await fetch(buildApiUrl(opts.profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createResponseHeaders(opts.profile),
      cache: 'no-store',
      body: JSON.stringify({
        model: opts.profile.model || opts.settings.model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: opts.prompt },
            { type: 'input_image', image_url: opts.sourceImage },
          ],
        }],
        max_output_tokens: 3500,
      }),
      signal: controller.signal,
    })

    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await response.json() as ResponsesApiResponse
    const text = extractResponsesText(payload)
    if (!text) throw new Error('Vision layout response was empty')
    const boxes = normalizeTextBoxes(text)
    if (!boxes.length) throw new Error('Vision layout response contained no editable text boxes')
    return boxes
  } finally {
    cleanup()
  }
}

function getBackendLabel(profile: ApiProfile): string {
  return `${profile.provider}:${profile.apiMode}:${profile.model}`
}

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += Math.max(1, Math.floor(value.length / 4096))) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function toLayoutText(text: GordenSkillTextBox) {
  return {
    text: text.text,
    x: text.x,
    y: text.y,
    w: text.w,
    h: text.h,
    ...(text.size != null ? { size: text.size } : {}),
    ...(text.sizeRatio != null ? { size_ratio: text.sizeRatio } : {}),
    color: text.color || '#111111',
    bold: Boolean(text.bold),
    align: text.align || 'left',
    valign: text.valign || 'top',
    font: text.font || 'Microsoft YaHei',
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function buildFallbackTextBoxes(plan: PptSlidePlan): GordenSkillTextBox[] {
  const title = plan.title.trim() || `Slide ${plan.index}`
  const bodyLines = plan.content
    .split(/\n+|[;；。]/)
    .map((line) => line.replace(/^[-•\d.\s]+/, '').trim())
    .filter(Boolean)
    .filter((line) => line !== title)
    .slice(0, 5)
  const body = bodyLines.length ? bodyLines.map((line) => `• ${line}`).join('\n') : '• Editable content placeholder'

  return [
    {
      text: title,
      x: 0.06,
      y: 0.06,
      w: 0.88,
      h: 0.12,
      sizeRatio: 0.055,
      color: '#111827',
      bold: true,
      align: 'left',
      valign: 'top',
      font: 'Microsoft YaHei',
    },
    {
      text: body,
      x: 0.08,
      y: 0.24,
      w: 0.84,
      h: 0.5,
      sizeRatio: 0.032,
      color: '#1f2937',
      bold: false,
      align: 'left',
      valign: 'top',
      font: 'Microsoft YaHei',
    },
  ]
}

async function convertSlide(opts: {
  item: PreparedSlide
  settings: AppSettings
  profile: ApiProfile
  signal?: AbortSignal
  onProgress?: (progress: GordenSkillProgress) => void
}): Promise<ConvertedSlide> {
  const { item, settings, profile, signal, onProgress } = opts
  const slideNo = padSlide(item.plan.index)
  const backend = getBackendLabel(profile)
  const backgroundPrompt = buildLayerPrompt('background', item.plan, item.keyColor)
  const framePrompt = buildLayerPrompt('frame', item.plan, item.keyColor)
  const iconsPrompt = buildLayerPrompt('icons', item.plan, item.keyColor)
  const textPrompt = buildTextPrompt(item.plan)
  const timeoutSeconds = getRequestTimeoutSeconds(settings, profile)

  onProgress?.({ slideIndex: item.plan.index, stage: 'background', message: `B2 ${slideNo}: generating clean background` })
  const backgroundRaw = await withRetries('background layer', signal, timeoutSeconds, (attemptSignal) => generateLayerImage({
    settings,
    prompt: backgroundPrompt,
    sourceImage: item.sourceImage,
    signal: attemptSignal,
  }))

  onProgress?.({ slideIndex: item.plan.index, stage: 'frame', message: `B3 ${slideNo}: generating framework layer` })
  const frameRaw = await withRetries('frame layer', signal, timeoutSeconds, (attemptSignal) => generateLayerImage({
    settings,
    prompt: framePrompt,
    sourceImage: item.sourceImage,
    signal: attemptSignal,
  }))
  const frameImage = await chromaKeyDataUrl(frameRaw, item.keyColor)

  onProgress?.({ slideIndex: item.plan.index, stage: 'icons', message: `B4 ${slideNo}: generating icon/decor layer` })
  const iconsRaw = await withRetries('icon layer', signal, timeoutSeconds, (attemptSignal) => generateLayerImage({
    settings,
    prompt: iconsPrompt,
    sourceImage: item.sourceImage,
    signal: attemptSignal,
  }))
  const iconsImage = await chromaKeyDataUrl(iconsRaw, item.keyColor)
  const icons = await sliceTransparentLayer(iconsImage)

  onProgress?.({ slideIndex: item.plan.index, stage: 'text', message: `B7 ${slideNo}: extracting editable text boxes` })
  let textFallbackReason: string | undefined
  let texts: GordenSkillTextBox[]
  try {
    texts = await withRetries('text layout', signal, timeoutSeconds, (attemptSignal) => callVisionLayoutApi({
      settings,
      profile,
      prompt: textPrompt,
      sourceImage: item.sourceImage,
      signal: attemptSignal,
    }))
  } catch (err) {
    assertNotAborted(signal)
    textFallbackReason = getErrorMessage(err)
    onProgress?.({ slideIndex: item.plan.index, stage: 'text', message: `B7 ${slideNo}: using editable outline fallback text` })
    texts = buildFallbackTextBoxes(item.plan)
  }

  const layout = {
    slide_width_in: 13.333,
    slide_height_in: 7.5,
    units: 'fraction',
    ref_width: item.width,
    ref_height: item.height,
    assets_dir: '.',
    background: 'background.png',
    frame: 'frame.png',
    icons: icons.length
      ? icons.map((icon, iconIndex) => ({
          file: `icons/ic_${String(iconIndex + 1).padStart(2, '0')}.png`,
          x: icon.x,
          y: icon.y,
          w: icon.w,
          h: icon.h,
          role: icon.role,
        }))
      : [{ file: 'icons.png', x: 0, y: 0, w: 1, h: 1, role: 'icons_layer' }],
    texts: texts.map(toLayoutText),
    ...(textFallbackReason ? { text_fallback_reason: textFallbackReason } : {}),
  }
  const assetManifest = {
    schema: 'gorden-image2pptx-assets/v1',
    slide: item.plan.index,
    source_slide: `slides/${slideNo}.png`,
    key_color: item.keyColor,
    assets: [
      {
        layer: 'background',
        backend,
        prompt_file: `editable/${slideNo}/prompts/background.md`,
        generated_source: `browser-imagegen:${hashString(backgroundRaw)}`,
        copied_to: `editable/${slideNo}/background.png`,
      },
      {
        layer: 'frame',
        backend,
        prompt_file: `editable/${slideNo}/prompts/frame.md`,
        generated_source: `browser-imagegen:${hashString(frameRaw)}`,
        copied_to: `editable/${slideNo}/frame.png`,
      },
      {
        layer: 'icons',
        backend,
        prompt_file: `editable/${slideNo}/prompts/icons.md`,
        generated_source: `browser-imagegen:${hashString(iconsRaw)}`,
        copied_to: `editable/${slideNo}/icons.png`,
      },
    ],
    text_extraction: {
      backend,
      prompt_file: `editable/${slideNo}/prompts/text.md`,
      boxes: texts.length,
      ...(textFallbackReason ? { fallback_reason: textFallbackReason } : {}),
    },
  }

  return {
    sourceImage: item.sourceImage,
    keyColor: item.keyColor,
    backgroundRaw,
    frameRaw,
    iconsRaw,
    prompts: {
      slide: item.plan.prompt,
      background: backgroundPrompt,
      frame: framePrompt,
      icons: iconsPrompt,
      text: textPrompt,
    },
    assetManifest,
    layout,
    layerSlide: {
      index: item.plan.index,
      title: item.plan.title,
      sourceImage: item.sourceImage,
      backgroundImage: backgroundRaw,
      frameImage,
      iconsImage,
      icons,
      texts,
      notes: item.plan.content,
    },
  }
}

async function prepareSlides(slides: GordenSkillSourceSlide[], signal?: AbortSignal): Promise<PreparedSlide[]> {
  const result: PreparedSlide[] = []
  for (const slide of slides) {
    assertNotAborted(signal)
    const source = await ensureDataUrlImage(slide.image, signal)
    const normalized = await normalizeSlideTo16x9(source)
    result.push({
      plan: slide.plan,
      sourceImage: normalized.dataUrl,
      originalSource: slide.sourceImageUrl || slide.image,
      keyColor: await pickKeyColor(normalized.dataUrl),
      width: normalized.width,
      height: normalized.height,
    })
  }
  return result
}

function addJson(files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]>, path: string, value: unknown) {
  files[path] = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function addText(files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]>, path: string, value: string) {
  files[path] = new TextEncoder().encode(value)
}

function addImage(files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]>, path: string, dataUrl: string) {
  files[path] = dataUrlToBytes(dataUrl)
}

async function buildArtifactZip(opts: {
  baseName: string
  prepared: PreparedSlide[]
  converted: ConvertedSlide[]
  imageDeckBlob: Blob
  editableBlob: Blob
  imageDeckFileName: string
  editableFileName: string
  topic: string
}) {
  const files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  const backendBySlide = opts.converted.reduce<Record<number, string>>((map, slide) => {
    map[slide.layerSlide.index] = 'imagegen'
    return map
  }, {})

  addJson(files, 'outline.json', {
    topic: opts.topic,
    generated_by: 'GordenSuperPPTSkill browser flow',
    slide_count: opts.prepared.length,
    slides: opts.prepared.map((item) => ({
      index: item.plan.index,
      title: item.plan.title,
      detailed_content: item.plan.content,
      visual_generation_prompt: item.plan.prompt,
    })),
  })

  addJson(files, 'imagegen-manifest.json', {
    schema: 'gorden-image-pptgen/v1',
    backend: 'browser image_generation',
    slides: opts.prepared.map((item) => {
      const slideNo = padSlide(item.plan.index)
      return {
        slide: item.plan.index,
        prompt_file: `prompts/${slideNo}.md`,
        generated_source: item.originalSource.startsWith('data:')
          ? `browser-imagegen:${hashString(item.originalSource)}`
          : item.originalSource,
        copied_to: `slides/${slideNo}.png`,
        backend: backendBySlide[item.plan.index] || 'imagegen',
      }
    }),
  })

  addJson(files, 'deck.json', {
    slide_width_in: 13.333,
    slide_height_in: 7.5,
    units: 'fraction',
    assets_dir: '.',
    slides: opts.prepared.map((item) => ({ background: `slides/${padSlide(item.plan.index)}.png` })),
  })

  for (const item of opts.prepared) {
    const slideNo = padSlide(item.plan.index)
    addText(files, `prompts/${slideNo}.md`, `${item.plan.prompt}\n`)
    addImage(files, `slides/${slideNo}.png`, item.sourceImage)
  }

  addJson(files, 'editable/deck.json', {
    slide_width_in: 13.333,
    slide_height_in: 7.5,
    units: 'fraction',
    assets_dir: '.',
    slides: opts.converted.map((item) => {
      const slideNo = padSlide(item.layerSlide.index)
      return {
        background: `editable/${slideNo}/background.png`,
        frame: `editable/${slideNo}/frame.png`,
        icons: item.layerSlide.icons?.length
          ? item.layerSlide.icons.map((icon, iconIndex) => ({
              file: `editable/${slideNo}/icons/ic_${String(iconIndex + 1).padStart(2, '0')}.png`,
              x: icon.x,
              y: icon.y,
              w: icon.w,
              h: icon.h,
              role: icon.role,
            }))
          : [{ file: `editable/${slideNo}/icons.png`, x: 0, y: 0, w: 1, h: 1, role: 'icons_layer' }],
        texts: item.layerSlide.texts.map(toLayoutText),
      }
    }),
  })

  for (const item of opts.converted) {
    const slideNo = padSlide(item.layerSlide.index)
    addImage(files, `editable/${slideNo}/source.png`, item.sourceImage)
    addImage(files, `editable/${slideNo}/background.png`, item.layerSlide.backgroundImage)
    addImage(files, `editable/${slideNo}/frame_raw.png`, item.frameRaw)
    if (item.layerSlide.frameImage) addImage(files, `editable/${slideNo}/frame.png`, item.layerSlide.frameImage)
    addImage(files, `editable/${slideNo}/icons_raw.png`, item.iconsRaw)
    if (item.layerSlide.iconsImage) addImage(files, `editable/${slideNo}/icons.png`, item.layerSlide.iconsImage)
    item.layerSlide.icons?.forEach((icon, iconIndex) => {
      addImage(files, `editable/${slideNo}/icons/ic_${String(iconIndex + 1).padStart(2, '0')}.png`, icon.dataUrl)
    })
    addText(files, `editable/${slideNo}/prompts/background.md`, `${item.prompts.background}\n`)
    addText(files, `editable/${slideNo}/prompts/frame.md`, `${item.prompts.frame}\n`)
    addText(files, `editable/${slideNo}/prompts/icons.md`, `${item.prompts.icons}\n`)
    addText(files, `editable/${slideNo}/prompts/text.md`, `${item.prompts.text}\n`)
    addJson(files, `editable/${slideNo}/layout.json`, item.layout)
    addJson(files, `editable/${slideNo}/imagegen-assets-manifest.json`, item.assetManifest)
  }

  files[`out/${opts.imageDeckFileName}`] = new Uint8Array(await opts.imageDeckBlob.arrayBuffer())
  files[`out/${opts.editableFileName}`] = new Uint8Array(await opts.editableBlob.arrayBuffer())
  addText(files, 'README-SKILL-FLOW.md', [
    '# Gorden Super PPT Skills Artifacts',
    '',
    'This package follows the A -> B flow used by the project-local Gorden Super PPT Skills:',
    '- A: image-based slide deck with per-slide prompts and imagegen manifest.',
    '- B: editable PPTX assembled from background, frame, icons/decor, and editable text layers.',
    '',
    'The browser runtime stores imagegen evidence as browser-imagegen hashes or returned image URLs instead of CODEX_HOME paths.',
    '',
  ].join('\n'))

  const zipped = zipSync(files, { level: 6 })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: 'application/zip' })
}

export async function runGordenSuperPptSkillFlow(opts: {
  topic: string
  baseName: string
  slides: GordenSkillSourceSlide[]
  settings: AppSettings
  profile: ApiProfile
  concurrency: number
  signal?: AbortSignal
  onProgress?: (progress: GordenSkillProgress) => void
}): Promise<GordenSuperPptSkillResult> {
  const sourceSlides = opts.slides.filter((slide) => Boolean(slide.image))
  if (!sourceSlides.length) {
    throw new Error('Please generate slide images before running Gorden Super PPT Skills export')
  }

  const baseName = toSafeBaseName(opts.baseName)
  const imageDeckFileName = ensurePptxExtension(`${baseName}-image-deck.pptx`)
  const editableFileName = ensurePptxExtension(`${baseName}-editable.pptx`)
  const artifactZipFileName = `${baseName}-gorden-skill-artifacts.zip`

  opts.onProgress?.({ stage: 'stage-a', message: 'A4: preparing generated slide images and manifest' })
  const prepared = await prepareSlides(sourceSlides, opts.signal)
  const imageDeckSlides: ImageSlide[] = prepared.map((item) => ({
    dataUrl: item.sourceImage,
    altText: item.plan.title,
    notes: item.plan.content,
  }))

  const converted: ConvertedSlide[] = []
  const conversionConcurrency = Math.min(clampPptConcurrency(opts.concurrency), GORDEN_CONVERSION_MAX_CONCURRENCY)
  opts.onProgress?.({ stage: 'stage-a', message: `B1: converting ${prepared.length} slides with ${conversionConcurrency} parallel workers` })

  await runWithConcurrency(
    prepared,
    conversionConcurrency,
    async (item) => {
      const slide = await convertSlide({
        item,
        settings: opts.settings,
        profile: opts.profile,
        signal: opts.signal,
        onProgress: opts.onProgress,
      })
      converted.push(slide)
    },
    () => !opts.signal?.aborted,
  )
  converted.sort((a, b) => a.layerSlide.index - b.layerSlide.index)

  opts.onProgress?.({ stage: 'compose', message: 'B8: composing image deck and editable PPTX' })
  const imageDeckBlob = await pptxToBlob(createImageSlidesPptx(imageDeckSlides, opts.topic))
  const editableSlides = converted.map((item) => item.layerSlide)
  const editableBlob = await pptxToBlob(createGordenSkillEditablePptx(editableSlides, opts.topic))

  opts.onProgress?.({ stage: 'package', message: 'Packaging manifests, prompts, layers, and PPTX files' })
  const artifactZipBlob = await buildArtifactZip({
    baseName,
    prepared,
    converted,
    imageDeckBlob,
    editableBlob,
    imageDeckFileName,
    editableFileName,
    topic: opts.topic,
  })

  return {
    baseName,
    imageDeckFileName,
    editableFileName,
    artifactZipFileName,
    imageDeckBlob,
    editableBlob,
    artifactZipBlob,
    imageDeckSlides,
    editableSlides,
  }
}

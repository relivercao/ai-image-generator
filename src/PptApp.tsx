import { useEffect, useMemo, useRef, useState } from 'react'
import { callImageApi } from './lib/api'
import { DEFAULT_RESPONSES_MODEL, getActiveApiProfile, normalizeSettings } from './lib/apiProfiles'
import { formatExportFileTime } from './lib/downloadImages'
import { DEFAULT_PPT_PARAMS, buildPptOutlineDraft, buildPptPromptPlan, clampSlideCount, type PptSlidePlan } from './lib/pptPromptPlan'
import { downloadImageSlidesAsPptx } from './lib/pptxExport'
import { downloadGordenSuperPptSkillResult, runGordenSuperPptSkillFlow, type GordenSkillSourceSlide } from './lib/gordenSuperPptSkillFlow'
import { normalizeParamsForSettings } from './lib/paramCompatibility'
import { DEFAULT_PPT_CONCURRENCY, clampPptConcurrency, runWithConcurrency } from './lib/pptConcurrency'
import { buildPptGenerationApiSettings, PPT_RECOMMENDED_RESPONSES_SIZE, PPT_RECOMMENDED_TIMEOUT_SECONDS, type PptGenerationMode } from './lib/pptApiSettings'
import { fetchImageUrlAsDataUrl, isDataUrl, isHttpUrl, MIME_MAP } from './lib/imageApiShared'
import { normalizeBaseUrl, readClientDevProxyConfig, shouldUseApiProxy } from './lib/devProxy'
import { callPptOutlineApi } from './lib/pptOutlineApi'
import { useStore } from './store'
import type { ApiProfile } from './types'

interface GeneratedSlide {
  plan: PptSlidePlan
  image?: string
  sourceImageUrl?: string
  imageWarning?: string
  imageLoadError?: string
  extraImageCount?: number
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  attempt?: number
  startedAt?: number
  finishedAt?: number
}

interface PptAppProps {
  embedded?: boolean
}

interface NormalizedSlideImage {
  image: string
  sourceImageUrl?: string
  warning?: string
}

interface SlideGenerationResult extends NormalizedSlideImage {
  extraImageCount: number
}

const MAX_SLIDE_RETRIES = 3
const MAX_SLIDE_ATTEMPTS = MAX_SLIDE_RETRIES + 1
const PPT_PARTIAL_FINALIZE_GRACE_MS = 45_000

const STYLE_PRESETS = [
  '清晰、专业、信息密度高的科技商务风格',
  '深色高对比、霓虹点缀、未来感数据看板',
  '白底极简、咨询报告风、细线图表与留白',
  '高级杂志感、强视觉主图、克制的品牌色',
]

function getPlainErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function summarizeRawResponsePayload(rawPayload: unknown): string {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) return ''

  try {
    const payload = JSON.parse(rawPayload) as Record<string, unknown>
    const keys = Object.keys(payload).slice(0, 12).join(', ') || '无'
    const output = Array.isArray(payload.output)
      ? payload.output.slice(0, 8).map((item) => {
          if (!item || typeof item !== 'object') return typeof item
          const record = item as Record<string, unknown>
          const type = typeof record.type === 'string' ? record.type : 'object'
          return `${type}(${Object.keys(record).slice(0, 8).join(',')})`
        }).join('; ')
      : ''
    const data = Array.isArray(payload.data) ? `data 数量 ${payload.data.length}` : ''
    return [`响应摘要：顶层字段 ${keys}`, output ? `output：${output}` : '', data].filter(Boolean).join('；')
  } catch {
    return `响应摘要：非 JSON 响应，长度 ${rawPayload.length}`
  }
}

function getErrorMessage(err: unknown): string {
  const message = getPlainErrorMessage(err)
  const record = err && typeof err === 'object' ? err as { rawResponsePayload?: unknown; rawImageUrls?: unknown } : null
  const rawImageUrls = Array.isArray(record?.rawImageUrls)
    ? record.rawImageUrls.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 3)
    : []
  const details = [
    rawImageUrls.length ? `图片 URL：${rawImageUrls.join('，')}` : '',
    summarizeRawResponsePayload(record?.rawResponsePayload),
  ].filter(Boolean).join('\n')
  return details ? `${message}\n${details}` : message
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function getSlideStatusText(slide: GeneratedSlide, now: number) {
  if (slide.status === 'pending') return '排队中'
  if (slide.status === 'running') {
    const elapsed = slide.startedAt ? ` · ${formatElapsed(now - slide.startedAt)}` : ''
    return slide.attempt && slide.attempt > 1 ? `重试中 ${slide.attempt - 1}/${MAX_SLIDE_RETRIES}${elapsed}` : `生成中${elapsed}`
  }
  if (slide.status === 'done') {
    const elapsed = slide.startedAt && slide.finishedAt ? ` · ${formatElapsed(slide.finishedAt - slide.startedAt)}` : ''
    return `已完成${elapsed}`
  }
  return '失败'
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isDarkStylePreset(style: string) {
  return /深色|暗黑|黑底|黑色|霓虹|dark/i.test(style)
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = dataUrl
  })
}

async function assertGeneratedSlideLooksUsable(dataUrl: string, options: { allowDarkCanvas: boolean }) {
  if (options.allowDarkCanvas) return
  if (dataUrl.length < 260000) {
    throw new Error('返回图片疑似未完成或信息量过低，已自动重试')
  }

  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let darkPixels = 0
  let sampledPixels = 0
  let luminanceSum = 0

  for (let y = 6; y < 58; y += 1) {
    for (let x = 4; x < 60; x += 1) {
      const offset = (y * canvas.width + x) * 4
      const alpha = data[offset + 3] / 255
      const luminance = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) * alpha
      sampledPixels += 1
      luminanceSum += luminance
      if (luminance < 14) darkPixels += 1
    }
  }

  const darkRatio = sampledPixels ? darkPixels / sampledPixels : 0
  const averageLuminance = sampledPixels ? luminanceSum / sampledPixels : 255
  if (darkRatio > 0.72 || averageLuminance < 32) {
    throw new Error('返回图片疑似未完成或主体为空，已自动重试')
  }
}

function createProxiedImageFetchUrl(imageUrl: string, profile: ApiProfile): string | null {
  const proxyConfig = readClientDevProxyConfig()
  if (!proxyConfig?.enabled || !shouldUseApiProxy(profile.apiProxy, proxyConfig)) return null

  try {
    const source = new URL(imageUrl)
    const target = new URL(normalizeBaseUrl(proxyConfig.target || profile.baseUrl))
    if (source.origin !== target.origin) return null

    const targetPath = target.pathname.replace(/\/+$/, '')
    let proxiedPath = source.pathname || '/'
    if (targetPath && targetPath !== '/') {
      if (proxiedPath === targetPath) {
        proxiedPath = '/'
      } else if (proxiedPath.startsWith(`${targetPath}/`)) {
        proxiedPath = proxiedPath.slice(targetPath.length) || '/'
      } else {
        return null
      }
    }

    return `${proxyConfig.prefix}${proxiedPath}${source.search}`
  } catch {
    return null
  }
}

async function normalizeSlideImageForDisplay(
  value: string,
  profile: ApiProfile,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<NormalizedSlideImage> {
  const image = value.trim()
  if (!isHttpUrl(image)) return { image }

  let directError = ''
  try {
    return {
      image: await fetchImageUrlAsDataUrl(image, fallbackMime, signal),
      sourceImageUrl: image,
    }
  } catch (err) {
    directError = getPlainErrorMessage(err)
  }

  const proxiedUrl = createProxiedImageFetchUrl(image, profile)
  if (proxiedUrl) {
    try {
      return {
        image: await fetchImageUrlAsDataUrl(proxiedUrl, fallbackMime, signal, {
          headers: profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : undefined,
        }),
        sourceImageUrl: image,
      }
    } catch (err) {
      return {
        image,
        sourceImageUrl: image,
        warning: `图片已生成，但转换为可导出的本地图片失败：${getPlainErrorMessage(err) || directError}`,
      }
    }
  }

  return {
    image,
    sourceImageUrl: image,
    warning: `图片已生成，但浏览器无法直接下载该图片链接：${directError}`,
  }
}

export default function PptApp({ embedded = false }: PptAppProps) {
  const settings = useStore((s) => s.settings)
  const normalizedSettings = useMemo(() => normalizeSettings(settings), [settings])
  const activeProfile = useMemo(() => getActiveApiProfile(normalizedSettings), [normalizedSettings])
  const [generationMode, setGenerationMode] = useState<PptGenerationMode>('gpt55')
  const pptApi = useMemo(() => buildPptGenerationApiSettings(normalizedSettings, generationMode), [normalizedSettings, generationMode])
  const pptProfile = pptApi.profile
  const [topic, setTopic] = useState('AI 产品发布会方案')
  const [content, setContent] = useState('背景与机会：市场对智能化工作流的需求快速增长，需要用清晰故事线解释产品价值。\n\n核心能力：多模态理解、自动化执行、知识库协同、可审计安全策略。\n\n落地路径：先做高频场景试点，再沉淀模板与指标体系，最后扩展到跨部门协同。\n\n商业价值：缩短交付周期、降低重复劳动、提升团队决策质量。')
  const [audience, setAudience] = useState('管理层、产品与市场团队')
  const [style, setStyle] = useState(STYLE_PRESETS[0])
  const [language, setLanguage] = useState('中文')
  const [slideCount, setSlideCount] = useState(6)
  const [concurrency, setConcurrency] = useState(DEFAULT_PPT_CONCURRENCY)
  const [slides, setSlides] = useState<GeneratedSlide[]>([])
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [outlineGenerating, setOutlineGenerating] = useState(false)
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const runIdRef = useRef(0)
  const slideControllersRef = useRef<Map<number, AbortController>>(new Map())
  const outlineControllerRef = useRef<AbortController | null>(null)
  const skillExportControllerRef = useRef<AbortController | null>(null)

  const completedSlides = slides.filter((slide) => slide.status === 'done' && Boolean(slide.image))
  const canExport = completedSlides.length > 0 && !running && !outlineGenerating
  const failedSlides = slides.filter((slide) => slide.status === 'error')
  const canRetryFailed = failedSlides.length > 0 && !running
  const apiModeLabel = pptProfile.apiMode === 'responses' ? 'Responses image_generation' : 'Images API'
  const channelMessage = pptApi.usingRecommendedModel
    ? `PPT 实际使用 ${apiModeLabel} / ${pptProfile.model}`
    : generationMode === 'gpt55' && activeProfile.provider !== 'openai'
    ? `当前服务商 ${activeProfile.provider} 不能切到 ${DEFAULT_RESPONSES_MODEL}，已使用当前配置`
    : `PPT 实际使用当前配置 / ${pptProfile.model}`

  useEffect(() => {
    if (!running) return
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [running])

  useEffect(() => {
    return () => {
      outlineControllerRef.current?.abort(new Error('PPT 页面已卸载'))
      skillExportControllerRef.current?.abort(new Error('PPT 页面已卸载'))
    }
  }, [])

  const abortActiveSlideRequests = (reason: string) => {
    for (const controller of slideControllersRef.current.values()) {
      controller.abort(new Error(reason))
    }
    slideControllersRef.current.clear()
  }

  const generateOutlineDraft = async () => {
    const nextSlideCount = clampSlideCount(slideCount)
    setSlideCount(nextSlideCount)
    const fallbackDraft = buildPptOutlineDraft({
      topic,
      content,
      audience,
      language,
      slideCount: nextSlideCount,
    })

    outlineControllerRef.current?.abort(new Error('新的大纲生成已开始'))
    const controller = new AbortController()
    outlineControllerRef.current = controller
    setOutlineGenerating(true)
    setMessage('正在从 LLM 重新生成大纲提示词...')

    try {
      const outline = await callPptOutlineApi({
        settings: pptApi.settings,
        profile: pptProfile,
        input: {
          topic,
          content,
          audience,
          language,
          slideCount: nextSlideCount,
        },
        signal: controller.signal,
      })
      setContent(outline)
      setMessage('已从 LLM 重新生成大纲提示词，可继续手动编辑')
    } catch (err) {
      if (controller.signal.aborted) return
      setContent(fallbackDraft)
      setMessage(`LLM 生成失败，已先填入本地备用大纲：${getErrorMessage(err)}`)
    } finally {
      if (outlineControllerRef.current === controller) {
        outlineControllerRef.current = null
        setOutlineGenerating(false)
      }
    }
  }

  const runSlideBatch = async (
    items: Array<{ plan: PptSlidePlan; slideIndex: number }>,
    runId: number,
    requestedConcurrency: number,
  ) => {
    const params = normalizeParamsForSettings(
      {
        ...DEFAULT_PPT_PARAMS,
        size: pptApi.usingRecommendedModel ? PPT_RECOMMENDED_RESPONSES_SIZE : DEFAULT_PPT_PARAMS.size,
      },
      pptApi.settings,
      { hasInputImages: false },
    )
    let successCount = 0
    let failCount = 0

    await runWithConcurrency(items, requestedConcurrency, async ({ plan: slidePlan, slideIndex }) => {
      try {
        const result = await generateSlideImage(slidePlan, slideIndex, runId, params)
        if (!result) return
        successCount = Math.min(items.length, successCount + 1)
        assignGeneratedImage(slideIndex, result)
      } catch (err) {
        if (runIdRef.current !== runId) return
        failCount += 1
        const error = getErrorMessage(err)
        setSlides((current) => current.map((item, i) =>
          i === slideIndex && item.status !== 'done'
            ? { ...item, status: 'error', error, attempt: MAX_SLIDE_ATTEMPTS, finishedAt: Date.now() }
            : item,
        ))
      }
    }, () => runIdRef.current === runId)

    return { successCount, failCount }
  }

  const assignGeneratedImage = (slideIndex: number, result: SlideGenerationResult) => {
    const finishedAt = Date.now()
    setSlides((current) =>
      current.map((item, index) => {
        if (index !== slideIndex) return item
        return {
          ...item,
          image: result.image,
          sourceImageUrl: result.sourceImageUrl,
          imageWarning: result.warning,
          imageLoadError: undefined,
          extraImageCount: result.extraImageCount,
          status: 'done',
          error: undefined,
          attempt: undefined,
          finishedAt,
          startedAt: item.startedAt ?? finishedAt,
        }
      }),
    )
  }

  const updateSlidePartialImage = (slideIndex: number, result: NormalizedSlideImage) => {
    setSlides((current) => current.map((item, i) =>
      i === slideIndex && item.status !== 'done'
        ? {
            ...item,
            image: result.image,
            sourceImageUrl: result.sourceImageUrl,
            imageWarning: result.warning,
            imageLoadError: undefined,
          }
        : item,
    ))
  }

  const markSlideImageLoadError = (slideIndex: number) => {
    setSlides((current) => {
      const item = current[slideIndex]
      if (!item || item.imageLoadError) return current
      return current.map((slide, i) => i === slideIndex
        ? { ...slide, imageLoadError: '图片预览加载失败，已保留原图链接，可重试或导出前重新生成。' }
        : slide,
      )
    })
  }

  const generateSlideImage = async (
    slidePlan: PptSlidePlan,
    slideIndex: number,
    runId: number,
    params: typeof DEFAULT_PPT_PARAMS,
  ): Promise<SlideGenerationResult | null> => {
    let lastError = ''
    const fallbackMime = MIME_MAP[params.output_format] || 'image/png'

    for (let attempt = 1; attempt <= MAX_SLIDE_ATTEMPTS; attempt++) {
      if (runIdRef.current !== runId) return null
      const controller = new AbortController()
      slideControllersRef.current.set(slideIndex, controller)
      setSlides((current) => current.map((item, i) => i === slideIndex ? { ...item, status: 'running', error: undefined, attempt, startedAt: Date.now(), finishedAt: undefined } : item))
      let partialFallbackTimer: number | undefined

      try {
        let partialAccepted = false
        let latestPartial: NormalizedSlideImage | null = null
        let resolvePartialFallback: ((result: NormalizedSlideImage) => void) | null = null
        const partialFallback = new Promise<NormalizedSlideImage>((resolve) => {
          resolvePartialFallback = resolve
        })
        const schedulePartialFallback = (partialResult: NormalizedSlideImage) => {
          latestPartial = partialResult
          if (partialFallbackTimer) window.clearTimeout(partialFallbackTimer)
          partialFallbackTimer = window.setTimeout(() => {
            if (latestPartial) resolvePartialFallback?.(latestPartial)
          }, PPT_PARTIAL_FINALIZE_GRACE_MS)
        }

        const apiResultPromise = callImageApi({
          settings: pptApi.settings,
          prompt: slidePlan.prompt,
          params,
          inputImageDataUrls: [],
          signal: controller.signal,
          allowRawImageUrls: true,
          onPartialImage: (partial) => {
            void normalizeSlideImageForDisplay(partial.image, pptProfile, fallbackMime, controller.signal)
              .then((partialResult) => {
                if (runIdRef.current !== runId) return
                updateSlidePartialImage(slideIndex, partialResult)
                schedulePartialFallback(partialResult)
              })
              .catch((partialError) => {
                console.warn('PPT partial image normalization warning:', partialError)
              })
          },
        }).catch((err) => {
          if (partialAccepted) return null
          throw err
        })

        const settled = await Promise.race([
          apiResultPromise.then((result) => ({ kind: 'api' as const, result })),
          partialFallback.then((result) => ({ kind: 'partial' as const, result })),
        ])
        if (partialFallbackTimer) window.clearTimeout(partialFallbackTimer)

        if (settled.kind === 'partial') {
          partialAccepted = true
          controller.abort(new Error('已使用流式预览图完成本页'))
          const image = settled.result
          if (isDataUrl(image.image)) {
            try {
              await assertGeneratedSlideLooksUsable(image.image, { allowDarkCanvas: isDarkStylePreset(style) })
            } catch (inspectionError) {
              console.warn('PPT slide partial image inspection warning:', inspectionError)
            }
          }
          if (runIdRef.current !== runId) return null
          return {
            ...image,
            warning: image.warning,
            extraImageCount: 0,
          }
        }

        const result = settled.result
        if (!result) return null
        const normalizedImages = await Promise.all(
          result.images
            .filter(Boolean)
            .map((item) => normalizeSlideImageForDisplay(item, pptProfile, fallbackMime, controller.signal)),
        )
        const image = normalizedImages[0]
        if (!image) throw new Error('API 没有返回图片')
        if (isDataUrl(image.image)) {
          try {
            await assertGeneratedSlideLooksUsable(image.image, { allowDarkCanvas: isDarkStylePreset(style) })
          } catch (inspectionError) {
            console.warn('PPT slide image inspection warning:', inspectionError)
          }
        }
        if (runIdRef.current !== runId) return null
        return { ...image, extraImageCount: Math.max(0, normalizedImages.length - 1) }
      } catch (err) {
        if (runIdRef.current !== runId) return null
        lastError = getErrorMessage(err)
        if (attempt >= MAX_SLIDE_ATTEMPTS) break

        const waitMs = 1200 * attempt
        setSlides((current) => current.map((item, i) => i === slideIndex ? { ...item, status: 'running', error: `${lastError}，${Math.round(waitMs / 1000)} 秒后重试`, attempt } : item))
        await delay(waitMs)
      } finally {
        if (partialFallbackTimer) window.clearTimeout(partialFallbackTimer)
        if (slideControllersRef.current.get(slideIndex) === controller) {
          slideControllersRef.current.delete(slideIndex)
        }
      }
    }

    throw new Error(lastError || '生成失败')
  }

  const generate = async () => {
    abortActiveSlideRequests('新一轮生成已开始')
    const nextRunId = runIdRef.current + 1
    runIdRef.current = nextRunId
    setRunning(true)
    setMessage('')
    const requestedConcurrency = clampPptConcurrency(concurrency)
    setConcurrency(requestedConcurrency)
    setMessage(`正在生成，最多 ${requestedConcurrency} 页同时进行；每页失败最多自动重试 ${MAX_SLIDE_RETRIES} 次`)

    const plan = buildPptPromptPlan({
      topic,
      content,
      audience,
      style,
      language,
      slideCount: clampSlideCount(slideCount),
    })
    setSlides(plan.map((item) => ({ plan: item, status: 'pending' })))

    const { successCount, failCount } = await runSlideBatch(
      plan.map((item, slideIndex) => ({ plan: item, slideIndex })),
      nextRunId,
      requestedConcurrency,
    )

    if (runIdRef.current === nextRunId) {
      setRunning(false)
      setMessage(failCount > 0 ? `生成完成：成功 ${successCount} 页，失败 ${failCount} 页` : `生成完成：${successCount} 页`)
    }
  }

  const stop = () => {
    runIdRef.current += 1
    abortActiveSlideRequests('请求已停止')
    setRunning(false)
    setSlides((current) => current.map((slide) =>
      slide.status === 'running' || slide.status === 'pending'
        ? {
            ...slide,
            status: 'error',
            error: slide.status === 'pending' ? '已停止，未开始生成，可重试' : '已停止，可重试',
            finishedAt: Date.now(),
          }
        : slide,
    ))
    setMessage('已停止，未完成页可重试')
  }

  const retryFailedSlides = async () => {
    const retryItems = slides
      .map((slide, slideIndex) => ({ plan: slide.plan, slideIndex, status: slide.status }))
      .filter((item) => item.status === 'error')
      .map(({ plan, slideIndex }) => ({ plan, slideIndex }))
    if (!retryItems.length) return

    const nextRunId = runIdRef.current + 1
    runIdRef.current = nextRunId
    setRunning(true)
    const requestedConcurrency = clampPptConcurrency(concurrency)
    setConcurrency(requestedConcurrency)
    setMessage(`正在重试失败页，最多 ${requestedConcurrency} 页同时进行`)
    setSlides((current) => current.map((slide) => slide.status === 'error' ? { ...slide, status: 'pending', error: undefined, attempt: undefined, startedAt: undefined, finishedAt: undefined } : slide))

    const { successCount, failCount } = await runSlideBatch(retryItems, nextRunId, requestedConcurrency)
    if (runIdRef.current === nextRunId) {
      setRunning(false)
      setMessage(failCount > 0 ? `重试完成：成功 ${successCount} 页，仍失败 ${failCount} 页` : `重试完成：成功 ${successCount} 页`)
    }
  }

  const getCompletedSkillSlides = (): GordenSkillSourceSlide[] => slides
    .filter((slide) => slide.status === 'done' && Boolean(slide.image))
    .map((slide) => ({
      plan: slide.plan,
      image: slide.image!,
      sourceImageUrl: slide.sourceImageUrl,
    }))

  const downloadImageDeck = async () => {
    if (!canExport) return
    setExporting(true)
    setMessage('')
    try {
      const time = formatExportFileTime(new Date())
      const sourceSlides = getCompletedSkillSlides()
      const normalizedImages = await Promise.all(sourceSlides.map((slide) =>
        normalizeSlideImageForDisplay(slide.image, pptProfile, 'image/png'),
      ))
      if (normalizedImages.some((item) => !isDataUrl(item.image))) {
        throw new Error('图片型 PPTX 需要可下载的本地图片数据，请开启 API 代理或返回 Base64 图片数据后重试')
      }
      const fileName = `${topic.trim() || 'ppt'}-${time}-image-deck.pptx`
      await downloadImageSlidesAsPptx(
        normalizedImages.map((item, index) => ({
          dataUrl: item.image,
          altText: sourceSlides[index]?.plan.title,
          notes: sourceSlides[index]?.plan.content,
        })),
        fileName,
        topic,
      )
      setMessage(`已下载 ${sourceSlides.length} 页图片型 PPTX`)
    } catch (err) {
      setMessage(getErrorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const exportPptx = async () => {
    if (!canExport) return
    const controller = new AbortController()
    skillExportControllerRef.current?.abort(new Error('新的 Skill 导出已开始'))
    skillExportControllerRef.current = controller
    setExporting(true)
    setMessage('Gorden Super PPT Skills：开始 A→B 四层可编辑转换')
    try {
      const time = formatExportFileTime(new Date())
      const sourceSlides = getCompletedSkillSlides()
      const normalizedImages = await Promise.all(sourceSlides.map((slide) =>
        normalizeSlideImageForDisplay(slide.image, pptProfile, 'image/png', controller.signal),
      ))
      if (normalizedImages.some((item) => !isDataUrl(item.image))) {
        throw new Error('Gorden 可编辑 PPTX 需要可下载的本地图片数据，请开启 API 代理或返回 Base64 图片数据后重试')
      }
      const result = await runGordenSuperPptSkillFlow({
        topic,
        baseName: `${topic.trim() || 'ppt'}-${time}`,
        slides: sourceSlides.map((slide, index) => ({
          ...slide,
          image: normalizedImages[index]?.image || slide.image,
        })),
        settings: pptApi.settings,
        profile: pptProfile,
        concurrency,
        signal: controller.signal,
        onProgress: (progress) => setMessage(`Gorden Super PPT Skills：${progress.message}`),
      })
      downloadGordenSuperPptSkillResult(result)
      setMessage(`已下载 ${result.editableSlides.length} 页：图片型 PPTX、四层可编辑 PPTX、Skill 产物包`)
    } catch (err) {
      if (!controller.signal.aborted) setMessage(getErrorMessage(err))
    } finally {
      if (skillExportControllerRef.current === controller) {
        skillExportControllerRef.current = null
      }
      setExporting(false)
    }
  }

  return (
    <div className={`${embedded ? 'min-h-[calc(100vh-80px)]' : 'min-h-screen'} bg-[#f7f8fb] text-gray-900 dark:bg-gray-950 dark:text-gray-100`}>
      {!embedded && (
      <header className="border-b border-gray-200/70 bg-white/85 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-lg font-semibold tracking-normal">PPT 生成器</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>{activeProfile.name}</span>
              <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-700" />
              <span>PPT 使用 {pptProfile.provider}</span>
              <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-700" />
              <span>{apiModeLabel}</span>
              <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-700" />
              <span>{pptProfile.model}</span>
            </div>
          </div>
          <a
            href="./index.html"
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]"
          >
            返回图片生成
          </a>
        </div>
      </header>
      )}

      <main className={`mx-auto grid max-w-7xl gap-5 px-4 sm:px-6 lg:grid-cols-[390px_1fr] ${embedded ? 'pb-8 pt-5' : 'py-5'}`}>
        <section className="h-fit rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">主题</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
              />
            </label>

            <div className="block">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="ppt-outline-input" className="block text-sm font-medium">内容 / 大纲</label>
                <button
                  type="button"
                  onClick={() => { void generateOutlineDraft() }}
                  disabled={running || outlineGenerating || (!topic.trim() && !content.trim())}
                  className="shrink-0 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/15"
                >
                  {outlineGenerating ? '生成中...' : '一键生成提示词'}
                </button>
              </div>
              <textarea
                id="ppt-outline-input"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={7}
                placeholder="可以手动输入大纲，也可以先填写主题和素材后一键生成。"
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">页数</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={slideCount}
                  onChange={(e) => setSlideCount(clampSlideCount(Number(e.target.value)))}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">并行</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={concurrency}
                  onChange={(e) => setConcurrency(clampPptConcurrency(Number(e.target.value)))}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">语言</span>
                <input
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">受众</span>
                <input
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
                />
              </label>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">风格</span>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
              >
                {STYLE_PRESETS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">生图通道</span>
              <select
                value={generationMode}
                onChange={(e) => setGenerationMode(e.target.value as PptGenerationMode)}
                disabled={running}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-gray-950 dark:focus:ring-blue-500/20"
              >
                <option value="gpt55">GPT-5.5 图片通道（推荐）</option>
                <option value="current">当前 API 配置</option>
              </select>
            </label>

            <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700 dark:border-blue-400/15 dark:bg-blue-400/10 dark:text-blue-200">
              {channelMessage}
              {pptApi.usingRecommendedModel && (
                <span>，超时 {PPT_RECOMMENDED_TIMEOUT_SECONDS}s，画布使用 {PPT_RECOMMENDED_RESPONSES_SIZE}，导出时按 16:9 安全区裁切。</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="min-w-[120px] flex-1 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200"
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { void generate() }}
                  className="min-w-[120px] flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!topic.trim() && !content.trim()}
                >
                  生成幻灯片
                </button>
              )}
              {canRetryFailed && (
                <button
                  type="button"
                  onClick={() => { void retryFailedSlides() }}
                  className="min-w-[120px] flex-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 shadow-sm transition hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15"
                >
                  重试失败页
                </button>
              )}
              <button
                type="button"
                onClick={() => { void downloadImageDeck() }}
                disabled={!canExport || exporting}
                className="min-w-[120px] flex-1 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-gray-100 dark:hover:bg-white/[0.1]"
              >
                {exporting ? '下载中' : '下载图片 PPTX'}
              </button>
              <button
                type="button"
                onClick={() => { void exportPptx() }}
                disabled={!canExport || exporting}
                className="min-w-[120px] flex-1 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/15"
              >
                {exporting ? '转换中' : 'Gorden 可编辑 PPTX'}
              </button>
            </div>

            {message && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                {message}
              </div>
            )}
          </div>
        </section>

        <section className="min-h-[70vh]">
          {slides.length === 0 ? (
            <div className="flex min-h-[70vh] items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-sm text-gray-400 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-gray-500">
              等待生成
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {slides.map((slide, slideIndex) => (
                <article key={slide.plan.index} className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
                  <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-white/[0.06]">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{String(slide.plan.index).padStart(2, '0')} · {slide.plan.title}</div>
                      <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{getSlideStatusText(slide, now)}</div>
                    </div>
                  </div>
                  <div className="aspect-video bg-gray-100 dark:bg-gray-900">
                    {slide.image ? (
                      <div className="relative h-full w-full">
                        <img
                          src={slide.image}
                          alt={slide.plan.title}
                          className="h-full w-full object-cover"
                          onError={() => markSlideImageLoadError(slideIndex)}
                        />
                        {(slide.imageWarning || slide.imageLoadError || slide.extraImageCount || slide.sourceImageUrl) && (
                          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 bg-black/65 px-2.5 py-1.5 text-[11px] leading-snug text-white">
                            {slide.imageLoadError && <span>{slide.imageLoadError}</span>}
                            {!slide.imageLoadError && slide.imageWarning && <span>{slide.imageWarning}</span>}
                            {Boolean(slide.extraImageCount) && <span>接口额外返回 {slide.extraImageCount} 张，已保留本页首图</span>}
                            {slide.sourceImageUrl && (
                              <a
                                href={slide.sourceImageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-semibold underline decoration-white/60 underline-offset-2"
                              >
                                打开原图
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-400 dark:text-gray-500">
                        <span className="whitespace-pre-line">
                          {slide.status === 'running' ? (slide.error || getSlideStatusText(slide, now)) : slide.status === 'error' ? slide.error : '排队中'}
                        </span>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

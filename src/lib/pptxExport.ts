import PptxGenJS from 'pptxgenjs'
import type { TaskRecord } from '../types'
import type { PptSlidePlan } from './pptPromptPlan'

export const PPTX_WIDE_LAYOUT = {
  name: 'LAYOUT_WIDE_CUSTOM',
  width: 13.333,
  height: 7.5,
} as const

export interface ImageSlide {
  dataUrl: string
  altText?: string
  notes?: string
}

export interface EditableSlide {
  index: number
  title: string
  content: string
  notes?: string
}

export interface GordenSkillTextBox {
  text: string
  x: number
  y: number
  w: number
  h: number
  size?: number
  sizeRatio?: number
  color?: string
  bold?: boolean
  align?: 'left' | 'center' | 'right' | 'justify'
  valign?: 'top' | 'middle' | 'bottom'
  font?: string
}

export interface GordenSkillIconLayer {
  dataUrl: string
  x: number
  y: number
  w: number
  h: number
  role?: string
}

export interface GordenSkillLayerSlide {
  index: number
  title: string
  sourceImage: string
  backgroundImage: string
  frameImage?: string
  iconsImage?: string
  icons?: GordenSkillIconLayer[]
  texts: GordenSkillTextBox[]
  notes?: string
}

export function toEditableSlidesFromPlans(plans: Array<Pick<PptSlidePlan, 'index' | 'title' | 'content'>>): EditableSlide[] {
  return plans.map((plan) => ({
    index: plan.index,
    title: sanitizeEditableText(plan.title),
    content: sanitizeEditableText(plan.content),
    notes: sanitizeEditableText(plan.content),
  }))
}

type TaskOutputSlideTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages'>

export function sanitizePptxFileName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 120)
}

export function ensurePptxExtension(fileName: string): string {
  const safeName = sanitizePptxFileName(fileName) || 'slides'
  return /\.pptx$/i.test(safeName) ? safeName : `${safeName}.pptx`
}

export function getTaskOutputImageSlideIds(tasks: TaskOutputSlideTask[]): string[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => task.outputImages || [])
}

export function toPptxImageData(dataUrl: string): string {
  return dataUrl.startsWith('data:') ? dataUrl.slice('data:'.length) : dataUrl
}

const EDITABLE_PPTX_W = PPTX_WIDE_LAYOUT.width
const EDITABLE_PPTX_H = PPTX_WIDE_LAYOUT.height
const EDITABLE_BG = 'F6F8FC'
const EDITABLE_PANEL = 'FFFFFF'
const EDITABLE_TEXT = '0F172A'
const EDITABLE_MUTED = '5B6473'
const EDITABLE_BORDER = 'D8DFEA'
const EDITABLE_BLUE = '2563EB'
const EDITABLE_TEAL = '0F9F9B'
const EDITABLE_AMBER = 'D97706'
const EDITABLE_VIOLET = '7C3AED'

function sanitizeEditableText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeOutlineLine(line: string): string {
  return sanitizeEditableText(line)
    .replace(/^\s*(?:幻灯片|slide|page|p)\s*\d+\s*[:：.、-]?\s*/i, '')
    .replace(/^\s*第\s*[一二三四五六七八九十\d]+\s*(?:页|张|章|节|部分)\s*[:：.、-]?\s*/, '')
    .replace(/^\s*(?:目标|要点|画面建议|核心信息|支撑要点|视觉建议|结论)\s*[:：]\s*/g, '')
    .replace(/^\s*(?:[-*•]|[0-9]+[.)、])\s*/, '')
    .trim()
}

function extractEditableLines(content: string, title: string): string[] {
  const titleNorm = normalizeOutlineLine(title).toLowerCase()
  const rawLines = sanitizeEditableText(content)
    .split(/\n+/g)
    .map(normalizeOutlineLine)
    .filter(Boolean)

  const result: string[] = []
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/^[：:]\s*/, '').trim()
    if (!line) continue
    if (line.toLowerCase() === titleNorm) continue

    const fragments = line.length > 80
      ? line.split(/[。；;.!?！？]\s*/g).map((item) => item.trim()).filter(Boolean)
      : [line]

    for (const fragment of fragments) {
      const cleaned = fragment.replace(/^[-*•]\s*/, '').trim()
      if (!cleaned) continue
      if (cleaned.toLowerCase() === titleNorm) continue
      result.push(cleaned)
    }
  }

  const deduped = Array.from(new Set(result))
  if (!deduped.length) {
    return [title, '围绕主题补充关键判断、证据和动作。', '将内容保持为可直接编辑的 PPT 文本。']
  }
  return deduped
}

function takeLines(lines: string[], start: number, count: number): string[] {
  return lines.slice(start, start + count)
}

function formatBulletLines(lines: string[]): string {
  return lines.map((line) => `• ${line}`).join('\n')
}

function addPanel(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number, accent: string, title: string, body: string) {
  slide.addShape('roundRect' as never, {
    x,
    y,
    w,
    h,
    fill: { color: EDITABLE_PANEL },
    line: { color: EDITABLE_BORDER, pt: 1 },
  } as never)
  slide.addShape('rect' as never, {
    x,
    y,
    w: 0.09,
    h,
    fill: { color: accent },
    line: { color: accent, pt: 0 },
  } as never)
  slide.addText(title, {
    x: x + 0.18,
    y: y + 0.12,
    w: w - 0.28,
    h: 0.28,
    fontFace: 'Aptos',
    fontSize: 12,
    bold: true,
    color: accent,
    margin: 0,
  })
  slide.addText(body, {
    x: x + 0.18,
    y: y + 0.42,
    w: w - 0.28,
    h: h - 0.52,
    fontFace: 'Aptos',
    fontSize: 12,
    color: EDITABLE_TEXT,
    margin: 0,
    fit: 'shrink',
    valign: 'top',
  } as never)
}

function addEditableSlideHeader(slide: PptxGenJS.Slide, index: number, title: string, accent: string, subtitle?: string) {
  slide.addShape('rect' as never, {
    x: 0,
    y: 0,
    w: EDITABLE_PPTX_W,
    h: EDITABLE_PPTX_H,
    fill: { color: EDITABLE_BG },
    line: { color: EDITABLE_BG, pt: 0 },
  } as never)
  slide.addShape('rect' as never, {
    x: 0.58,
    y: 0.42,
    w: 0.36,
    h: 0.1,
    fill: { color: accent },
    line: { color: accent, pt: 0 },
  } as never)
  slide.addText(String(index).padStart(2, '0'), {
    x: 0.98,
    y: 0.3,
    w: 0.6,
    h: 0.2,
    fontFace: 'Aptos',
    fontSize: 10,
    bold: true,
    color: accent,
    margin: 0,
  })
  slide.addText(title, {
    x: 0.58,
    y: 0.78,
    w: 8.9,
    h: 0.62,
    fontFace: 'Aptos',
    fontSize: 28,
    bold: true,
    color: EDITABLE_TEXT,
    margin: 0,
    fit: 'shrink',
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.6,
      y: 1.45,
      w: 8.3,
      h: 0.28,
      fontFace: 'Aptos',
      fontSize: 11,
      color: EDITABLE_MUTED,
      margin: 0,
    })
  }
}

function pickAccent(index: number): string {
  const accents = [EDITABLE_BLUE, EDITABLE_TEAL, EDITABLE_AMBER, EDITABLE_VIOLET]
  return accents[(index - 1) % accents.length] ?? EDITABLE_BLUE
}

function createEditablePptLayout(slide: PptxGenJS.Slide, item: EditableSlide, totalSlides: number) {
  const accent = pickAccent(item.index)
  const lines = extractEditableLines(item.content, item.title)
  const isCover = item.index === 1
  const isClosing = totalSlides > 1 && item.index === totalSlides
  const lead = lines[0] ?? item.title
  const support = takeLines(lines, 1, 3)
  const tail = takeLines(lines, 4, 3)

  addEditableSlideHeader(
    slide,
    item.index,
    item.title,
    accent,
    isCover ? '可编辑 PPTX' : isClosing ? '总结与下一步' : '内容页',
  )

  if (isCover) {
    slide.addShape('roundRect' as never, {
      x: 0.58,
      y: 1.95,
      w: 6.8,
      h: 3.7,
      fill: { color: EDITABLE_PANEL },
      line: { color: EDITABLE_BORDER, pt: 1 },
    } as never)
    slide.addText(lead, {
      x: 0.84,
      y: 2.2,
      w: 6.1,
      h: 1.2,
      fontFace: 'Aptos',
      fontSize: 19,
      bold: true,
      color: EDITABLE_TEXT,
      margin: 0,
      fit: 'shrink',
    })
    slide.addText(formatBulletLines(support.length ? support : lines.slice(1, 4)), {
      x: 0.88,
      y: 3.6,
      w: 6.1,
      h: 1.45,
      fontFace: 'Aptos',
      fontSize: 13,
      color: EDITABLE_TEXT,
      margin: 0,
      fit: 'shrink',
      valign: 'top',
    })

    const cardTexts = [
      lines[1] ?? '围绕当前主题补全核心判断。',
      lines[2] ?? '把内容整理成可直接编辑的页内文本。',
      lines[3] ?? '保留结构，但去掉页码和干扰标记。',
    ]
    cardTexts.forEach((text, idx) => {
      addPanel(
        slide,
        7.68,
        1.95 + idx * 1.16,
        4.98,
        0.98,
        accent,
        ['摘要', '依据', '动作'][idx] ?? '要点',
        text,
      )
    })
    return
  }

  if (isClosing) {
    addPanel(
      slide,
      0.58,
      1.95,
      6.2,
      4.22,
      accent,
      '结论',
      formatBulletLines([lead, ...support].filter(Boolean).slice(0, 4)),
    )
    const actionLines = tail.length ? tail : support.length ? support : lines.slice(1, 4)
    addPanel(
      slide,
      7.0,
      1.95,
      5.66,
      1.26,
      accent,
      '下一步',
      actionLines[0] ?? '明确试点场景和落地节奏。',
    )
    addPanel(
      slide,
      7.0,
      3.36,
      5.66,
      1.26,
      accent,
      '执行',
      actionLines[1] ?? '让内容能够直接被 PPT 编辑和复用。',
    )
    addPanel(
      slide,
      7.0,
      4.77,
      5.66,
      1.26,
      accent,
      '收束',
      actionLines[2] ?? '输出一版完整、可修改、可交付的 PPT。',
    )
    return
  }

  addPanel(
    slide,
    0.58,
    1.95,
    7.0,
    4.35,
    accent,
    '主线',
    formatBulletLines([lead, ...support].filter(Boolean).slice(0, 4)),
  )

  const rightLines = tail.length ? tail : lines.slice(1, 4)
  const rightCards = [
    rightLines[0] ?? '补充证据、场景和动作。',
    rightLines[1] ?? '保持每页内容都能直接编辑。',
    rightLines[2] ?? '让 PPT 成为真正可修改的成品。',
  ]
  rightCards.forEach((text, idx) => {
    addPanel(
      slide,
      7.88,
      1.95 + idx * 1.34,
      4.78,
      1.12,
      accent,
      ['判断', '证据', '动作'][idx] ?? '要点',
      text,
    )
  })
}

export function createEditableSlidesPptx(slides: EditableSlide[], title = 'PPT Deck') {
  const pptx = new PptxGenJS()
  pptx.author = 'gpt_image_playground'
  pptx.company = 'gpt_image_playground'
  pptx.subject = title
  pptx.title = title
  pptx.defineLayout({
    name: PPTX_WIDE_LAYOUT.name,
    width: PPTX_WIDE_LAYOUT.width,
    height: PPTX_WIDE_LAYOUT.height,
  })
  pptx.layout = PPTX_WIDE_LAYOUT.name
  pptx.theme = {
    headFontFace: 'Aptos',
    bodyFontFace: 'Aptos',
    lang: 'zh-CN',
  } as never

  slides.forEach((item) => {
    const slide = pptx.addSlide()
    createEditablePptLayout(slide, item, slides.length)
  })

  return pptx
}

export async function downloadEditableSlidesAsPptx(slides: EditableSlide[], fileName: string, title?: string): Promise<string> {
  if (slides.length === 0) throw new Error('没有可导出的幻灯片')
  const pptx = createEditableSlidesPptx(slides, title || sanitizePptxFileName(fileName) || 'PPT Deck')
  const safeFileName = ensurePptxExtension(fileName)
  await pptx.writeFile({ fileName: safeFileName, compression: true })
  return safeFileName
}

export function createImageSlidesPptx(slides: ImageSlide[], title = 'Image Deck') {
  const pptx = new PptxGenJS()
  pptx.author = 'gpt_image_playground'
  pptx.company = 'gpt_image_playground'
  pptx.subject = title
  pptx.title = title
  pptx.defineLayout({
    name: PPTX_WIDE_LAYOUT.name,
    width: PPTX_WIDE_LAYOUT.width,
    height: PPTX_WIDE_LAYOUT.height,
  })
  pptx.layout = PPTX_WIDE_LAYOUT.name

  for (const [index, item] of slides.entries()) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addImage({
      data: toPptxImageData(item.dataUrl),
      x: 0,
      y: 0,
      w: PPTX_WIDE_LAYOUT.width,
      h: PPTX_WIDE_LAYOUT.height,
      sizing: {
        type: 'cover',
        w: PPTX_WIDE_LAYOUT.width,
        h: PPTX_WIDE_LAYOUT.height,
      },
      altText: item.altText || `Slide ${index + 1}`,
    })
    if (item.notes?.trim()) slide.addNotes(item.notes.trim())
  }

  return pptx
}

function clampFraction(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function normalizeHexColor(value: string | undefined, fallback = EDITABLE_TEXT): string {
  const raw = (value || '').trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(raw)) return raw.split('').map((ch) => `${ch}${ch}`).join('').toUpperCase()
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase()
  return fallback
}

function getSkillTextSize(text: GordenSkillTextBox): number {
  if (Number.isFinite(text.size) && text.size) {
    return Math.max(6, Math.min(72, Number(text.size)))
  }
  if (Number.isFinite(text.sizeRatio) && text.sizeRatio) {
    return Math.max(6, Math.min(72, Number(text.sizeRatio) * EDITABLE_PPTX_H * 72))
  }
  return 14
}

export function createGordenSkillEditablePptx(slides: GordenSkillLayerSlide[], title = 'Gorden Super PPT') {
  const pptx = new PptxGenJS()
  pptx.author = 'Gorden Super PPT Skills'
  pptx.company = 'gpt_image_playground'
  pptx.subject = title
  pptx.title = title
  pptx.defineLayout({
    name: PPTX_WIDE_LAYOUT.name,
    width: PPTX_WIDE_LAYOUT.width,
    height: PPTX_WIDE_LAYOUT.height,
  })
  pptx.layout = PPTX_WIDE_LAYOUT.name
  pptx.theme = {
    headFontFace: 'Aptos',
    bodyFontFace: 'Aptos',
    lang: 'zh-CN',
  } as never

  for (const item of slides) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addImage({
      data: toPptxImageData(item.backgroundImage),
      x: 0,
      y: 0,
      w: PPTX_WIDE_LAYOUT.width,
      h: PPTX_WIDE_LAYOUT.height,
      altText: `Slide ${item.index} background`,
    })
    if (item.frameImage) {
      slide.addImage({
        data: toPptxImageData(item.frameImage),
        x: 0,
        y: 0,
        w: PPTX_WIDE_LAYOUT.width,
        h: PPTX_WIDE_LAYOUT.height,
        altText: `Slide ${item.index} frame layer`,
      })
    }
    if (item.icons?.length) {
      for (const icon of item.icons) {
        slide.addImage({
          data: toPptxImageData(icon.dataUrl),
          x: clampFraction(icon.x, 0) * PPTX_WIDE_LAYOUT.width,
          y: clampFraction(icon.y, 0) * PPTX_WIDE_LAYOUT.height,
          w: Math.max(0.01, clampFraction(icon.w, 0.05) * PPTX_WIDE_LAYOUT.width),
          h: Math.max(0.01, clampFraction(icon.h, 0.05) * PPTX_WIDE_LAYOUT.height),
          altText: icon.role || `Slide ${item.index} icon layer`,
        })
      }
    } else if (item.iconsImage) {
      slide.addImage({
        data: toPptxImageData(item.iconsImage),
        x: 0,
        y: 0,
        w: PPTX_WIDE_LAYOUT.width,
        h: PPTX_WIDE_LAYOUT.height,
        altText: `Slide ${item.index} icon layer`,
      })
    }

    for (const text of item.texts) {
      const x = clampFraction(text.x, 0.05) * PPTX_WIDE_LAYOUT.width
      const y = clampFraction(text.y, 0.05) * PPTX_WIDE_LAYOUT.height
      const w = Math.max(0.1, clampFraction(text.w, 0.3) * PPTX_WIDE_LAYOUT.width)
      const h = Math.max(0.1, clampFraction(text.h, 0.08) * PPTX_WIDE_LAYOUT.height)
      slide.addText(text.text, {
        x,
        y,
        w,
        h,
        fontFace: text.font || 'Microsoft YaHei',
        fontSize: getSkillTextSize(text),
        bold: Boolean(text.bold),
        color: normalizeHexColor(text.color),
        align: text.align || 'left',
        valign: text.valign || 'top',
        margin: 0,
        breakLine: false,
        fit: 'shrink',
      } as never)
    }

    if (item.notes?.trim()) slide.addNotes(item.notes.trim())
  }

  return pptx
}

export async function downloadGordenSkillEditablePptx(slides: GordenSkillLayerSlide[], fileName: string, title?: string): Promise<string> {
  if (slides.length === 0) throw new Error('No Gorden Super PPT Skill slides to export')
  const pptx = createGordenSkillEditablePptx(slides, title || sanitizePptxFileName(fileName) || 'Gorden Super PPT')
  const safeFileName = ensurePptxExtension(fileName)
  await pptx.writeFile({ fileName: safeFileName, compression: true })
  return safeFileName
}

export async function downloadImageSlidesAsPptx(slides: ImageSlide[], fileName: string, title?: string): Promise<string> {
  if (slides.length === 0) throw new Error('没有可导出的幻灯片')
  const pptx = createImageSlidesPptx(slides, title || sanitizePptxFileName(fileName) || 'Image Deck')
  const safeFileName = ensurePptxExtension(fileName)
  await pptx.writeFile({ fileName: safeFileName, compression: true })
  return safeFileName
}

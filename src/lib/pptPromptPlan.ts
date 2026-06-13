import { DEFAULT_PARAMS, type TaskParams } from '../types'

export interface PptPromptPlanInput {
  topic: string
  content: string
  audience: string
  style: string
  slideCount: number
  language: string
}

export interface PptOutlineDraftInput {
  topic: string
  content: string
  audience?: string
  language?: string
  slideCount: number
}

export interface PptSlidePlan {
  index: number
  title: string
  content: string
  prompt: string
}

interface SlideTextModule {
  label: string
  title: string
  bullets: string[]
  emphasis: string
  tag: string
}

interface VisualFramework {
  name: string
  layout: string
  chart: string
  icons: string[]
}

const DEFAULT_SLIDE_TITLES = [
  '封面',
  '背景与目标',
  '核心洞察',
  '方案框架',
  '关键模块',
  '执行路径',
  '资源与协同',
  '风险与对策',
  '阶段成果',
  '总结',
]

const DEFAULT_OUTLINE_SECTION_TITLES = [
  '背景与机会',
  '核心趋势',
  '关键洞察',
  '场景与价值',
  '能力框架',
  '落地路径',
  '资源协同',
  '风险与对策',
  '阶段成果',
]

export const DEFAULT_PPT_PARAMS: TaskParams = {
  ...DEFAULT_PARAMS,
  size: '1536x864',
  quality: 'high',
  output_format: 'png',
  n: 1,
  transparent_output: false,
}

const VISUAL_FRAMEWORKS: VisualFramework[] = [
  {
    name: '封面指标带 + 底部里程碑',
    layout: '上方大标题与副标题，标题下放 4 枚 KPI/关键词芯片；中部用一条横向视觉主轴串联主题关键词；底部通栏总结横幅。',
    chart: '封面 metric rail + 里程碑缎带',
    icons: ['聚光灯', '目标靶心', '增长箭头', '协同节点'],
  },
  {
    name: 'Bento 便当盒看板',
    layout: '左上大主卡承载核心判断，右侧两张窄卡做证据，底部三张等宽模块卡；所有卡片严格对齐，模块之间用细线连接。',
    chart: 'Bento Box 高密度信息看板',
    icons: ['看板', '列表', '趋势', '注释气泡'],
  },
  {
    name: '多层 3D 架构图',
    layout: '中部 3-5 层堆叠架构，每层放模块标签和关键要点；右侧竖向 KPI rail，底部放结论横幅。',
    chart: '多层 3D 架构 / 分层能力栈',
    icons: ['平台层', '数据流', '齿轮', '盾牌'],
  },
  {
    name: 'Hub-Spoke 放射图',
    layout: '中心圆承载核心命题，四周 4 个模块节点环绕，节点之间有流向连接线；左侧放导语，底部放行动横幅。',
    chart: '中心辐射概念地图',
    icons: ['中心枢纽', '连接节点', '指南针', '扩散箭头'],
  },
  {
    name: '鱼骨诊断图',
    layout: '横向主骨架贯穿页面，4 条分支分别承载原因、动作或风险；右侧放关键判断卡，底部放收敛结论。',
    chart: 'Ishikawa 鱼骨分析图',
    icons: ['诊断', '风险', '扳手', '检查清单'],
  },
  {
    name: '折叠阶梯路线图',
    layout: '中部用 4 段 3D 折叠阶梯或箭头表达阶段推进；每段挂载标题、要点和关键词芯片；顶部保留小节编号与导语。',
    chart: '3D 折叠阶梯 / 阶段路线图',
    icons: ['旗帜', '路线', '时钟', '交付物'],
  },
  {
    name: '双环协同图',
    layout: '两组交织圆环展示双轮驱动或协同关系，交叠区放核心价值；四角放注释卡，底部放总结横幅。',
    chart: '双圆交织 / 协同效应图',
    icons: ['双环', '握手', '循环', '价值'],
  },
  {
    name: '漏斗转化图',
    layout: '纵向或斜向漏斗分 4 层展示筛选、推进、转化；每层右侧挂载要点，左侧放关键词标签。',
    chart: '多层漏斗 / 取舍路径',
    icons: ['漏斗', '过滤', '箭头', '结果'],
  },
  {
    name: '同心圆雷达图',
    layout: '中心雷达圆环分 4 个扇区展示能力维度；外围放节点标签，右侧放小型证据列表，底部放结论。',
    chart: '同心圆雷达扫描图',
    icons: ['雷达', '扫描', '定位点', '能力维度'],
  },
  {
    name: '收尾行动矩阵',
    layout: '左侧大结论，右侧 2x2 行动矩阵；底部横幅强调下一步，顶部保持统一小节标题系统。',
    chart: '2x2 行动矩阵 + 下一步清单',
    icons: ['勾选', '行动', '负责人', '时间'],
  },
]

export function clampSlideCount(value: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(20, Math.max(1, Math.round(value)))
}

export function splitContentBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/g)
    .flatMap(splitDenseOutlineBlock)
    .map(stripLeadingBlockMarker)
    .filter(Boolean)
}

function splitDenseOutlineBlock(block: string): string[] {
  const lines = block.split(/\r?\n/g)
  const numberedLineIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (/^\s*(?:\d+[.)、]|第[一二三四五六七八九十]+[章节部分])/.test(line)) indexes.push(index)
    return indexes
  }, [])

  if (numberedLineIndexes.length > 1) {
    return numberedLineIndexes.map((startIndex, order) => {
      const endIndex = numberedLineIndexes[order + 1] ?? lines.length
      return lines.slice(startIndex, endIndex).join('\n')
    })
  }

  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean)
  if (numberedLineIndexes.length === 0 && nonEmptyLines.length > 1 && nonEmptyLines.every((line) => /^[-*•]\s*/.test(line))) {
    return nonEmptyLines
  }

  return [block]
}

function stripLeadingBlockMarker(block: string): string {
  return block
    .replace(/^\s*(?:幻灯片|slide|page|p)\s*\d+\s*[:：.、-]\s*/i, '')
    .replace(/^\s*第\s*[一二三四五六七八九十\d]+\s*(?:页|张|章|节|部分)\s*[:：.、-]?\s*/, '')
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '')
    .trim()
}

export function buildPptOutlineDraft(input: PptOutlineDraftInput): string {
  const topic = cleanText(input.topic) || '未命名主题'
  const count = clampSlideCount(input.slideCount)
  const audience = cleanText(input.audience ?? '') || '目标受众'
  const language = cleanText(input.language ?? '') || '中文'
  const blocks = splitContentBlocks(input.content)
  const fragments = splitIntoFragments(input.content)

  return Array.from({ length: count }, (_, i) => {
    const index = i + 1
    const title = getOutlineTitle({
      topic,
      blocks,
      index,
      count,
    })
    const focus = getOutlineFocus({
      topic,
      title,
      audience,
      language,
      fragments,
      blocks,
      index,
      count,
    })
    const support = getOutlineSupport({
      title,
      fragments,
      blocks,
      index,
      count,
    })
    const framework = getFramework(index, count)

    return [
      title,
      `- ${focus}`,
      `- ${support}`,
      `- ${framework.chart}，使用${framework.icons.slice(0, 3).join('、')}图标，保持模块化网格和清晰层级。`,
    ].join('\n')
  }).join('\n\n')
}

export function buildPptPromptPlan(input: PptPromptPlanInput): PptSlidePlan[] {
  const topic = input.topic.trim() || '未命名主题'
  const blocks = splitContentBlocks(input.content)
  const count = clampSlideCount(input.slideCount)
  const deckContent = blocks.length ? blocks.join('\n') : input.content.trim()

  return Array.from({ length: count }, (_, i) => {
    const index = i + 1
    const fallbackTitle = DEFAULT_SLIDE_TITLES[i] ?? `章节 ${index}`
    const isCover = index === 1
    const isClosing = index === count && count > 1
    const outlineTitle = isCover || isClosing ? null : pickOutlineTitleForSlide(blocks, index, count)
    const title = isCover ? topic : isClosing ? '总结与下一步' : outlineTitle ?? fallbackTitle
    const content = pickSlideContent({
      blocks,
      deckContent,
      topic,
      title,
      index,
      count,
    })

    return {
      index,
      title,
      content,
      prompt: buildImagePrompt({
        topic,
        title,
        content,
        audience: input.audience,
        style: input.style,
        language: input.language,
        index,
        count,
      }),
    }
  })
}

function getOutlineTitle(args: {
  topic: string
  blocks: string[]
  index: number
  count: number
}): string {
  const { topic, blocks, index, count } = args
  if (index === 1) return topic
  if (index === count && count > 1) return '总结与下一步'

  const fallback = DEFAULT_OUTLINE_SECTION_TITLES[index - 2] ?? `章节 ${index - 1}`
  const blockTitle = getSlideTitleFromBlock(blocks[index - 2])
  return blockTitle ?? fallback
}

function getOutlineFocus(args: {
  topic: string
  title: string
  audience: string
  language: string
  fragments: string[]
  blocks: string[]
  index: number
  count: number
}): string {
  const { topic, title, audience, language, fragments, blocks, index, count } = args
  if (index === 1) return `面向${audience}，用${language}说明“${topic}”的背景、机会和汇报目标。`
  if (index === count && count > 1) return `收束“${topic}”的关键判断，明确下一步行动、协同方式和验证指标。`

  const source = pickOutlineSourceText(fragments, blocks, index, count)
  if (source) return `围绕“${title}”提炼主要判断：${shortenOutlineText(source, 58)}`
  return `围绕“${title}”给出结构化判断、关键动作和可验证结果。`
}

function getOutlineSupport(args: {
  title: string
  fragments: string[]
  blocks: string[]
  index: number
  count: number
}): string {
  const { title, fragments, blocks, index, count } = args
  const selected = pickOutlineFragments(fragments, blocks, index, count)
  if (!selected.length) return `拆解“${title}”的 3 个要点，补充业务价值、执行动作和衡量口径。`
  return selected.map((item) => shortenOutlineText(item, 34)).join('；')
}

function pickOutlineSourceText(fragments: string[], blocks: string[], index: number, count: number): string {
  return pickOutlineFragments(fragments, blocks, index, count)[0] ?? ''
}

function pickOutlineFragments(fragments: string[], blocks: string[], index: number, count: number): string[] {
  if (fragments.length) {
    const contentSlideCount = Math.max(1, count - 2)
    const contentIndex = Math.max(0, index - 2)
    const start = Math.min(fragments.length - 1, Math.floor((contentIndex / contentSlideCount) * fragments.length))
    return fragments.slice(start, start + 3)
  }

  const block = blocks[index - 2]
  if (!block) return []
  return splitIntoFragments(block)
}

function shortenOutlineText(value: string, maxLength: number): string {
  const cleaned = cleanText(value)
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 3)}...`
}

function pickOutlineTitleForSlide(blocks: string[], index: number, count: number): string | null {
  if (!blocks.length || index <= 1 || (index === count && count > 1)) return null
  const directBlock = blocks[index - 2]
  if (directBlock) return getSlideTitleFromBlock(directBlock)

  const contentSlideCount = Math.max(1, count - 2)
  const distributedIndex = Math.floor(((index - 2) / contentSlideCount) * blocks.length)
  return getSlideTitleFromBlock(blocks[distributedIndex])
}

function getSlideTitleFromBlock(block: string | undefined): string | null {
  if (!block) return null
  const firstLine = block.split(/\r?\n/g).map((line) => line.trim()).find(Boolean)
  if (!firstLine) return null

  const withoutMarker = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^(?:幻灯片|slide)\s*\d+\s*[:：.、-]\s*/i, '')
    .replace(/^第\s*[一二三四五六七八九十\d]+\s*(?:页|章|节|部分)\s*[:：.、-]?\s*/, '')
    .replace(/^\d+\s*[.)、]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .trim()
  const heading = withoutMarker.split(/[：:]/)[0] || withoutMarker
  const candidate = cleanText(heading).replace(/[。；;,.，]$/, '')
  if (!candidate) return null
  return candidate.length > 28 ? `${candidate.slice(0, 25)}...` : candidate
}

function pickSlideContent(args: {
  blocks: string[]
  deckContent: string
  topic: string
  title: string
  index: number
  count: number
}): string {
  const { blocks, deckContent, topic, title, index, count } = args
  if (blocks.length >= count && blocks[index - 1]) return blocks[index - 1]
  if (index === 1 && deckContent.trim()) return deckContent
  if (index === count && count > 1 && deckContent.trim()) return deckContent

  const contentSlideCount = Math.max(1, count - 2)
  const blockIndex = Math.min(blocks.length - 1, Math.max(0, index - 2))
  if (blocks[blockIndex]) return blocks[blockIndex]

  if (blocks.length) {
    const distributedIndex = Math.floor(((index - 2) / contentSlideCount) * blocks.length)
    if (blocks[distributedIndex]) return blocks[distributedIndex]
  }

  return buildFallbackSlideContent(topic, title, index, count)
}

function buildFallbackSlideContent(topic: string, title: string, index: number, count: number): string {
  if (index === 1) return `${topic}\n面向汇报场景的高密度封面，包含主题、副标题、3 个关键词。`
  if (index === count) return `${topic}\n提炼关键结论、下一步行动和预期收益。`
  return `${topic}\n围绕“${title}”展开，给出 3-5 个结构化要点和 1 个关键指标或判断。`
}

function cleanText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[-*•]\s*/, '')
    .trim()
}

function splitIntoFragments(content: string): string[] {
  const normalized = content
    .split(/\r?\n/g)
    .map(cleanText)
    .filter(Boolean)
    .join('。')

  return normalized
    .split(/[。；;.!?！？]\s*/g)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 16)
}

function summarizeFragment(fragment: string, fallback: string): string {
  const cleaned = cleanText(fragment)
  if (!cleaned) return fallback
  const colonParts = cleaned.split(/[：:]/)
  const candidate = colonParts.length > 1 ? colonParts[0] : cleaned
  return candidate.length > 16 ? `${candidate.slice(0, 16)}…` : candidate
}

function getFragmentBody(fragment: string): string {
  const cleaned = cleanText(fragment)
  const colonParts = cleaned.split(/[：:]/)
  const candidate = colonParts.length > 1 ? colonParts.slice(1).join('：') : cleaned
  return candidate.length > 34 ? `${candidate.slice(0, 34)}…` : candidate
}

function extractNumbers(content: string): string[] {
  return Array.from(content.matchAll(/\d+(?:\.\d+)?\s*(?:%|倍|天|周|月|年|人|项|个|次|万|亿|元|美元|页|层|类|阶段|部门)?/g))
    .map((match) => match[0].replace(/\s+/g, ''))
    .filter(Boolean)
    .slice(0, 4)
}

function buildLead(title: string, fragments: string[]): string {
  const first = fragments[0] || title
  const second = fragments.find((item) => item !== first) || ''
  const lead = second ? `${first}，并通过“${summarizeFragment(second, title)}”形成可执行主线。` : `${first}。`
  return lead.length > 64 ? `${lead.slice(0, 64)}…` : lead
}

function buildBottomBanner(title: string, fragments: string[]): string {
  const last = fragments[fragments.length - 1]
  if (last) {
    const text = `结论：${last}`
    return text.length > 56 ? `${text.slice(0, 56)}…` : text
  }
  return `结论：围绕“${title}”形成清晰判断、关键动作与下一步节奏。`
}

function buildSlideModules(content: string, title: string): SlideTextModule[] {
  const fragments = splitIntoFragments(content)
  const numbers = extractNumbers(content)
  const moduleFallbacks = [
    ['核心命题', '主线', '从输入内容提炼当前页最重要的判断'],
    ['关键抓手', '动作', '把判断拆成可执行的工作模块'],
    ['协同机制', '组织', '明确相关角色、流程和约束关系'],
    ['验证方式', '结果', '用用户已提供的信息沉淀复盘口径'],
  ] as const

  return moduleFallbacks.map(([label, tag, fallback], index) => {
    const primary = fragments[index] || fragments[index % Math.max(1, fragments.length)] || fallback
    const secondary = fragments[index + 4] || fragments[index + 1] || fallback
    const titleText = summarizeFragment(primary, `${title}${index + 1}`)
    const body = getFragmentBody(primary)
    const secondBody = getFragmentBody(secondary)

    return {
      label,
      title: titleText,
      bullets: Array.from(new Set([body, secondBody, fallback].map(cleanText))).slice(0, 3),
      emphasis: numbers[index] || titleText,
      tag,
    }
  })
}

function getFramework(index: number, count: number): VisualFramework {
  if (count === 1) return VISUAL_FRAMEWORKS[1]
  if (index === 1) return VISUAL_FRAMEWORKS[0]
  if (index === count && count > 1) return VISUAL_FRAMEWORKS[VISUAL_FRAMEWORKS.length - 1]
  return VISUAL_FRAMEWORKS[((index - 2) % (VISUAL_FRAMEWORKS.length - 2)) + 1]
}

function formatModules(modules: SlideTextModule[]): string {
  return modules.map((item, index) => [
    `  ${index + 1}. 子标签「${item.label}」 标题「${item.title}」`,
    `     要点：「${item.bullets.join('」「')}」`,
    `     强调信息：「${item.emphasis}」 标签药丸：「${item.tag}」`,
  ].join('\n')).join('\n')
}

function buildImagePrompt(args: {
  topic: string
  title: string
  content: string
  audience: string
  style: string
  language: string
  index: number
  count: number
}): string {
  const audience = args.audience.trim() || '业务决策者'
  const style = args.style.trim() || '清晰、专业、信息密度高的科技商务风格'
  const language = args.language.trim() || '中文'
  const framework = getFramework(args.index, args.count)
  const fragments = splitIntoFragments(args.content)
  const modules = buildSlideModules(args.content, args.title)
  const lead = buildLead(args.title, fragments)
  const bottomBanner = buildBottomBanner(args.title, fragments)
  const sectionNo = String(args.index).padStart(2, '0')
  const role = args.count === 1 ? '单页总览' : args.index === 1 ? '封面' : args.index === args.count ? '结尾页' : '内容页'
  const prefersDark = /深色|暗黑|黑底|黑色|霓虹|dark/i.test(style)
  const backgroundRule = prefersDark
    ? '深色背景可以使用，但必须有细网格、分区线和可读浅色文字，所有主体容器都要填满真实内容。'
    : '背景必须完整铺满浅色冷白/浅灰；主体区域使用白色或极浅灰模块，深色只用于文字、图标和细线。'

  return [
    '生成一张完整的 16:9 PPT 幻灯片图片，宽屏横版，高分辨率，整页就是最终成品幻灯片位图。',
    '如果图像后端使用 1536x1024 或 3:2 画布，请把所有标题、正文、图表和关键视觉放在垂直居中的 16:9 安全区内，上下只放可裁切的淡背景纹理。',
    '只生成单页幻灯片，不要拼图、不要多页缩略图、不要模板占位图。',
    `整套主题：${args.topic}`,
    `当前页：第 ${args.index}/${args.count} 页`,
    `当前页角色：${role}`,
    `目标受众：${audience}`,
    `语言：${language}`,
    '',
    `【整体风格】${style}。全套统一配色：冷白背景 #F7F8FB、深墨文字 #102A43、主强调红 #D64545、辅助蓝 #2563EB、点睛琥珀 #F59E0B；少用绿色，避免大面积纯绿。${backgroundRule}`,
    `【本页核心信息】${lead}`,
    `【视觉框架】${framework.name}`,
    `【版式结构】顶部小节标题区：红色编号 ${sectionNo} + 粗体标题 + 短强调分割线 + 一行导语。主体采用${framework.layout} 右侧或四角加入 2-3 个 callout 标注，底部必须有通栏总结横幅。`,
    `【图表形式】${framework.chart}。要求信息密度高、模块化网格、细线连接、轻投影、清晰层级；至少 4 个模块，每个模块含子标签、标题、2-3 条要点、强调信息和标签药丸。`,
    `【图标/装饰】使用同风格扁平商务图标：${framework.icons.join('、')}；可加入进度条、节点编号、连接线、细网格背景，但不要盖住文字。`,
    '【完成度要求】主体区域必须由 4 个以上已填充内容的浅色模块组成；每个模块都显示上方页面文字中的真实标题、要点和强调信息，页面不能只有标题。',
    '',
    '【页面文字（逐字照排，必须完全使用以下文字；不要改写成其他语言；不要编造公司名、数值、奖项或事实）】',
    `  - 小节编号：「${sectionNo}」`,
    `  - 主标题：「${args.title}」`,
    `  - 导语：「${lead}」`,
    formatModules(modules),
    `  - 底部横幅：「${bottomBanner}」`,
    '',
    '【原始内容依据】',
    args.content,
    '',
    '【字号层级】强调信息最大，主标题第二，模块标题第三，正文要点清晰可读；中文使用微软雅黑/思源黑体风格无衬线字体。',
    '【硬约束】不要页码、logo、水印、lorem ipsum、TBD、N/A、占位框、乱码、无意义文字或空白模板。没有明确数值时不要创造假数字，用真实关键词或定性判断作为强调信息。所有文字必须保持在画面内，严格对齐，满而不乱。',
  ].join('\n')
}

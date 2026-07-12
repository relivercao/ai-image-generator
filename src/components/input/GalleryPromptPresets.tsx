import { PROMPT_TEMPLATE_CARDS, QUICK_STYLE_CHIPS } from '../../lib/galleryPromptTemplates'

interface GalleryPromptPresetsProps {
  onApplyPrompt: (prompt: string) => void
  onAppendStyle: (style: string) => void
}

export default function GalleryPromptPresets({ onApplyPrompt, onAppendStyle }: GalleryPromptPresetsProps) {
  return (
    <div className="mb-3 space-y-3">
      <div className="text-center text-xs text-gray-500 dark:text-gray-400">
        选择一组预设快速开始，或直接在下方描述你想要的画面
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {PROMPT_TEMPLATE_CARDS.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => onApplyPrompt(item.prompt)}
            className="group overflow-hidden rounded-lg border border-gray-200/70 bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-blue-400/50"
          >
            <div className={`relative h-20 overflow-hidden bg-gradient-to-br ${item.accent} sm:h-24`}>
              <img
                src={item.sample}
                alt={item.title}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-black/10" />
              <span className="absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">{item.ratio}</span>
            </div>
            <div className="space-y-1 p-2.5">
              <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{item.title}</div>
              <div className="line-clamp-2 min-h-[2.25rem] text-xs leading-relaxed text-gray-500 dark:text-gray-400">{item.summary}</div>
              <div className="text-[11px] font-medium text-teal-600 dark:text-teal-300">套用预设</div>
            </div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_STYLE_CHIPS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onAppendStyle(item)}
            className="rounded-full border border-gray-200/80 bg-white/75 px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:border-blue-400/50 dark:hover:text-blue-300"
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  )
}

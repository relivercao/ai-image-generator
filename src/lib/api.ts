import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { MAX_REFERENCE_IMAGES } from './referenceImages'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  if (opts.inputImageDataUrls.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张`)
  }
  const profile = getActiveApiProfile(opts.settings)
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}

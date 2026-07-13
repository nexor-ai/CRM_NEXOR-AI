import type { TemplatePayload } from './template-validators'

export async function ensureImageHeaderHandle(payload: TemplatePayload, _accessToken?: string): Promise<void> {
  // EVOLUTION: no Meta Resumable Upload or header_handle exists. Local presets
  // send header_media_url directly through Evolution sendMedia at send time.
  if (payload.header_type === 'image' && payload.header_media_url) {
    payload.header_handle = undefined
  }
}

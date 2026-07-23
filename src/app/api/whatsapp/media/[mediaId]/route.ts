import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const { mediaId } = await params
  // EVOLUTION: the Graph media-id download flow does not exist. Evolution
  // webhooks can include media as URL/base64; the webhook stores that value on
  // messages.media_url directly. This route remains as a compatibility guard.
  return NextResponse.json(
    { error: 'A API Evolution não expõe busca de mídia estilo Graph. Use o media_url armazenado da mensagem.', mediaId },
    { status: 410 }
  )
}

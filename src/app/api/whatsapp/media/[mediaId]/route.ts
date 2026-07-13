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
    { error: 'Evolution API does not expose Graph-style media lookup. Use the stored message media_url.', mediaId },
    { status: 410 }
  )
}

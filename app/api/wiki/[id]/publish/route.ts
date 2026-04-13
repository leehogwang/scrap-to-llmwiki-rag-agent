import { NextRequest, NextResponse } from 'next/server'
import { publishWikiDraft } from '@/lib/server/openai'

export const runtime = 'nodejs'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const result = await publishWikiDraft(id)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to publish wiki draft' },
      { status: 400 }
    )
  }
}

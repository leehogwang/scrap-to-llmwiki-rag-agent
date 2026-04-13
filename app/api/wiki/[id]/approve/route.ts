import { NextRequest, NextResponse } from 'next/server'
import { approveWikiDraft } from '@/lib/server/openai'

export const runtime = 'nodejs'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const draft = await approveWikiDraft(id)
    return NextResponse.json({ draft })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to approve wiki draft' },
      { status: 400 }
    )
  }
}

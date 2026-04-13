import { NextRequest, NextResponse } from 'next/server'
import { getWikiDraft } from '@/lib/server/db'

export const runtime = 'nodejs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const draft = getWikiDraft(id)
  if (!draft) {
    return NextResponse.json({ error: 'Wiki draft not found' }, { status: 404 })
  }
  return NextResponse.json({ draft })
}

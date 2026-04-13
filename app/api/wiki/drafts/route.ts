import { NextResponse } from 'next/server'
import { listWikiDraftSummaries } from '@/lib/server/db'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({
    drafts: listWikiDraftSummaries(200)
  })
}

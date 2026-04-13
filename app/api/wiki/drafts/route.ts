import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { archiveNotionPage } from '@/lib/server/notion'
import { deleteWikiDrafts, getWikiDrafts, listWikiDraftSummaries } from '@/lib/server/db'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({
    drafts: listWikiDraftSummaries(200)
  })
}

const deleteSchema = z.object({
  ids: z.array(z.string()).min(1).max(100)
})

export async function DELETE(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = deleteSchema.parse(json)
    const drafts = getWikiDrafts(parsed.ids)

    for (const draft of drafts) {
      if (draft.notionPageId) {
        await archiveNotionPage(draft.notionPageId)
      }
    }

    const deleted = deleteWikiDrafts(parsed.ids)
    return NextResponse.json({ deleted })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete wiki drafts' },
      { status: 400 }
    )
  }
}

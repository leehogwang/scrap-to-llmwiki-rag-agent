import { NextRequest, NextResponse } from 'next/server'
import { deleteScraps, getScrap, listScrapSummaries, searchScraps } from '@/lib/server/db'
import { archiveNotionPage } from '@/lib/server/notion'
import { z } from 'zod'

export const runtime = 'nodejs'

const deleteSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000)
})

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('query')?.trim() ?? ''
  const tags = request.nextUrl.searchParams.getAll('tag')
  if (query) {
    return NextResponse.json({
      scraps: searchScraps(query, 50, tags)
    })
  }
  return NextResponse.json({
    scraps: listScrapSummaries(200)
  })
}

export async function DELETE(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = deleteSchema.parse(json)
    const scraps = parsed.ids
      .map((id) => getScrap(id))
      .filter((scrap): scrap is NonNullable<ReturnType<typeof getScrap>> => Boolean(scrap))

    for (const scrap of scraps) {
      if (!scrap.notionPageId) continue
      await archiveNotionPage(scrap.notionPageId)
    }

    const deleted = deleteScraps(parsed.ids)
    return NextResponse.json({ deleted })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete scraps' },
      { status: 400 }
    )
  }
}

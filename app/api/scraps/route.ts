import { NextRequest, NextResponse } from 'next/server'
import { createId, deleteScraps, getScrap, listScrapSummaries, searchScraps, upsertScrap } from '@/lib/server/db'
import { archiveNotionPage, createScrapPageInNotion } from '@/lib/server/notion'
import { z } from 'zod'

export const runtime = 'nodejs'

const deleteSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000)
})

const createSchema = z.object({
  question: z.string().trim().min(1).max(50000),
  answer: z.string().trim().min(1).max(120000)
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

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = createSchema.parse(json)
    const capturedAt = new Date().toISOString()
    const mergedText = `사용자 질의 : ${parsed.question}\n\n대답 : ${parsed.answer}`
    const title = `Chat Q&A · ${parsed.question.slice(0, 64)}`
    const pageTitle = 'ClipWiki Chat Q&A'
    const sourceUrl = 'https://clipwiki.local/chat'
    const sourceHost = 'clipwiki.local'

    const notionResult = await createScrapPageInNotion({
      title,
      pageTitle,
      sourceUrl,
      sourceHost,
      ocrText: '',
      mergedText,
      captureType: 'dom',
      tags: ['chat', 'qa'],
      userNote: '',
      capturedAt,
      selectionRect: null,
      imageFiles: [],
      screenshotFile: null
    })

    const scrap = upsertScrap({
      id: createId('scrap'),
      notionPageId: notionResult.pageId,
      title,
      pageTitle,
      sourceUrl,
      sourceHost,
      selectedText: mergedText,
      anchorChunks: [],
      contextChunks: [],
      semanticChunks: [],
      selectionRect: null,
      ocrText: '',
      mergedText,
      captureType: 'dom',
      userNote: '',
      tags: ['chat', 'qa'],
      images: [],
      screenshot: null,
      metadata: {
        source: 'chat',
        question: parsed.question,
        answer: parsed.answer
      },
      capturedAt
    })

    return NextResponse.json({
      scrap: scrap
        ? {
            id: scrap.id,
            title: scrap.title,
            sourceUrl: scrap.sourceUrl,
            sourceHost: scrap.sourceHost,
            captureType: scrap.captureType,
            summary: scrap.mergedText.slice(0, 160),
            tags: scrap.tags,
            imageCount: scrap.images.length,
            semanticChunkCount: scrap.semanticChunks.length,
            capturedAt: scrap.capturedAt
          }
        : null
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create scrap' },
      { status: 400 }
    )
  }
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

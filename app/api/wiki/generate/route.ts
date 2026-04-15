import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getScrap, listScraps, listWikiDrafts } from '@/lib/server/db'
import { rebuildGraphifyPayload } from '@/lib/server/graphify'
import { createWikiDraftsFromSelection } from '@/lib/server/openai'

export const runtime = 'nodejs'

const requestSchema = z.object({
  topic: z.string().max(500).optional().default(''),
  selectedScrapIds: z.array(z.string()).optional().default([])
})

function buildGenerationMessage(drafts: Array<{ title: string; generationAction?: 'created' | 'updated' }>, topic: string, skippedUsedCount: number) {
  const createdCount = drafts.filter((draft) => draft.generationAction === 'created').length
  const updatedCount = drafts.filter((draft) => draft.generationAction === 'updated').length
  const skippedSummary = skippedUsedCount > 0 ? ` 이미 반영된 스크랩 ${skippedUsedCount}개는 제외했습니다.` : ''

  if (drafts.length === 0) {
    return skippedUsedCount > 0
      ? `선택한 스크랩은 모두 이미 위키에 반영되어 있어 새 초안을 만들지 않았습니다.${skippedSummary}`
      : '선택한 스크랩으로 만들 수 있는 새 위키 초안이 없습니다.'
  }

  if (drafts.length === 1) {
    const draft = drafts[0]
    if (draft.generationAction === 'updated') {
      return `기존 위키 "${draft.title}"를 업데이트했습니다.${skippedSummary}`
    }
    return topic.trim()
      ? `위키 초안 "${draft.title}"를 생성했습니다.${skippedSummary}`
      : `선택한 스크랩을 바탕으로 위키 초안 "${draft.title}"를 생성했습니다.${skippedSummary}`
  }

  const parts = [
    createdCount > 0 ? `새 생성 ${createdCount}개` : '',
    updatedCount > 0 ? `기존 업데이트 ${updatedCount}개` : ''
  ].filter(Boolean).join(' · ')

  return `선택한 스크랩을 주제별로 나눠 위키 초안 ${drafts.length}개를 처리했습니다.${parts ? ` (${parts})` : ''}${skippedSummary}`
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = requestSchema.parse(json)
    const selectedScraps = parsed.selectedScrapIds.length > 0
      ? parsed.selectedScrapIds
          .map((id) => getScrap(id))
          .filter((item): item is NonNullable<ReturnType<typeof getScrap>> => Boolean(item))
      : listScraps(1000)

    const assignedScrapIds = new Set(
      listWikiDrafts(500).flatMap((draft) => draft.scrapIds)
    )
    const scraps = selectedScraps.filter((scrap) => !assignedScrapIds.has(scrap.id))
    const skippedUsedCount = selectedScraps.length - scraps.length

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
        }

        try {
          if (scraps.length === 0) {
            send({
              type: 'result',
              payload: {
                blocked: false,
                message: buildGenerationMessage([], parsed.topic, skippedUsedCount),
                drafts: []
              }
            })
            controller.close()
            return
          }

          // Stream progress updates first, then emit one final payload for the client.
          const drafts = await createWikiDraftsFromSelection(parsed.topic, scraps, 'general', async (progress) => {
            send({ type: 'progress', ...progress })
          })
          // Rebuild Graphify after wiki generation so new wiki/claim/concept links are immediately visible.
          const graphPayload = await rebuildGraphifyPayload()

          const draft = drafts[0] ?? null
          if (!draft) {
            send({
              type: 'result',
              payload: {
                blocked: false,
                message: buildGenerationMessage([], parsed.topic, skippedUsedCount),
                drafts: [],
                graphPayload
              }
            })
            controller.close()
            return
          }

          send({
            type: 'result',
            payload: {
              blocked: false,
              message: buildGenerationMessage(drafts, parsed.topic, skippedUsedCount),
              draft,
              drafts,
              graphPayload
            }
          })
        } catch (error) {
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to generate wiki draft'
          })
        } finally {
          controller.close()
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: '위키 초안 요청 형식이 올바르지 않습니다. 다시 시도해 주세요.'
        },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate wiki draft' },
      { status: 400 }
    )
  }
}

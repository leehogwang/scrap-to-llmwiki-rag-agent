import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { listScraps, listWikiDrafts, setSystemMetaValue } from '@/lib/server/db'
import { rebuildGraphifyPayload } from '@/lib/server/graphify'
import {
  approveWikiDraft,
  createWikiDraftsFromSelection,
  publishWikiDraft,
  type WikiDraftProgress
} from '@/lib/server/openai'

export const runtime = 'nodejs'

const requestSchema = z.object({
  autoApprove: z.boolean().optional().default(false)
})

function getFreshUnassignedScraps() {
  const drafts = listWikiDrafts(1000)
  const assignedIds = new Set(drafts.flatMap((draft) => draft.scrapIds))
  return listScraps(1000).filter((scrap) => !assignedIds.has(scrap.id))
}

function buildMessage(drafts: Array<{ title: string; generationAction?: 'created' | 'updated' }>) {
  const createdCount = drafts.filter((draft) => draft.generationAction === 'created').length
  const updatedCount = drafts.filter((draft) => draft.generationAction === 'updated').length

  if (drafts.length === 0) {
    return '새로 정리할 스크랩이 없어 위키 초안을 만들지 않았습니다.'
  }

  if (drafts.length === 1) {
    const draft = drafts[0]
    return draft.generationAction === 'updated'
      ? `기존 위키 "${draft.title}"를 업데이트했습니다.`
      : `위키 초안 "${draft.title}"를 생성했습니다.`
  }

  const summary = [
    createdCount > 0 ? `새 생성 ${createdCount}개` : '',
    updatedCount > 0 ? `기존 업데이트 ${updatedCount}개` : ''
  ].filter(Boolean).join(' · ')

  return `${drafts.length}개의 위키 초안을 처리했습니다.${summary ? ` (${summary})` : ''}`
}

export async function POST(request: NextRequest) {
  try {
    const body = request.headers.get('content-type')?.includes('application/json')
      ? await request.json().catch(() => ({}))
      : {}
    const parsed = requestSchema.parse(body)
    const scraps = getFreshUnassignedScraps()
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
                ok: true,
                blocked: false,
                message: buildMessage([]),
                drafts: []
              }
            })
            controller.close()
            return
          }

          let drafts = await createWikiDraftsFromSelection('', scraps, 'general', async (progress: WikiDraftProgress) => {
            send({ type: 'progress', ...progress })
          })
          const autoApproved = parsed.autoApprove && drafts.length > 0
          if (autoApproved) {
            const finalized = []
            for (const draft of drafts) {
              const approved = await approveWikiDraft(draft.id)
              const published = await publishWikiDraft(approved.id)
              finalized.push(published.draft)
            }
            drafts = finalized
          }
          const graphPayload = await rebuildGraphifyPayload()

          setSystemMetaValue('wiki:last_manual_run_at', new Date().toISOString())

          send({
            type: 'result',
            payload: {
              ok: true,
              blocked: false,
              message: buildMessage(drafts),
              draft: drafts[0] ?? null,
              drafts,
              graphPayload,
              autoApproved
            }
          })
        } catch (error) {
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to auto-generate wiki drafts'
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to auto-generate wiki drafts' },
      { status: 400 }
    )
  }
}

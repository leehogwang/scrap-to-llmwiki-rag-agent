import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getScrap } from '@/lib/server/db'
import { createWikiDraftsFromSelection } from '@/lib/server/openai'

export const runtime = 'nodejs'
const maxSelectedScraps = 100

const requestSchema = z.object({
  topic: z.string().max(500).optional().default(''),
  selectedScrapIds: z.array(z.string()).min(1).max(maxSelectedScraps)
})

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = requestSchema.parse(json)
    const scraps = parsed.selectedScrapIds
      .map((id) => getScrap(id))
      .filter((item): item is NonNullable<ReturnType<typeof getScrap>> => Boolean(item))
    if (scraps.length === 0) {
      return NextResponse.json({ error: 'No valid scraps selected' }, { status: 400 })
    }
    const drafts = await createWikiDraftsFromSelection(parsed.topic, scraps, 'general')
    const draft = drafts[0] ?? null
    if (!draft) {
      return NextResponse.json({ error: 'No wiki draft could be created from the selected scraps' }, { status: 400 })
    }
    return NextResponse.json({
      blocked: false,
      message: parsed.topic?.trim()
        ? `위키 초안 "${draft.title}"를 생성했습니다.`
        : drafts.length > 1
          ? `선택한 스크랩을 주제별로 나눠 위키 초안 ${drafts.length}개를 생성했습니다.`
          : `선택한 스크랩을 바탕으로 위키 초안 "${draft.title}"를 생성했습니다.`,
      draft,
      drafts
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      const tooManyScraps = error.issues.some((issue) => issue.path[0] === 'selectedScrapIds' && issue.code === 'too_big')
      return NextResponse.json(
        {
          error: tooManyScraps
            ? `한 번에 최대 ${maxSelectedScraps}개의 스크랩만 위키 초안에 넣을 수 있습니다. 선택 수를 줄여 주세요.`
            : '위키 초안 요청 형식이 올바르지 않습니다. 스크랩을 다시 선택한 뒤 시도해 주세요.'
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

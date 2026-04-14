import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getWikiDraft } from '@/lib/server/db'
import { approveWikiDraft, publishWikiDraft } from '@/lib/server/openai'

export const runtime = 'nodejs'

const requestSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000)
})

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = requestSchema.parse(json)

    const drafts = []
    const errors: Array<{ id: string; message: string }> = []
    let approved = 0
    let published = 0
    let alreadyPublished = 0

    for (const id of parsed.ids) {
      try {
        const current = getWikiDraft(id)
        if (!current) {
          errors.push({ id, message: 'Wiki draft not found' })
          continue
        }

        if (current.status === 'published') {
          alreadyPublished += 1
          drafts.push(current)
          continue
        }

        if (current.status === 'draft') {
          await approveWikiDraft(id)
          approved += 1
        }

        const publishResult = await publishWikiDraft(id)
        published += 1
        drafts.push(publishResult.draft)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to approve wiki draft'
        errors.push({ id, message })
      }
    }

    return NextResponse.json({
      drafts,
      approved,
      published,
      alreadyPublished,
      errors
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to approve wiki drafts' },
      { status: 400 }
    )
  }
}

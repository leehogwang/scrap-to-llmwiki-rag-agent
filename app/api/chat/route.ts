import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { runClipWikiChat } from '@/lib/server/openai'

export const runtime = 'nodejs'

const requestSchema = z.object({
  prompt: z.string().min(3).max(50000),
  selectedScrapIds: z.array(z.string()).default([])
})

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = requestSchema.parse(json)
    const result = await runClipWikiChat(parsed)
    return NextResponse.json(result)
  } catch (error) {
    const isBadRequest = error instanceof z.ZodError
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run chat' },
      { status: isBadRequest ? 400 : 500 }
    )
  }
}

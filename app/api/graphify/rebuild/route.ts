import { NextResponse } from 'next/server'
import { rebuildGraphifyPayload } from '@/lib/server/graphify'

export const runtime = 'nodejs'

export async function POST() {
  try {
    const payload = await rebuildGraphifyPayload()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rebuild graph' },
      { status: 400 }
    )
  }
}

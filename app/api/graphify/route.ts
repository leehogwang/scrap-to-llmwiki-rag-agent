import { NextResponse } from 'next/server'
import { getGraphifyPayload, rebuildGraphifyPayload } from '@/lib/server/graphify'

export const runtime = 'nodejs'

export async function GET() {
  const payload = getGraphifyPayload()

  // Self-heal broken graph caches where nodes were written but no edges survived.
  if (payload.nodes.length > 0 && payload.edges.length === 0) {
    return NextResponse.json(await rebuildGraphifyPayload())
  }

  return NextResponse.json(payload)
}

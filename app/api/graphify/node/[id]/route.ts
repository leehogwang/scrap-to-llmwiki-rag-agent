import { NextRequest, NextResponse } from 'next/server'
import { getGraphifyNodeDetail } from '@/lib/server/graphify'

export const runtime = 'nodejs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = getGraphifyNodeDetail(decodeURIComponent(id))
  if (!detail) {
    return NextResponse.json({ error: 'Graph node not found' }, { status: 404 })
  }
  return NextResponse.json(detail)
}

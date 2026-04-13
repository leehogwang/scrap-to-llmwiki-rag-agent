import { NextResponse } from 'next/server'
import { getGraphifyPayload } from '@/lib/server/graphify'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(getGraphifyPayload())
}

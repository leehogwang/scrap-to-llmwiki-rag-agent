import fs from 'fs'
import os from 'os'
import path from 'path'

interface CodexAuth {
  accessToken: string
  accountId: string
}

let _cache: { auth: CodexAuth; mtime: number } | null = null

/**
 * Reads ~/.codex/auth.json and extracts the Bearer token and account ID.
 * Caches the result based on file mtime to avoid repeated disk reads.
 * Returns null if the file doesn't exist, can't be read, or lacks required fields.
 */
export function getCodexAuth(): CodexAuth | null {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json')

  try {
    const stats = fs.statSync(authFile)
    const mtime = stats.mtimeMs

    // Return cached value if file hasn't changed
    if (_cache && _cache.mtime === mtime) {
      return _cache.auth
    }

    const fileContent = fs.readFileSync(authFile, 'utf-8')
    const data = JSON.parse(fileContent)

    const accessToken: string = data?.tokens?.access_token
    if (!accessToken) {
      return null
    }

    const accountId: string = data?.tokens?.account_id ?? ''

    _cache = { auth: { accessToken, accountId }, mtime }
    return _cache.auth
  } catch {
    // File doesn't exist, can't be read, or JSON parse failed
    return null
  }
}

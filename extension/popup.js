const DEFAULT_BACKEND = 'http://222.116.135.238:3000'

const input = document.getElementById('backendUrl')
const saveButton = document.getElementById('saveButton')
const testButton = document.getElementById('testButton')
const openButton = document.getElementById('openButton')
const memoModeInput = document.getElementById('memoMode')
const statusNode = document.getElementById('status')

function normalizeUrl(value) {
  return value.trim().replace(/\/$/, '')
}

function setStatus(message, tone = '') {
  statusNode.textContent = message
  statusNode.className = `status ${tone}`.trim()
}

async function loadConfig() {
  const config = await chrome.storage.sync.get(['clipwikiBackendUrl', 'clipwikiMemoMode'])
  input.value = config.clipwikiBackendUrl || DEFAULT_BACKEND
  memoModeInput.checked = Boolean(config.clipwikiMemoMode)
  setStatus('Ready')
}

async function saveConfig() {
  const backendUrl = normalizeUrl(input.value || DEFAULT_BACKEND)
  if (!backendUrl) {
    setStatus('백엔드 주소를 입력하세요.', 'error')
    return
  }

  await chrome.storage.sync.set({
    clipwikiBackendUrl: backendUrl,
    clipwikiMemoMode: memoModeInput.checked
  })
  setStatus(`Saved: ${backendUrl}`, 'ok')
}

async function testConnection() {
  const backendUrl = normalizeUrl(input.value || DEFAULT_BACKEND)
  if (!backendUrl) {
    setStatus('백엔드 주소를 입력하세요.', 'error')
    return
  }

  setStatus('연결 확인 중...')
  try {
    const response = await fetch(`${backendUrl}/api/wiki/drafts`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    await chrome.storage.sync.set({ clipwikiBackendUrl: backendUrl })
    setStatus(`Connected: ${backendUrl}`, 'ok')
  } catch (error) {
    const message = error instanceof Error ? error.message : '연결 실패'
    setStatus(`연결 실패: ${message}`, 'error')
  }
}

function openDashboard() {
  const backendUrl = normalizeUrl(input.value || DEFAULT_BACKEND)
  chrome.tabs.create({ url: backendUrl })
}

memoModeInput.addEventListener('change', () => {
  void chrome.storage.sync.set({ clipwikiMemoMode: memoModeInput.checked }).then(() => {
    setStatus(memoModeInput.checked ? '메모 모드가 켜졌습니다.' : '메모 모드가 꺼졌습니다.', 'ok')
  })
})

saveButton.addEventListener('click', () => {
  void saveConfig()
})

testButton.addEventListener('click', () => {
  void testConnection()
})

openButton.addEventListener('click', openDashboard)

void loadConfig()

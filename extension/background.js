const DEFAULT_BACKEND = 'http://222.116.135.238:3000'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'clipwiki:capture-visible-tab') {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message })
        return
      }
      sendResponse({ dataUrl })
    })
    return true
  }

  if (message?.type === 'clipwiki:save-capture') {
    chrome.storage.sync.get(['clipwikiBackendUrl'], async (config) => {
      const backendUrl = (config.clipwikiBackendUrl || DEFAULT_BACKEND).replace(/\/$/, '')
      try {
        const formData = new FormData()
        formData.append('payload', JSON.stringify(message.payload))
        if (message.screenshotBlob) {
          formData.append('screenshot', message.screenshotBlob, 'capture-region.png')
        }
        const response = await fetch(`${backendUrl}/api/extension/capture`, {
          method: 'POST',
          body: formData
        })
        const json = await response.json()
        if (!response.ok) {
          sendResponse({ error: json.error || 'Failed to save scrap' })
          return
        }
        sendResponse({ scrap: json.scrap })
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : 'Failed to save scrap' })
      }
    })
    return true
  }
})

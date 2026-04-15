(function initClipWikiCapture() {
  if (window.__clipwikiCaptureLoaded) return
  window.__clipwikiCaptureLoaded = true

  let dragging = false
  let startX = 0
  let startY = 0
  let startTarget = null
  let suppressNextClickUntil = 0
  let overlay = null
  let selectionBox = null

  function ensureOverlay() {
    if (overlay) return
    overlay = document.createElement('div')
    overlay.style.position = 'fixed'
    overlay.style.inset = '0'
    overlay.style.zIndex = '2147483646'
    overlay.style.pointerEvents = 'none'
    overlay.style.background = 'rgba(10, 16, 30, 0.08)'
    overlay.style.display = 'none'

    selectionBox = document.createElement('div')
    selectionBox.style.position = 'fixed'
    selectionBox.style.border = '2px solid #67e8f9'
    selectionBox.style.background = 'rgba(103, 232, 249, 0.18)'
    selectionBox.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, 0.4)'
    overlay.appendChild(selectionBox)
    document.documentElement.appendChild(overlay)
  }

  function showOverlay() {
    ensureOverlay()
    overlay.style.display = 'block'
  }

  function hideOverlay() {
    if (!overlay) return
    overlay.style.display = 'none'
  }

  function updateSelectionBox(left, top, width, height) {
    if (!selectionBox) return
    selectionBox.style.left = `${left}px`
    selectionBox.style.top = `${top}px`
    selectionBox.style.width = `${width}px`
    selectionBox.style.height = `${height}px`
  }

  function intersects(rect, box) {
    return !(
      rect.right < box.left ||
      rect.left > box.right ||
      rect.bottom < box.top ||
      rect.top > box.bottom
    )
  }

  function overlapArea(rect, box) {
    const left = Math.max(rect.left, box.left)
    const right = Math.min(rect.right, box.right)
    const top = Math.max(rect.top, box.top)
    const bottom = Math.min(rect.bottom, box.bottom)
    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)
    return width * height
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, window.location.href).toString()
    } catch {
      return ''
    }
  }

  function parseYouTubeVideoId(url) {
    if (!url) return null
    try {
      const parsed = new URL(url, window.location.href)
      if (parsed.hostname.includes('youtu.be')) {
        const id = parsed.pathname.split('/').filter(Boolean)[0] || ''
        return id.length === 11 ? id : null
      }
      if (parsed.pathname === '/watch' || parsed.pathname.startsWith('/watch')) {
        const id = parsed.searchParams.get('v') || ''
        return id.length === 11 ? id : null
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        const id = parsed.pathname.split('/').filter(Boolean)[1] || ''
        return id.length === 11 ? id : null
      }
    } catch {
      return null
    }
    return null
  }

  function isYouTubePage() {
    return /(youtube\.com|youtu\.be)$/.test(window.location.hostname)
  }

  function collectText(box) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const chunks = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent?.replace(/\s+/g, ' ').trim()
      if (!text) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (intersects(rect, box)) {
        chunks.push(text)
      }
    }
    return [...new Set(chunks)].join('\n')
  }

  function selectedTextFromCandidateChunks(candidateChunks) {
    const lines = candidateChunks
      .filter((chunk) => chunk.intersectsSelection)
      .map((chunk) => chunk.text?.replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    return [...new Set(lines)].join('\n\n')
  }

  function collectImageUrls(box) {
    return [...document.images]
      .filter((image) => intersects(image.getBoundingClientRect(), box))
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean)
  }

  function isVisibleElement(element) {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  function domPathFor(element) {
    const segments = []
    let node = element
    while (node && node !== document.body && segments.length < 6) {
      const tag = node.tagName.toLowerCase()
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
        : []
      const index = siblings.indexOf(node)
      segments.unshift(`${tag}[${Math.max(index, 0)}]`)
      node = node.parentElement
    }
    return segments.join('>')
  }

  function headingText(headings, element) {
    const rect = element.getBoundingClientRect()
    let best = ''
    let bestDistance = Number.POSITIVE_INFINITY
    for (const heading of headings) {
      if (heading.top > rect.top + 8) continue
      const distance = rect.top - heading.top
      if (distance < bestDistance) {
        bestDistance = distance
        best = heading.text
      }
    }
    return best.slice(0, 300)
  }

  function textBlocks() {
    return [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, pre')]
      .filter((element) => isVisibleElement(element))
  }

  function collectCandidateChunks(box) {
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((element) => isVisibleElement(element))
      .map((element) => ({
        top: element.getBoundingClientRect().top + window.scrollY,
        text: (element.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter((heading) => heading.text)

    const blocks = textBlocks()
    const candidates = blocks
      .map((element, index) => {
        const rect = element.getBoundingClientRect()
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim()
        if (!text) return null
        if (!/^h[1-6]$/i.test(element.tagName) && text.length < 12) return null
        return {
          id: `chunk-${index + 1}`,
          text: text.slice(0, 2400),
          nearestHeading: headingText(headings, element),
          positionIndex: index,
          intersectsSelection: intersects(rect, box),
          domPath: /^h[1-6]$/i.test(element.tagName) ? `${domPathFor(element)}:heading` : domPathFor(element),
          containerPath: domPathFor(element.parentElement || element),
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY
        }
      })
      .filter(Boolean)

    return candidates.slice(0, 140)
  }

  function collectImageCandidates(box) {
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((element) => isVisibleElement(element))
      .map((element) => ({
        top: element.getBoundingClientRect().top + window.scrollY,
        text: (element.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter((heading) => heading.text)

    return [...document.images]
      .filter((image) => isVisibleElement(image))
      .map((image, index) => {
        const rect = image.getBoundingClientRect()
        const sourceUrl = image.currentSrc || image.src
        if (!sourceUrl) return null
        return {
          id: `image-${index + 1}`,
          sourceUrl,
          nearestHeading: headingText(headings, image),
          positionIndex: index,
          intersectsSelection: intersects(rect, box),
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY,
          width: rect.width,
          height: rect.height
        }
      })
      .filter(Boolean)
      .slice(0, 80)
  }

  function extractYouTubeCardTitle(anchor) {
    const titleNode = anchor.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer'
    )
    const explicit =
      anchor.getAttribute('title') ||
      anchor.getAttribute('aria-label') ||
      titleNode?.querySelector?.('#video-title')?.textContent ||
      titleNode?.querySelector?.('a#video-title')?.getAttribute?.('title') ||
      titleNode?.querySelector?.('img')?.getAttribute?.('alt') ||
      ''
    return explicit.replace(/\s+/g, ' ').trim()
  }

  function extractYouTubeChannel(anchor) {
    const card = anchor.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer'
    )
    const channelLink = card?.querySelector?.('#channel-name a, ytd-channel-name a, a.yt-simple-endpoint.style-scope.yt-formatted-string')
    return {
      name: (channelLink?.textContent || '').replace(/\s+/g, ' ').trim(),
      url: channelLink?.href ? absoluteUrl(channelLink.href) : ''
    }
  }

  function findYouTubeCardAnchorForElement(element) {
    if (!element || !element.closest) return null
    const directAnchor = element.closest('a[href*="/watch?"], a[href*="youtu.be/"], a[href*="/shorts/"]')
    if (directAnchor && parseYouTubeVideoId(directAnchor.getAttribute('href') || directAnchor.href || '')) {
      return directAnchor
    }
    const card = element.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-compact-radio-renderer'
    )
    if (!card) return null
    const nestedAnchor = card.querySelector('a[href*="/watch?"], a[href*="youtu.be/"], a[href*="/shorts/"]')
    if (!nestedAnchor) return null
    return parseYouTubeVideoId(nestedAnchor.getAttribute('href') || nestedAnchor.href || '') ? nestedAnchor : null
  }

  function detectYouTubeCaptureFromElement(element) {
    if (!isYouTubePage()) return null
    const baseElement = element?.nodeType === Node.TEXT_NODE ? element.parentElement : element
    if (!baseElement) return null

    const player = baseElement?.closest?.('#movie_player, #player, ytd-player, .html5-video-player') ||
      document.querySelector('video, #movie_player, #player, ytd-player, .html5-video-player')
    if (player && player.contains?.(baseElement)) {
      const videoId = parseYouTubeVideoId(window.location.href)
      if (videoId) {
        const title =
          (document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim() ||
          document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
          document.title
        const channelLink = document.querySelector('#owner #channel-name a, ytd-channel-name a')
        return {
          mode: 'watch_video',
          videoId,
          videoUrl: absoluteUrl(`https://www.youtube.com/watch?v=${videoId}`),
          videoTitle: title,
          channelName: ((channelLink?.textContent || '').replace(/\s+/g, ' ').trim()) || undefined,
          channelUrl: channelLink?.href ? absoluteUrl(channelLink.href) : undefined,
          thumbnailUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined,
          referrerUrl: window.location.href
        }
      }
    }

    const anchor = findYouTubeCardAnchorForElement(baseElement)
    if (!anchor) return null
    const href = anchor.getAttribute('href') || anchor.href || ''
    const videoId = parseYouTubeVideoId(href)
    if (!videoId) return null
    const channel = extractYouTubeChannel(anchor)
    return {
      mode: 'thumbnail_card',
      videoId,
      videoUrl: absoluteUrl(href),
      videoTitle: extractYouTubeCardTitle(anchor) || `YouTube video ${videoId}`,
      channelName: channel.name || undefined,
      channelUrl: channel.url || undefined,
      thumbnailUrl: anchor.querySelector('img')?.currentSrc || anchor.querySelector('img')?.src || undefined,
      referrerUrl: window.location.href
    }
  }

  function detectYouTubeCapture(box) {
    if (!isYouTubePage()) return null

    const playerCandidates = [
      document.querySelector('video'),
      document.querySelector('#movie_player'),
      document.querySelector('#player'),
      document.querySelector('ytd-player'),
      document.querySelector('.html5-video-player')
    ].filter(Boolean)

    let bestPlayer = null
    let bestPlayerArea = 0
    for (const node of playerCandidates) {
      const rect = node.getBoundingClientRect()
      const area = overlapArea(rect, box)
      if (area > bestPlayerArea) {
        bestPlayerArea = area
        bestPlayer = node
      }
    }

    if (bestPlayer && bestPlayerArea > 12000) {
      const videoId = parseYouTubeVideoId(window.location.href)
      if (videoId) {
        const title =
          (document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim() ||
          document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
          document.title
        const channelLink = document.querySelector('#owner #channel-name a, ytd-channel-name a')
        return {
          mode: 'watch_video',
          videoId,
          videoUrl: absoluteUrl(`https://www.youtube.com/watch?v=${videoId}`),
          videoTitle: title,
          channelName: ((channelLink?.textContent || '').replace(/\s+/g, ' ').trim()) || undefined,
          channelUrl: channelLink?.href ? absoluteUrl(channelLink.href) : undefined,
          thumbnailUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined,
          referrerUrl: window.location.href
        }
      }
    }

    const anchors = [...document.querySelectorAll('a[href*="/watch?"], a[href*="youtu.be/"], a[href*="/shorts/"]')]
    let bestCard = null
    let bestCardArea = 0
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || ''
      const videoId = parseYouTubeVideoId(href)
      if (!videoId) continue
      const card = anchor.closest(
        'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-compact-radio-renderer'
      )
      const img = anchor.querySelector('img')
      const rect = (card || img || anchor).getBoundingClientRect()
      const area = overlapArea(rect, box)
      if (area > bestCardArea) {
        bestCardArea = area
        bestCard = anchor
      }
    }

    if (bestCard && bestCardArea > 1200) {
      const href = bestCard.getAttribute('href') || ''
      const videoId = parseYouTubeVideoId(href)
      if (!videoId) return null
      const channel = extractYouTubeChannel(bestCard)
      return {
        mode: 'thumbnail_card',
        videoId,
        videoUrl: absoluteUrl(href),
        videoTitle: extractYouTubeCardTitle(bestCard) || `YouTube video ${videoId}`,
        channelName: channel.name || undefined,
        channelUrl: channel.url || undefined,
        thumbnailUrl: bestCard.querySelector('img')?.currentSrc || bestCard.querySelector('img')?.src || undefined,
        referrerUrl: window.location.href
      }
    }

    return null
  }

  function hasCanvasLikeContent(box) {
    const selectors = [
      'canvas',
      'embed[type*="pdf"]',
      'object[type*="pdf"]',
      'iframe[src*=".pdf"]'
    ]
    return selectors.some((selector) =>
      [...document.querySelectorAll(selector)].some((node) => intersects(node.getBoundingClientRect(), box))
    )
  }

  function dataUrlToBlob(dataUrl) {
    const [prefix, base64] = dataUrl.split(',')
    const mime = prefix.match(/data:(.*?);base64/)?.[1] || 'image/png'
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: mime })
  }

  async function cropScreenshot(dataUrl, box) {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl))
    const scale = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(box.width * scale))
    canvas.height = Math.max(1, Math.round(box.height * scale))
    const context = canvas.getContext('2d')
    context.drawImage(
      bitmap,
      Math.max(0, Math.round(box.left * scale)),
      Math.max(0, Math.round(box.top * scale)),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    )
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  }

  function toast(message, ok = true) {
    const node = document.createElement('div')
    node.textContent = message
    node.style.position = 'fixed'
    node.style.right = '20px'
    node.style.bottom = '20px'
    node.style.zIndex = '2147483647'
    node.style.padding = '10px 14px'
    node.style.borderRadius = '999px'
    node.style.font = '13px system-ui, sans-serif'
    node.style.color = '#fff'
    node.style.background = ok ? 'rgba(15, 118, 110, 0.95)' : 'rgba(190, 24, 93, 0.95)'
    node.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.35)'
    document.body.appendChild(node)
    window.setTimeout(() => node.remove(), 2600)
  }

  async function sendRuntimeMessage(message) {
    if (!chrome?.runtime?.id) {
      throw new Error('ClipWiki extension was reloaded. Refresh this page and try again.')
    }

    try {
      return await chrome.runtime.sendMessage(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        message.includes('Extension context invalidated') ||
        message.includes('Receiving end does not exist') ||
        message.includes('message port closed')
      ) {
        throw new Error('ClipWiki extension was reloaded. Refresh this page and try again.')
      }
      throw error
    }
  }

  async function finishCapture(box) {
    const youtubeMeta =
      detectYouTubeCaptureFromElement(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) ||
      detectYouTubeCapture(box)
    const isThumbnailCardCapture = youtubeMeta?.mode === 'thumbnail_card'
    // Thumbnail-card captures intentionally skip ambient page text and rely on the resolved YouTube metadata instead.
    const candidateChunks = isThumbnailCardCapture ? [] : collectCandidateChunks(box)
    const imageCandidates = isThumbnailCardCapture ? [] : collectImageCandidates(box)
    const selectedText = isThumbnailCardCapture
      ? (youtubeMeta?.videoTitle || '')
      : (
        selectedTextFromCandidateChunks(candidateChunks) ||
        collectText(box) ||
        youtubeMeta?.videoTitle ||
        ''
      )
    const imageUrls = isThumbnailCardCapture
      ? [...new Set([youtubeMeta?.thumbnailUrl].filter(Boolean))]
      : [...new Set([
          ...collectImageUrls(box),
          ...(youtubeMeta?.thumbnailUrl ? [youtubeMeta.thumbnailUrl] : [])
        ])]
    const shouldUseScreenshot = !selectedText.trim() || hasCanvasLikeContent(box)

    let screenshotBlob = null
    if (shouldUseScreenshot) {
      // Canvas/PDF-like regions need a pixel fallback because the visible text is not reliably available from the DOM.
      const screenshotResponse = await sendRuntimeMessage({ type: 'clipwiki:capture-visible-tab' })
      if (!screenshotResponse?.error && screenshotResponse?.dataUrl) {
        screenshotBlob = await cropScreenshot(screenshotResponse.dataUrl, box)
      }
    }

    const payload = {
      pageUrl: youtubeMeta?.videoUrl || window.location.href,
      pageTitle: youtubeMeta?.videoTitle || document.title || 'Untitled page',
      sourceHost: window.location.host,
      selectedText,
      candidateChunks,
      imageUrls,
      imageCandidates,
      rect: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    }

    if (youtubeMeta) {
      payload.youtubeMeta = youtubeMeta
    }

    // Hand the browser-side capture bundle to the background script so saving can continue outside the page context.
    const saveResponse = await sendRuntimeMessage({
      type: 'clipwiki:save-capture',
      payload,
      screenshotBlob
    })

    if (saveResponse?.error) {
      toast(`ClipWiki save failed: ${saveResponse.error}`, false)
      return
    }

    toast(`Saved to ClipWiki: ${saveResponse?.scrap?.title || 'scrap'}`)
  }

  document.addEventListener('mousedown', (event) => {
    if (!event.altKey || event.button !== 0) return
    dragging = true
    startX = event.clientX
    startY = event.clientY
    startTarget = event.target
    showOverlay()
    updateSelectionBox(startX, startY, 0, 0)
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  document.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const left = Math.min(startX, event.clientX)
    const top = Math.min(startY, event.clientY)
    const width = Math.abs(event.clientX - startX)
    const height = Math.abs(event.clientY - startY)
    updateSelectionBox(left, top, width, height)
    event.preventDefault()
  }, true)

  document.addEventListener('mouseup', async (event) => {
    if (!dragging) return
    dragging = false
    hideOverlay()

    const left = Math.min(startX, event.clientX)
    const top = Math.min(startY, event.clientY)
    const width = Math.abs(event.clientX - startX)
    const height = Math.abs(event.clientY - startY)
    try {
      if (width < 8 || height < 8) {
        const clickMeta = detectYouTubeCaptureFromElement(startTarget || event.target || document.elementFromPoint(event.clientX, event.clientY))
        if (!clickMeta) {
          return
        }
        suppressNextClickUntil = Date.now() + 1200
        await finishCapture({
          left: Math.max(0, event.clientX - 6),
          top: Math.max(0, event.clientY - 6),
          width: 12,
          height: 12,
          right: event.clientX + 6,
          bottom: event.clientY + 6
        })
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      suppressNextClickUntil = Date.now() + 1200
      await finishCapture({ left, top, width, height, right: left + width, bottom: top + height })
      event.preventDefault()
      event.stopImmediatePropagation()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'ClipWiki capture failed', false)
    }
  }, true)

  document.addEventListener('click', (event) => {
    if (Date.now() < suppressNextClickUntil) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }, true)
})()

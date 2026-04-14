# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ClipWiki** is a Chrome extension + Next.js dashboard system that turns rough web scraps into a personal LLM-powered wiki. Users Alt+Drag over webpage regions to capture text and images, store in Notion, then use GPT to organize scraps into structured wiki drafts.

**Key Design Principle**: Bounded agent pattern—the LLM only operates through explicit tool calls with user approval before any Notion publication.

## Tech Stack

- **Framework**: Next.js 15.3.0 (full-stack)
- **Runtime**: Node.js
- **Language**: TypeScript (strict mode)
- **Database**: SQLite via better-sqlite3
- **Validation**: Zod
- **AI/LLM**: OpenAI SDK (Chat Completions, Moderation API)
- **External Services**: Notion API, YouTube Transcript API
- **UI Libraries**: React 19, @xyflow/react (graph visualization), Cheerio (HTML parsing)
- **Testing**: Playwright
- **OCR**: Tesseract.js

## Development Commands

```bash
# Install dependencies
npm install

# Development server (auto-reload)
npm run dev

# Production build
npm run build

# Run production server
npm start

# Lint and format check
npm run lint

# Run Playwright tests (if needed)
npx playwright test
```

**Note**: Most server-side code changes apply immediately after restart. Extension code changes require Chrome reload + webpage refresh.

## High-Level Architecture

### Three Main Components

1. **Chrome Extension** (`extension/`)
   - `content.js`: Injects UI, handles Alt+Drag selection capture
   - `background.js`: Service worker, handles messaging, orchestrates backend calls
   - `popup.js`: UI for extension popup
   - `manifest.json`: Permission declarations, content script injection
   - Captures selected region, collects same-page candidates, finds intersecting images
   - Sends raw payload to backend via `/api/extension/capture`

2. **Next.js Backend** (`app/api`, `lib/`)
   - **Core modules** (lib/server/, ~3100 lines):
     - `db.ts`: SQLite storage (scraps, wiki drafts, metadata)
     - `capture.ts`: Ingest and validate scrap payloads, call Notion
     - `smart-scrap.ts`: CPU-based TF-IDF + cosine similarity for chunk enrichment
     - `openai.ts`: Tool definitions, chat loop, wiki generation with zod-validated args
     - `notion.ts`: Notion page creation, file uploads, publish workflow
     - `ocr.ts`: Tesseract.js fallback for image-heavy regions
     - `youtube.ts`: YouTube transcript extraction
     - `graphify.ts`: Graph visualization state management
     - `env.ts`: Env var loading with required/optional helpers
   - **API Routes** (`app/api/`):
     - `POST /extension/capture`: Scrap submission from extension
     - `GET/POST /scraps/*`: Scrap CRUD
     - `GET /wiki/drafts`, `POST /wiki/generate`: Draft generation
     - `POST /wiki/[id]/{approve,publish}`: User approval + Notion publication
     - `POST /chat`: Chat with tool-calling loop (search scraps/wikis, ask questions)
     - `GET/POST /graphify/*`: Graph visualization endpoints
     - `POST /automation/daily`: Daily automation tasks

3. **Data Layer** (`data/`)
   - `clipwiki.sqlite`: Local SQLite DB (scraps, wiki drafts, graph nodes/edges)
   - Notion databases (one for scraps, one as wiki root page)

### Data Flow

1. **Capture**: User Alt+Drag → extension collects text + candidates + images → backend validates + enriches → stored in SQLite + uploaded to Notion
2. **Enrichment**: Backend uses TF-IDF to find same-page context, merges high-signal chunks
3. **Wiki Generation**: User selects scraps → calls `/wiki/generate` → LLM clusters (if no topic) or focuses (if topic provided) → generates draft with structure
4. **Approval & Publish**: User reviews draft → approves in UI → backend publishes to Notion as proper pages
5. **Ask**: User asks question → LLM searches scraps + wiki drafts via tool calls → retrieves full bundles → answers with sources

## Key Patterns & Conventions

### Tool Calling & Validation

- Tool schemas defined in `openai.ts` with `z.object()` (Zod)
- Each tool has strict argument validation:
  ```ts
  const searchScrapsArgs = z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(100).default(12),
    tags: z.array(z.string()).max(50).optional()
  })
  ```
- Backend validates tool calls and returns results to LLM
- No unbounded LLM autonomy—all actions require explicit tool invocation

### Notion Integration

- **Scrap database**: Properties include Title, Source URL, Merged Text, OCR Text, Images, Capture Type, Tags, Captured At
- **Wiki root page**: Container for generated wiki pages as subpages
- **File uploads**: Images are uploaded as file blocks in Notion pages
- URL validation prevents injection; scrap content is treated as untrusted data

### Safety & Guardrails

- **Moderation API**: User chat prompts checked before processing
- **Zod validation**: All capture payloads and tool arguments validated
- **User approval**: Wiki drafts require explicit approval before Notion publication
- **Untrusted data**: Scrap content never treated as instructions

### Database Schema

Tables in SQLite:
- `scraps`: id, title, sourceUrl, selectedText, mergedText, ocrText, captureType, images (JSON), tags, notionPageId, createdAt, etc.
- `wiki_drafts`: id, title, topic, summary, keyConcepts, claims, sections (JSON), sourceScrapIds, status (draft/approved/published), notionPageId, createdAt, etc.
- `graph_nodes`, `graph_edges`: For visualization state

### Environment Variables

Required in `.env.local`:
```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MODERATION_MODEL=omni-moderation-latest
NOTION_API_KEY=...
NOTION_SCRAP_DATABASE_ID=...
NOTION_WIKI_ROOT_PAGE_ID=...
```

## File & Folder Organization

```
extension/          # Chrome extension (manifest v3)
  content.js        # Page injection, Alt+Drag UI
  background.js     # Service worker, messaging
  popup.js          # Popup UI
  manifest.json
app/
  layout.tsx        # Root layout
  page.tsx          # Dashboard home
  api/
    extension/      # Extension endpoints
    scraps/         # Scrap CRUD
    wiki/           # Wiki generation, approval, publish
    chat/           # Chat with tools
    graphify/       # Graph endpoints
    automation/     # Daily automation
  globals.css
components/
  KnowledgeAgentApp.tsx    # Main dashboard UI
  GraphifyView.tsx         # Graph visualization
lib/
  types.ts          # Shared TypeScript interfaces
  server/
    capture.ts      # Capture ingestion
    smart-scrap.ts  # TF-IDF enrichment
    openai.ts       # LLM + tools
    notion.ts       # Notion API client
    db.ts           # SQLite operations
    ocr.ts          # Tesseract wrapper
    youtube.ts      # YouTube transcript
    graphify.ts     # Graph state
    env.ts          # Env var helpers
data/
  clipwiki.sqlite   # Local SQLite DB
docs/
  demo/             # GIFs and videos
  screenshots/
```

## Testing & Linting

- **Linting**: `npm run lint` (ESLint with next/core-web-vitals config)
- **Tests**: Playwright installed but not yet active; add tests as needed with `@playwright/test`
- **Type checking**: TypeScript strict mode enabled; run `npx tsc --noEmit` to check without build

## Important Implementation Details

### Wiki Generation Modes

Generate calls support modes: `general`, `claim_compare`, `study_notes`, `decision_log`, `onboarding_map`. The default is `general`. Mode affects the LLM prompt and expected output structure.

### Notion Properties

When setting up a Notion scrap database, include:
- Title, Source URL, Source Host, Page Title
- Merged Text, OCR Text (enriched by smart-scrap)
- Images, Region Screenshot
- Capture Type, Tags, User Note, Captured At

### Extension Debugging

- Open `chrome://extensions`
- Enable "Developer mode"
- Load unpacked from `extension/` directory
- Use DevTools console in background service worker to debug
- Reload extension after code changes; refresh target page before testing capture again

### Graph Visualization

The Graphify system (`lib/server/graphify.ts`) maintains nodes and edges representing relationships between scraps and wiki drafts. Used by `GraphifyView.tsx` to render interactive knowledge graph with @xyflow/react.

## Guardrails to Preserve

1. **Moderation on user prompts** (via OpenAI Moderation API)
2. **Zod validation on all tool arguments and capture payloads**
3. **User approval before Notion publication** (explicit button click required)
4. **URL validation on capture ingestion** (prevent malformed URLs)
5. **Scrap content treated as untrusted data** (never interpreted as instructions)
6. **Request limits intentionally generous** for personal use (e.g., max 100 selected scraps per wiki generation)

## Common Development Tasks

**Add a new tool**: Define schema in `openai.ts`, implement handler in chat route, add to tool definitions array.

**Modify Notion properties**: Update the properties map in `notion.ts`, sync `.env.local` with new database IDs if needed.

**Add a new API endpoint**: Create route file in `app/api/`, follow Next.js file-based routing, validate inputs with Zod.

**Debug smart scrap enrichment**: Log candidate chunks and TF-IDF scores in `smart-scrap.ts`, compare before/after in SQLite.

## Recent Changes & Context

- YouTube transcript capture support added
- Daily automation endpoints implemented
- Graphify (graph visualization) refined for wiki relationships
- Wiki-based Graphify links integrated

---

**Questions?** Refer to README.md for setup and general overview, or examine `lib/server/` for specific module documentation in code comments.

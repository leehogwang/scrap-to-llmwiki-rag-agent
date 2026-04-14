# ClipWiki

[Read the English README](./README.md)

ClipWiki는 크롬 익스텐션과 웹 대시보드를 결합해, 거칠게 모아둔 웹 스크랩을 개인 LLM-Wiki로 바꾸는 도구입니다. 웹에서 `Alt + Drag`로 영역을 선택하면 텍스트와 이미지가 Notion에 저장되고, 이후 OpenAI API 또는 Codex auth 기반 ChatGPT quota를 이용해 위키 초안과 Graphify 지식 그래프를 만듭니다.

## 개요

ClipWiki는 다음 학습 흐름을 목표로 합니다.

- 웹에서 공부하다가 필요한 부분을 빠르게 스크랩
- 원문 링크와 이미지를 포함한 상태로 Notion에 보관
- 저장된 스크랩을 검색
- 스크랩과 위키 초안을 함께 기반으로 질문
- 누적 스크랩을 구조화된 위키 초안으로 변환
- 결과 지식을 인터랙티브 그래프로 탐색

## 핵심 기능

- 크롬에서 `Alt + Drag`로 스마트 스크랩
- Notion 기반 스크랩 저장소와 원문 링크 기록
- 이미지가 있으면 함께 저장, 텍스트가 부족하면 OCR 보강
- 로컬 CPU에서 TF-IDF + cosine으로 same-page 문맥 확장
- YouTube 지원
  - watch 페이지의 영상 영역을 스크랩하면 transcript를 붙일 수 있음
  - 영상 목록 썸네일 카드를 스크랩해도 video 메타데이터와 transcript를 가져올 수 있음
- 좌측 Ask 패널 답변은 Markdown으로 렌더링
- 답변 아래 `+` 버튼으로 `사용자 질의 / 대답` 형식의 Q&A를 scrap으로 저장 가능
- OpenAI API 모드 또는 Codex auth 모드 지원
  - auth 모드 기본 모델: `gpt-5.4-mini`
- 위키 생성 방식
  - 주제를 입력하면 해당 주제로 위키 1개 생성
  - 주제를 비워두면 미반영 스크랩을 주제별로 나누어 위키 여러 개 생성 가능
  - 기존 위키와 유사하면 새 위키를 만드는 대신 기존 위키를 보강
- `Ask` 패널에서 스크랩과 위키 초안을 함께 검색
- `Graphify` 탭에서 `wiki / scrap / claim / concept` 그래프와 놀라운 연결 탐색

## 데모 자산

![ClipWiki 메인 화면](./docs/screenshots/clipwiki-main-20260414.png)

![ClipWiki Graphify](./docs/screenshots/clipwiki-graphify-20260414.png)

## 동작 방식

### 1. 스크랩 저장

1. 사용자가 웹페이지에서 `Alt`를 누른 채 드래그합니다.
2. 익스텐션이 선택 영역의 텍스트, 이미지, 주변 청크를 수집합니다.
3. 텍스트가 약하거나 비-DOM 콘텐츠면 스크린샷과 OCR을 사용합니다.
4. 백엔드가 이를 보정해 로컬 SQLite와 Notion Scrap DB에 저장합니다.

### 2. 스마트 스크랩

ClipWiki는 단순 크롭 텍스트만 저장하지 않습니다.

- 사용자가 직접 선택한 텍스트는 유지
- 페이지 구조 기반 청크를 수집
- 로컬 CPU에서 TF-IDF + cosine으로 관련 청크 점수 계산
- 유의미한 텍스트를 `mergedText`로 결합
- 결합된 텍스트와 관련된 이미지도 함께 저장

### 3. 위키 초안 생성

저장된 스크랩은 위키의 원재료가 됩니다.

- topic이 있으면 하나의 위키 초안으로 정리
- topic이 없으면 현재 미반영 스크랩을 먼저 주제별로 나누고, 그룹별로 위키 초안 생성
- 새 스크랩이 기존 위키와 유사하면 새 문서를 만들지 않고 기존 위키를 확장/갱신
- 위키 생성은 수동 실행도 가능하고, 새 스크랩이 있을 때 하루 1회 자동 실행도 가능

위키 초안에는 다음이 포함됩니다.

- 제목
- 주제
- 요약
- 핵심 개념
- 주장
- 열린 질문
- 섹션 구조
- 원본 스크랩 링크

### 4. Ask over scraps

좌측 Ask 패널은 raw 스크랩만 보지 않습니다.

- 스크랩 검색
- 위키 초안 검색
- Graphify의 놀라운 연결 설명도 retrieval 컨텍스트로 활용
- 필요한 경우 둘 다 불러와 참조
- 검색된 지식을 바탕으로 답변

### 5. Graphify

Graphify는 현재 지식 베이스를 그래프로 보여줍니다.

- 노드 타입: `wiki`, `scrap`, `claim`, `concept`
- 색은 개별 위키가 아니라 **주제 군집** 기준
- 놀라운 선은 위키의 `title`, `topic`, `summary`, `keyConcepts`를 바탕으로 모델이 wiki↔wiki 연결을 판정
- 놀라운 선을 클릭하면 우측 상세 패널에 “왜 이 연결이 흥미로운지” 설명이 표시됨

## 아키텍처

- 크롬 익스텐션
  - `extension/content.js`
  - `extension/background.js`
  - `extension/manifest.json`
- Next.js 대시보드/백엔드
  - `app/`
  - `components/KnowledgeAgentApp.tsx`
- 로컬 저장소
  - `data/clipwiki.sqlite`
- 외부 연동
  - OpenAI Chat Completions / Moderation
  - Codex auth 기반 ChatGPT responses
  - Notion API

핵심 서버 모듈:

- `lib/server/capture.ts`
- `lib/server/smart-scrap.ts`
- `lib/server/openai.ts`
- `lib/server/notion.ts`
- `lib/server/db.ts`
- `lib/server/graphify.ts`
- `lib/server/youtube.ts`
- `lib/server/codex-client.ts`

## Function Calling 흐름

현재 주요 tool은 다음과 같습니다.

- `search_scraps`
- `get_scrap_bundle`
- `search_wiki_drafts`
- `get_wiki_bundle`
- `create_wiki_draft`

흐름:

1. 앱이 tool schema를 모델에 전달
2. 모델이 JSON 형태로 함수 호출 추천
3. 백엔드가 `zod`로 인자 검증
4. 백엔드가 함수 실행
5. 결과를 다시 모델에 전달
6. 최종 응답 또는 위키 초안 생성

## 설치 및 실행

```bash
npm install
npm run dev
```

대시보드:

- `http://localhost:3000`

## 환경변수

`.env.local`:

```bash
USE_CODEX_AUTH=false
CODEX_AUTH_MODEL=gpt-5.4-mini
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MODERATION_MODEL=omni-moderation-latest
NOTION_API_KEY=...
NOTION_SCRAP_DATABASE_ID=...
NOTION_WIKI_ROOT_PAGE_ID=...
```

설명:

- `USE_CODEX_AUTH=true`이면 `codex login`으로 생성된 `~/.codex/auth.json`을 사용합니다.
- `OPENAI_API_KEY`는 `USE_CODEX_AUTH=false`일 때 필수입니다.
- moderation은 항상 일반 OpenAI API 키 경로를 사용합니다.

## 크롬 익스텐션 로드

1. `chrome://extensions`
2. `Developer mode` 활성화
3. `Load unpacked`
4. `extension/` 폴더 선택
5. 익스텐션 코드가 바뀌면 `Reload`
6. 테스트 웹페이지도 새로고침

## Notion 준비

필요한 것:

- 스크랩 저장용 Notion DB 1개
- 위키 게시용 루트 페이지 1개

둘 다 Notion integration과 공유되어야 합니다.

권장 Scrap DB 속성:

- `Title`
- `Source URL`
- `Source Host`
- `Page Title`
- `Merged Text`
- `OCR Text`
- `Capture Type`
- `Tags`
- `User Note`
- `Captured At`
- `Images`
- `Region Screenshot`

## 프로젝트 구조

```text
app/
  api/
components/
  KnowledgeAgentApp.tsx
extension/
  manifest.json
  background.js
  content.js
lib/
  types.ts
  server/
    capture.ts
    db.ts
    env.ts
    notion.ts
    ocr.ts
    openai.ts
    smart-scrap.ts
docs/
  screenshots/
data/
```

## 안전장치

- 사용자 채팅 입력에 Moderation API 적용
- 캡처 입력 URL 검증
- tool/capture payload에 `zod` 검증
- 스크랩 내용은 instruction이 아니라 untrusted data로 취급
- Notion 게시 전 승인 단계 필요

## 자동화 동작

- 새 미반영 scrap이 있을 때만 하루 1회 위키 자동 생성
- 그래프도 하루 1회 자동 갱신 가능
- 둘 다 상단 툴바에서 수동 실행 가능
- 위키가 갱신되면 그래프도 즉시 다시 만들어 Graphify에 반영

## 참고

- 대부분의 로직은 서버 쪽이라 서버 재시작만 하면 반영됩니다.
- 익스텐션 코드 변경은 크롬에서 `Reload + 페이지 새로고침`이 필요합니다.
- 개인용 중심 프로젝트라 일부 입력 상한은 넉넉하게 잡아두었습니다.
- scrap 선택은 기본적으로 삭제용이며, Ask는 전체 scraps + 전체 wiki drafts를 봅니다.

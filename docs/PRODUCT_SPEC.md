# MeBox Product Spec

## Concept

MeBox is a lightweight Signal-like personal inbox.

The main screen behaves like a private chat with myself.
Every object is represented as a message-like item.

## Bottom navigation

- 인박스
- 검색
- 더보기

## Composer

- ＋
- 나에게 입력...
- 보내기

## Create menu

- 메모
- 링크
- 할일
- 리스트
- 파일
- 공지
- 지출

## MVP Features

1. Notes
   - Create, edit, delete
   - Keyword search

2. Links
   - URL, title, memo, tags
   - Searchable

3. Tasks
   - Title, due date, reminder date
   - Complete / incomplete
   - Internal alert list

4. Lists
   - Checklist title
   - Checklist items
   - Complete / incomplete

5. Files
   - Upload limited files
   - Original filename stored in DB
   - Random stored filename on disk
   - Size limit
   - Allowed MIME types only

6. Announcements
   - Pinned important notes
   - Keyword search

7. Recurring expenses
   - Name
   - Amount
   - Currency
   - Billing day
   - Reminder days before, default 3
   - Internal alert when payment is close

## Non-goals for MVP

- No AI classification
- No multi-user support
- No public sharing
- No comments
- No calendar month view
- No rich Notion-like editor
- No password manager features
- No seed/private key storage

## Deployment policy

- Tailscale-only access
- No router port forwarding
- No Tailscale Funnel
- No public domain for MVP

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  categoryForItemType,
  categoryLabels,
  filterItemsByCategory,
  formatDateTitle,
  formatMessageTime,
  normalizeLinkUrl,
  sortItemsOldestFirst,
  type CategoryLabel,
  type ItemType,
} from './inboxDisplay'
import './App.css'

type InboxItem = {
  id: number
  type: ItemType
  body: string | null
  createdAt: string
  detail: Record<string, unknown> | null
}

type AlertItem = {
  id: number
  type: 'todo' | 'recurring_expense'
  title: string
  dueOn: string
  severity: 'due_soon' | 'overdue'
  detail?: string
}

type AuthUser = { id: number; username: string }

type AuthResponse = {
  authenticated: boolean
  setupRequired: boolean
  user: AuthUser | null
}

type SettingsResponse = {
  user: AuthUser | null
  version: string
  defaultReminderAdvanceMinutes: number
  reminderAdvanceOptions: number[]
}

type AuthView = 'loading' | 'setup' | 'login' | 'authenticated'
type NavKey = 'inbox' | 'search' | 'settings'
type SettingsView =
  | 'home'
  | 'editUsername'
  | 'changePassword'
  | 'exportData'
  | 'importData'
  | 'reminder'
  | 'deleteAccount'
type CreateType =
  | 'note'
  | 'link'
  | 'todo'
  | 'list'
  | 'file'
  | 'announcement'
  | 'recurring_expense'

const createTypes: { type: CreateType; label: string }[] = [
  { type: 'note', label: 'Chat' },
  { type: 'link', label: 'Link' },
  { type: 'todo', label: 'Reminders' },
  { type: 'list', label: 'List' },
  { type: 'file', label: 'File' },
  { type: 'announcement', label: 'Notification' },
  { type: 'recurring_expense', label: 'Fixed' },
]

const reminderOptions = [
  { label: 'At event time', value: 0 },
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: '1 day', value: 1440 },
]

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  })

  if (!response.ok) {
    throw new Error('Request failed')
  }

  return response.json() as Promise<T>
}

async function uploadFile(file: File) {
  const response = await fetch('/api/items/files', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type,
      'x-filename': file.name,
    },
    body: file,
  })

  if (!response.ok) {
    throw new Error('Upload failed')
  }

  return response.json() as Promise<{ item: InboxItem }>
}

function asText(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : 0
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`
  }

  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`
  }

  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function typeLabel(type: ItemType) {
  return categoryForItemType(type)
}

function groupItems(items: InboxItem[]) {
  const groups: { title: string; items: InboxItem[] }[] = []

  for (const item of items) {
    const title = formatDateTitle(item.createdAt)
    const group = groups.find((entry) => entry.title === title)

    if (group) {
      group.items.push(item)
    } else {
      groups.push({ title, items: [item] })
    }
  }

  return groups
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function AuthScreen({
  mode,
  onAuthenticated,
}: {
  mode: 'setup' | 'login'
  onAuthenticated: (user: AuthUser | null) => void
}) {
  const [username, setUsername] = useState('local')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')

    try {
      const response = await apiFetch<AuthResponse>(
        mode === 'setup' ? '/api/auth/setup' : '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        },
      )
      setPassword('')
      onAuthenticated(response.user)
    } catch {
      setError(mode === 'setup' ? '설정을 완료하지 못했습니다.' : '로그인할 수 없습니다.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div>
          <span className="auth-mark">MeBox</span>
          <h1>{mode === 'setup' ? '첫 설정' : '로그인'}</h1>
          <p>개인 Tailnet 안에서 쓰는 나와의 인박스</p>
        </div>

        <label>
          사용자 이름
          <input
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
        </label>

        <label>
          비밀번호
          <input
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button disabled={isSubmitting || !username.trim() || password.length < 8} type="submit">
          {mode === 'setup' ? '설정 완료' : '로그인'}
        </button>
      </form>
    </main>
  )
}

function MessageBubble({ item }: { item: InboxItem }) {
  const detail = item.detail ?? {}

  return (
    <article className={`message-bubble message-${item.type}`}>
      <div className="message-label">
        <span className="category-badge">{typeLabel(item.type)}</span>
        <time>{formatMessageTime(item.createdAt)}</time>
      </div>

      {item.type === 'note' && <p className="message-text">{asText(detail.text)}</p>}

      {item.type === 'link' && (
        <div className="message-stack">
          <strong>{asText(detail.title) || asText(detail.url)}</strong>
          {asText(detail.memo) && <p>{asText(detail.memo)}</p>}
          <a
            className="message-url"
            href={asText(detail.url)}
            rel="noreferrer noopener"
            target="_blank"
          >
            {asText(detail.url)}
          </a>
        </div>
      )}

      {item.type === 'todo' && (
        <div className="todo-line">
          <span className="todo-check fake-check" aria-hidden="true">
            {asText(detail.completedAt) ? '✓' : ''}
          </span>
          <span>{asText(detail.title)}</span>
        </div>
      )}

      {item.type === 'list' && (
        <div className="message-stack">
          <strong>{asText(detail.title)}</strong>
          <ul className="mini-list">
            {(Array.isArray(detail.items) ? detail.items : []).slice(0, 4).map((row) => {
              const listItem = row as Record<string, unknown>
              return (
                <li key={String(listItem.id)}>
                  <span className="list-marker" aria-hidden="true">
                    •
                  </span>
                  {asText(listItem.text)}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {item.type === 'file' && (
        <a className="attachment-line" href={`/api/files/${item.id}`}>
          <span className="attachment-icon" aria-hidden="true">
            ↓
          </span>
          <span>
            <strong>{asText(detail.originalName)}</strong>
            <small>
              {asText(detail.mimeType)} · {formatBytes(asNumber(detail.sizeBytes))}
            </small>
          </span>
        </a>
      )}

      {item.type === 'announcement' && (
        <div className="message-stack notification-content">
          <strong>{asText(detail.title) || 'Notification'}</strong>
          <p>{asText(detail.body)}</p>
        </div>
      )}

      {item.type === 'recurring_expense' && (
        <div className="message-stack">
          <strong>{asText(detail.name)}</strong>
          <span>
            {asText(detail.currency)} {asNumber(detail.amount).toLocaleString()} · 매월{' '}
            {asNumber(detail.billingDay)}일
          </span>
        </div>
      )}
    </article>
  )
}

function Timeline({ items }: { items: InboxItem[] }) {
  if (!items.length) {
    return <div className="empty-thread">아직 아무 것도 없습니다. 첫 메모를 보내세요.</div>
  }

  return (
    <section className="timeline" aria-label="인박스 타임라인">
      {groupItems(items).map((group) => (
        <div className="day-group" key={group.title}>
          <div className="day-divider">{group.title}</div>
          {group.items.map((item) => (
            <MessageBubble item={item} key={item.id} />
          ))}
        </div>
      ))}
    </section>
  )
}

function InboxHeader({
  alerts,
}: {
  alerts: AlertItem[]
}) {
  return (
    <header className="chat-header">
      <div>
        <h1>MeBox</h1>
        <p>{alerts.length ? `${alerts.length}개 알림` : '개인 인박스'}</p>
      </div>
    </header>
  )
}

function AlertStrip({ alerts }: { alerts: AlertItem[] }) {
  if (!alerts.length) {
    return null
  }

  return (
    <section className="alert-strip" aria-label="내부 알림">
      {alerts.map((alert) => (
        <div className="alert-chip" key={`${alert.type}-${alert.id}`}>
          <strong>{alert.title}</strong>
          <span>{alert.severity === 'overdue' ? '지남' : '곧 예정'}</span>
        </div>
      ))}
    </section>
  )
}

const repeatOptions = ['Never', 'Daily', 'Weekly', 'Monthly'] as const
type RepeatOption = (typeof repeatOptions)[number]

const advanceNoticeOptions: { label: string; value: number | null }[] = [
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: '1 day', value: 1440 },
  { label: 'None', value: null },
]

const weekdayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function sameYmd(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function buildCalendarDays(viewMonth: Date) {
  const first = startOfMonth(viewMonth)
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - first.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart)
    day.setDate(gridStart.getDate() + index)
    return day
  })
}

function pad2(value: number) {
  return value.toString().padStart(2, '0')
}

function ReminderSheet({
  initialTitle,
  onCancel,
  onSaved,
}: {
  initialTitle: string
  onCancel: () => void
  onSaved: (item: InboxItem) => void
}) {
  const now = new Date()
  const [visible, setVisible] = useState(false)
  const [title, setTitle] = useState(initialTitle)
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(now))
  const [selectedDate, setSelectedDate] = useState(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  )
  const [hour, setHour] = useState(pad2(now.getHours()))
  const [minute, setMinute] = useState(pad2(now.getMinutes()))
  const [allDay, setAllDay] = useState(false)
  const [repeat, setRepeat] = useState<RepeatOption>('Never')
  const [advanceMinutes, setAdvanceMinutes] = useState<number | null>(15)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const calendarDays = useMemo(() => buildCalendarDays(viewMonth), [viewMonth])
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(viewMonth)
  const canSave = title.trim().length > 0 && !saving

  function close(after: () => void) {
    setVisible(false)
    window.setTimeout(after, 280)
  }

  function shiftMonth(delta: number) {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  async function save() {
    if (!title.trim()) {
      setError('제목을 입력하세요.')
      return
    }

    setSaving(true)
    setError('')

    const hours = allDay ? 0 : Number(hour) || 0
    const minutes = allDay ? 0 : Number(minute) || 0
    const due = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
      hours,
      minutes,
      0,
      0,
    )

    try {
      const response = await apiFetch<{ item: InboxItem }>('/api/items/todos', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          dueAt: due.toISOString(),
          repeat,
          advanceMinutes,
        }),
      })
      close(() => onSaved(response.item))
    } catch {
      setError('저장하지 못했습니다.')
      setSaving(false)
    }
  }

  return (
    <div
      className="reminder-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="New Reminder"
    >
      <div className={`reminder-sheet ${visible ? 'open' : ''}`}>
        <header className="reminder-sheet-header">
          <button className="sheet-cancel-btn" onClick={() => close(onCancel)} type="button">
            Cancel
          </button>
          <h2>New Reminder</h2>
          <button className="sheet-save-btn" disabled={!canSave} onClick={save} type="button">
            Save
          </button>
        </header>

        <div className="reminder-sheet-body">
          <section className="reminder-section">
            <span className="reminder-section-label">Title</span>
            <input
              aria-label="제목"
              className="reminder-input"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="제목 입력"
              value={title}
            />
          </section>

          <section className="reminder-section">
            <span className="reminder-section-label">Date &amp; Time</span>
            <div className="cal-header">
              <button
                aria-label="이전 달"
                className="cal-nav"
                onClick={() => shiftMonth(-1)}
                type="button"
              >
                ‹
              </button>
              <strong>{monthLabel}</strong>
              <button
                aria-label="다음 달"
                className="cal-nav"
                onClick={() => shiftMonth(1)}
                type="button"
              >
                ›
              </button>
            </div>
            <div className="calendar-grid">
              {weekdayLabels.map((label) => (
                <div className="cal-weekday" key={label}>
                  {label}
                </div>
              ))}
              {calendarDays.map((day) => {
                const classes = ['cal-day']
                if (day.getMonth() !== viewMonth.getMonth()) {
                  classes.push('other-month')
                }
                if (sameYmd(day, now)) {
                  classes.push('today')
                }
                if (sameYmd(day, selectedDate)) {
                  classes.push('selected')
                }

                return (
                  <button
                    className={classes.join(' ')}
                    key={day.toISOString()}
                    onClick={() =>
                      setSelectedDate(
                        new Date(day.getFullYear(), day.getMonth(), day.getDate()),
                      )
                    }
                    type="button"
                  >
                    {day.getDate()}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="reminder-section">
            <span className="reminder-section-label">Time</span>
            <div className="time-row">
              <button
                className={`allday-toggle ${allDay ? 'active' : ''}`}
                onClick={() => setAllDay((value) => !value)}
                type="button"
              >
                All Day
              </button>
              {!allDay && (
                <div className="time-inputs">
                  <input
                    aria-label="시"
                    className="reminder-input time-field"
                    inputMode="numeric"
                    max="23"
                    min="0"
                    onChange={(event) => setHour(event.target.value)}
                    type="number"
                    value={hour}
                  />
                  <span>:</span>
                  <input
                    aria-label="분"
                    className="reminder-input time-field"
                    inputMode="numeric"
                    max="59"
                    min="0"
                    onChange={(event) => setMinute(event.target.value)}
                    type="number"
                    value={minute}
                  />
                </div>
              )}
            </div>
          </section>

          <section className="reminder-section">
            <span className="reminder-section-label">Repeat</span>
            <div className="option-row">
              {repeatOptions.map((option) => (
                <button
                  className={`option-chip ${repeat === option ? 'selected' : ''}`}
                  key={option}
                  onClick={() => setRepeat(option)}
                  type="button"
                >
                  {option}
                </button>
              ))}
            </div>
          </section>

          <section className="reminder-section">
            <span className="reminder-section-label">Advance Notice</span>
            <div className="option-row">
              {advanceNoticeOptions.map((option) => (
                <button
                  className={`option-chip ${advanceMinutes === option.value ? 'selected' : ''}`}
                  key={option.label}
                  onClick={() => setAdvanceMinutes(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          {error && <p className="sheet-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function Composer({
  onCreated,
}: {
  onCreated: (item: InboxItem) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [createType, setCreateType] = useState<CreateType>('note')
  const [draft, setDraft] = useState('')
  const [extra, setExtra] = useState('')
  const [amount, setAmount] = useState('')
  const [billingDay, setBillingDay] = useState('1')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false)
  const [error, setError] = useState('')

  const isNote = createType === 'note'
  const isReminder = createType === 'todo'
  const placeholder = isNote
    ? '나에게 입력...'
    : createType === 'list'
      ? '리스트 제목 입력...'
      : isReminder
        ? 'Reminder 제목 입력...'
        : `${typeLabel(createType)} 입력...`
  const canSend = createType === 'file' ? selectedFile !== null : draft.trim().length > 0

  function resetComposer() {
    setDraft('')
    setExtra('')
    setAmount('')
    setBillingDay('1')
    setSelectedFile(null)
    setCreateType('note')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()

    if (isReminder) {
      setReminderSheetOpen(true)
      return
    }

    setIsSending(true)
    setError('')

    try {
      if (createType === 'file') {
        if (!selectedFile) {
          setError('파일을 선택하세요.')
          return
        }
        const response = await uploadFile(selectedFile)
        onCreated(response.item)
        resetComposer()
        return
      }

      let path = '/api/items/notes'
      let payload: Record<string, unknown> = { body: draft }

      if (createType === 'link') {
        const normalizedUrl = normalizeLinkUrl(draft)
        if (!normalizedUrl) {
          setError('올바른 URL을 입력하세요.')
          return
        }

        path = '/api/items/links'
        payload = { url: normalizedUrl, title: extra || undefined }
      } else if (createType === 'list') {
        path = '/api/items/lists'
        payload = {
          title: draft,
          items: extra
            .split('\n')
            .map((text) => text.trim())
            .filter(Boolean)
            .map((text) => ({ text })),
        }
      } else if (createType === 'announcement') {
        path = '/api/items/announcements'
        payload = { title: extra || undefined, body: draft, pinned: true }
      } else if (createType === 'recurring_expense') {
        path = '/api/items/recurring-expenses'
        payload = {
          name: draft,
          amount: Number(amount),
          currency: extra || 'KRW',
          billingDay: Number(billingDay),
          reminderDaysBefore: 3,
        }
      }

      const response = await apiFetch<{ item: InboxItem }>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      onCreated(response.item)
      resetComposer()
    } catch {
      setError('저장하지 못했습니다.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
    <form className="composer" onSubmit={submit}>
      {menuOpen && (
        <div className="create-sheet" aria-label="생성 메뉴">
          {createTypes.map((entry) => (
            <button
              className={entry.type === createType ? 'selected' : ''}
              key={entry.type}
              onClick={() => {
                setCreateType(entry.type)
                setMenuOpen(false)
                setError('')
              }}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {!isNote && !isReminder && (
        <div className="detail-tray">
          <span>{typeLabel(createType)}</span>
          {createType === 'file' ? (
            <input
              accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown"
              aria-label="파일 선택"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          ) : createType === 'list' ? (
            <textarea
              aria-label="리스트 항목"
              onChange={(event) => setExtra(event.target.value)}
              placeholder="항목을 줄마다 입력"
              rows={2}
              value={extra}
            />
          ) : createType === 'recurring_expense' ? (
            <div className="split-fields">
              <input
                aria-label="통화"
                onChange={(event) => setExtra(event.target.value)}
                placeholder="KRW"
                value={extra}
              />
              <input
                aria-label="금액"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="금액"
                value={amount}
              />
              <input
                aria-label="결제일"
                inputMode="numeric"
                max="31"
                min="1"
                onChange={(event) => setBillingDay(event.target.value)}
                type="number"
                value={billingDay}
              />
            </div>
          ) : (
            <input
              aria-label="추가 정보"
              onChange={(event) => setExtra(event.target.value)}
              placeholder="제목"
              value={extra}
            />
          )}
        </div>
      )}

      {error && <p className="composer-error">{error}</p>}

      <div className="composer-row">
        <button
          aria-label="생성 메뉴 열기"
          className="plus-button"
          onClick={() => setMenuOpen((value) => !value)}
          type="button"
        >
          ＋
        </button>
        <input
          aria-label="나에게 입력"
          disabled={createType === 'file'}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={createType === 'file' ? selectedFile?.name ?? '파일 선택' : placeholder}
          value={createType === 'file' ? selectedFile?.name ?? '' : draft}
        />
        {isReminder ? (
          <button
            className="send-button"
            onClick={() => setReminderSheetOpen(true)}
            type="button"
          >
            Add Reminder
          </button>
        ) : (
          <button className="send-button" disabled={isSending || !canSend} type="submit">
            보내기
          </button>
        )}
      </div>
    </form>
      {reminderSheetOpen && isReminder && (
        <ReminderSheet
          initialTitle={draft}
          onCancel={() => {
            setReminderSheetOpen(false)
            resetComposer()
          }}
          onSaved={(item) => {
            setReminderSheetOpen(false)
            onCreated(item)
            resetComposer()
          }}
        />
      )}
    </>
  )
}

function InboxScreen({
  alerts,
  items,
  onCreated,
}: {
  alerts: AlertItem[]
  items: InboxItem[]
  onCreated: (item: InboxItem) => void
}) {
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const visibleItems = useMemo(() => sortItemsOldestFirst(items), [items])

  useEffect(() => {
    const timeline = timelineRef.current
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight
    }
  }, [visibleItems.length])

  return (
    <>
      <main className="screen inbox-screen">
        <InboxHeader alerts={alerts} />
        <AlertStrip alerts={alerts} />
        <div className="timeline-scroll" ref={timelineRef}>
          <Timeline items={visibleItems} />
        </div>
      </main>
      <Composer onCreated={onCreated} />
    </>
  )
}

function SearchScreen({ allItems }: { allItems: InboxItem[] }) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<CategoryLabel>('All')

  const filteredItems = useMemo(() => {
    const byCategory = filterItemsByCategory(allItems, activeCategory)
    if (!query.trim()) {
      return sortItemsOldestFirst(byCategory)
    }

    const q = query.trim().toLowerCase()
    return sortItemsOldestFirst(
      byCategory.filter((item) => {
        const detail = item.detail ?? {}
        return [
          item.body ?? '',
          asText(detail.text),
          asText(detail.title),
          asText(detail.url),
          asText(detail.memo),
          asText(detail.body),
          asText(detail.name),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)
      }),
    )
  }, [allItems, activeCategory, query])

  return (
    <main className="screen plain-screen">
      <div className="search-box">
        <input
          aria-label="검색어"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="검색"
          value={query}
        />
      </div>

      <div className="filter-row no-scrollbar" aria-label="카테고리 필터">
        {categoryLabels.map((category) => (
          <button
            className={category === activeCategory ? 'selected' : ''}
            key={category}
            onClick={() => setActiveCategory(category)}
            type="button"
          >
            {category}
          </button>
        ))}
      </div>

      <section className="search-results" aria-label="검색 결과">
        {filteredItems.length ? (
          filteredItems.map((item) => <MessageBubble item={item} key={item.id} />)
        ) : (
          <div className="empty-thread">검색 결과가 없습니다.</div>
        )}
      </section>
    </main>
  )
}

function Section({
  children,
  title,
}: {
  children: ReactNode
  title: string
}) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="settings-list">{children}</div>
    </section>
  )
}

function SettingsRow({
  children,
  danger = false,
  onClick,
  title,
  value,
}: {
  children?: React.ReactNode
  danger?: boolean
  onClick?: () => void
  title: string
  value?: string
}) {
  if (!onClick) {
    return (
      <div className="settings-row">
        <span>{title}</span>
        {value && <small>{value}</small>}
        {children}
      </div>
    )
  }

  return (
    <button
      className={`settings-row ${danger ? 'danger-row' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span>{title}</span>
      {value && <small>{value}</small>}
    </button>
  )
}

function SettingsHome({
  onLogout,
  onOpen,
  settings,
  user,
}: {
  onLogout: () => void
  onOpen: (view: SettingsView) => void
  settings: SettingsResponse | null
  user: AuthUser | null
}) {
  return (
    <main className="screen plain-screen">
      <header className="section-header">
        <h1>설정</h1>
      </header>

      <Section title="Account">
        <SettingsRow
          onClick={() => onOpen('editUsername')}
          title="User name"
          value={settings?.user?.username ?? user?.username ?? 'local'}
        />
        <SettingsRow onClick={() => onOpen('changePassword')} title="Change Password" />
      </Section>

      <Section title="Data">
        <SettingsRow onClick={() => onOpen('exportData')} title="Export Data" />
        <SettingsRow onClick={() => onOpen('importData')} title="Import Data" />
      </Section>

      <Section title="Reminder Advance">
        <SettingsRow
          onClick={() => onOpen('reminder')}
          title="Default Advance"
          value={
            reminderOptions.find(
              (option) => option.value === settings?.defaultReminderAdvanceMinutes,
            )?.label ?? '15 minutes'
          }
        />
      </Section>

      <Section title="Information">
        <SettingsRow title="Version" value={settings?.version ?? '0.0.0'} />
      </Section>

      <Section title="Danger zone">
        <SettingsRow danger onClick={onLogout} title="Log out" />
        <SettingsRow danger onClick={() => onOpen('deleteAccount')} title="Delete Account" />
      </Section>
    </main>
  )
}

function SubHeader({
  onBack,
  title,
}: {
  onBack: () => void
  title: string
}) {
  return (
    <header className="sub-header">
      <button className="text-button" onClick={onBack} type="button">
        뒤로
      </button>
      <div>
        <h1>{title}</h1>
      </div>
    </header>
  )
}

function EditUsernameScreen({
  onBack,
  onUpdated,
  user,
}: {
  onBack: () => void
  onUpdated: (user: AuthUser) => void
  user: AuthUser | null
}) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [error, setError] = useState('')
  const trimmedUsername = username.trim()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')

    if (!trimmedUsername) {
      setError('User name is required.')
      return
    }

    try {
      const response = await apiFetch<{ user: AuthUser }>('/api/auth/username', {
        method: 'PATCH',
        body: JSON.stringify({ username }),
      })
      onUpdated(response.user)
      onBack()
    } catch {
      setError('Could not update the user name.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="User name" />
      <form className="settings-form" onSubmit={submit}>
        <input
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
          placeholder="User name"
          value={username}
        />
        {error && <p className="form-error">{error}</p>}
        <button disabled={!trimmedUsername} type="submit">
          Save
        </button>
      </form>
    </main>
  )
}

function ChangePasswordScreen({ onBack }: { onBack: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (newPassword.length < 8) {
      setError('새 비밀번호는 8자 이상이어야 합니다.')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('새 비밀번호가 일치하지 않습니다.')
      return
    }

    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setMessage('비밀번호를 변경했습니다. 현재 세션은 유지됩니다.')
    } catch {
      setError('비밀번호를 변경하지 못했습니다.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="Change Password" />
      <form className="settings-form" onSubmit={submit}>
        <input
          autoComplete="current-password"
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder="현재 비밀번호"
          type="password"
          value={currentPassword}
        />
        <input
          autoComplete="new-password"
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder="새 비밀번호"
          type="password"
          value={newPassword}
        />
        <input
          autoComplete="new-password"
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="새 비밀번호 확인"
          type="password"
          value={confirmPassword}
        />
        {error && <p className="form-error">{error}</p>}
        {message && <p className="form-success">{message}</p>}
        <button type="submit">변경</button>
      </form>
    </main>
  )
}

function ExportDataScreen({ onBack }: { onBack: () => void }) {
  const [format, setFormat] = useState<'plain' | 'encrypted'>('plain')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function exportData() {
    setError('')

    if (format === 'encrypted' && !password) {
      setError('내보내기 암호를 입력하세요.')
      return
    }

    try {
      const response = await apiFetch<unknown>('/api/data/export', {
        method: 'POST',
        body: JSON.stringify({ format, password: format === 'encrypted' ? password : undefined }),
      })
      downloadJson(
        format === 'encrypted' ? 'mebox-export.encrypted.json' : 'mebox-export.json',
        response,
      )
      setPassword('')
    } catch {
      setError('내보내기에 실패했습니다.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="Export Data" />
      <div className="settings-form">
        <div className="choice-group">
          <button
            className={format === 'plain' ? 'selected' : ''}
            onClick={() => setFormat('plain')}
            type="button"
          >
            평문으로 내보내기
          </button>
          <button
            className={format === 'encrypted' ? 'selected' : ''}
            onClick={() => setFormat('encrypted')}
            type="button"
          >
            암호화해서 내보내기
          </button>
        </div>
        {format === 'encrypted' && (
          <input
            onChange={(event) => setPassword(event.target.value)}
            placeholder="내보내기 암호"
            type="password"
            value={password}
          />
        )}
        <p className="settings-help">업로드 파일의 바이너리는 이번 내보내기에 포함되지 않습니다.</p>
        {error && <p className="form-error">{error}</p>}
        <button onClick={exportData} type="button">
          다운로드
        </button>
      </div>
    </main>
  )
}

function ImportDataScreen({
  onBack,
  onImported,
}: {
  onBack: () => void
  onImported: () => Promise<void>
}) {
  const [format, setFormat] = useState<'plain' | 'encrypted'>('plain')
  const [password, setPassword] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function importData() {
    setError('')
    setMessage('')

    if (!file) {
      setError('가져올 JSON 파일을 선택하세요.')
      return
    }

    if (format === 'encrypted' && !password) {
      setError('암호화 JSON 암호를 입력하세요.')
      return
    }

    try {
      const payload = JSON.parse(await file.text())
      const response = await apiFetch<{ importedItems: number }>('/api/data/import', {
        method: 'POST',
        body: JSON.stringify({ format, password: format === 'encrypted' ? password : undefined, payload }),
      })
      await onImported()
      setMessage(`${response.importedItems}개 항목을 가져왔습니다.`)
      setPassword('')
      setFile(null)
    } catch {
      setError('가져오기에 실패했습니다.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="Import Data" />
      <div className="settings-form">
        <div className="choice-group">
          <button
            className={format === 'plain' ? 'selected' : ''}
            onClick={() => setFormat('plain')}
            type="button"
          >
            평문 JSON
          </button>
          <button
            className={format === 'encrypted' ? 'selected' : ''}
            onClick={() => setFormat('encrypted')}
            type="button"
          >
            암호화 JSON
          </button>
        </div>
        <input
          accept="application/json,.json"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          type="file"
        />
        {format === 'encrypted' && (
          <input
            onChange={(event) => setPassword(event.target.value)}
            placeholder="가져오기 암호"
            type="password"
            value={password}
          />
        )}
        <p className="settings-help">
          가져오기는 기존 데이터를 지우지 않고 가능한 항목을 추가합니다. 파일 항목은
          메타데이터만 복원되며 업로드 파일 바이너리는 포함되지 않습니다.
        </p>
        {error && <p className="form-error">{error}</p>}
        {message && <p className="form-success">{message}</p>}
        <button onClick={importData} type="button">
          가져오기
        </button>
      </div>
    </main>
  )
}

function ReminderScreen({
  onBack,
  onUpdated,
  settings,
}: {
  onBack: () => void
  onUpdated: (settings: Partial<SettingsResponse>) => void
  settings: SettingsResponse | null
}) {
  const [error, setError] = useState('')

  async function update(value: number) {
    setError('')

    try {
      const response = await apiFetch<{ defaultReminderAdvanceMinutes: number }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ defaultReminderAdvanceMinutes: value }),
      })
      onUpdated({ defaultReminderAdvanceMinutes: response.defaultReminderAdvanceMinutes })
    } catch {
      setError('설정을 저장하지 못했습니다.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="Reminder Advance" />
      <section className="settings-section">
        <div className="settings-intro">
          <strong>Default Advance</strong>
          <p>Select how long before the scheduled time you want to be notified</p>
        </div>
        <div className="settings-list">
          {reminderOptions.map((option) => (
            <button
              className="settings-row"
              key={option.value}
              onClick={() => {
                void update(option.value)
              }}
              type="button"
            >
              <span>{option.label}</span>
              {settings?.defaultReminderAdvanceMinutes === option.value && <small>선택됨</small>}
            </button>
          ))}
        </div>
      </section>
      {error && <p className="form-error">{error}</p>}
    </main>
  )
}

function DeleteAccountScreen({
  onBack,
  onDeleted,
}: {
  onBack: () => void
  onDeleted: () => Promise<void>
}) {
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')

    try {
      await apiFetch('/api/auth/delete-account', {
        method: 'POST',
        body: JSON.stringify({ confirmation }),
      })
      await onDeleted()
    } catch {
      setError('계정을 삭제하지 못했습니다. DELETE를 정확히 입력하세요.')
    }
  }

  return (
    <main className="screen plain-screen">
      <SubHeader onBack={onBack} title="Delete Account" />
      <form className="settings-form" onSubmit={submit}>
        <p className="settings-help">
          로컬 계정, 세션, 인박스 데이터, 앱 설정, 업로드 파일을 삭제합니다. 소스 코드나
          저장소 파일은 삭제하지 않습니다.
        </p>
        <input
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="DELETE"
          value={confirmation}
        />
        {error && <p className="form-error">{error}</p>}
        <button className="danger-button" disabled={confirmation !== 'DELETE'} type="submit">
          Delete Account
        </button>
      </form>
    </main>
  )
}

function SettingsScreen({
  onDeleted,
  onImported,
  onLogout,
  settings,
  setSettings,
  setUser,
  user,
}: {
  onDeleted: () => Promise<void>
  onImported: () => Promise<void>
  onLogout: () => void
  settings: SettingsResponse | null
  setSettings: (settings: SettingsResponse | null) => void
  setUser: (user: AuthUser | null) => void
  user: AuthUser | null
}) {
  const [view, setView] = useState<SettingsView>('home')

  useEffect(() => {
    async function loadSettings() {
      try {
        setSettings(await apiFetch<SettingsResponse>('/api/settings'))
      } catch {
        setSettings(null)
      }
    }

    void loadSettings()
  }, [setSettings])

  if (view === 'editUsername') {
    return (
      <EditUsernameScreen
        onBack={() => setView('home')}
        onUpdated={(updatedUser) => {
          setUser(updatedUser)
          setSettings(settings ? { ...settings, user: updatedUser } : settings)
        }}
        user={settings?.user ?? user}
      />
    )
  }

  if (view === 'changePassword') {
    return <ChangePasswordScreen onBack={() => setView('home')} />
  }

  if (view === 'exportData') {
    return <ExportDataScreen onBack={() => setView('home')} />
  }

  if (view === 'importData') {
    return <ImportDataScreen onBack={() => setView('home')} onImported={onImported} />
  }

  if (view === 'reminder') {
    return (
      <ReminderScreen
        onBack={() => setView('home')}
        onUpdated={(partial) => {
          setSettings(settings ? { ...settings, ...partial } : null)
        }}
        settings={settings}
      />
    )
  }

  if (view === 'deleteAccount') {
    return <DeleteAccountScreen onBack={() => setView('home')} onDeleted={onDeleted} />
  }

  return (
    <SettingsHome
      onLogout={onLogout}
      onOpen={setView}
      settings={settings}
      user={user}
    />
  )
}

function BottomNav({
  activeNav,
  onChange,
}: {
  activeNav: NavKey
  onChange: (nav: NavKey) => void
}) {
  return (
    <nav className="bottom-nav" aria-label="하단 내비게이션">
      <button
        className={activeNav === 'inbox' ? 'active' : ''}
        onClick={() => onChange('inbox')}
        type="button"
      >
        인박스
      </button>
      <button
        className={activeNav === 'search' ? 'active' : ''}
        onClick={() => onChange('search')}
        type="button"
      >
        검색
      </button>
      <button
        className={activeNav === 'settings' ? 'active' : ''}
        onClick={() => onChange('settings')}
        type="button"
      >
        설정
      </button>
    </nav>
  )
}

function App() {
  const [authView, setAuthView] = useState<AuthView>('loading')
  const [activeNav, setActiveNav] = useState<NavKey>('inbox')
  const [items, setItems] = useState<InboxItem[]>([])
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loadError, setLoadError] = useState('')
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)

  async function refreshAuth() {
    try {
      const response = await apiFetch<AuthResponse>('/api/auth/me')
      setUser(response.user)
      setAuthView(response.authenticated ? 'authenticated' : response.setupRequired ? 'setup' : 'login')
    } catch {
      setAuthView('login')
    }
  }

  async function refreshInbox() {
    try {
      const [itemResponse, alertResponse] = await Promise.all([
        apiFetch<{ items: InboxItem[] }>('/api/items'),
        apiFetch<{ alerts: AlertItem[] }>('/api/alerts'),
      ])
      setItems(itemResponse.items)
      setAlerts(alertResponse.alerts)
      setLoadError('')
    } catch {
      setLoadError('로컬 서버에 연결되지 않았습니다.')
    }
  }

  async function logout() {
    try {
      await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } finally {
      setItems([])
      setAlerts([])
      setSettings(null)
      setUser(null)
      setActiveNav('inbox')
      setAuthView('login')
    }
  }

  async function handleDeleted() {
    setItems([])
    setAlerts([])
    setSettings(null)
    setUser(null)
    setActiveNav('inbox')
    await refreshAuth()
  }

  async function handleImported() {
    await refreshInbox()
  }

  useEffect(() => {
    void Promise.resolve().then(refreshAuth)
  }, [])

  useEffect(() => {
    if (authView === 'authenticated') {
      void Promise.resolve().then(refreshInbox)
    }
  }, [authView])

  if (authView === 'loading') {
    return (
      <main className="auth-screen">
        <div className="auth-panel compact">
          <span className="auth-mark">MeBox</span>
          <h1>로딩</h1>
        </div>
      </main>
    )
  }

  if (authView === 'setup' || authView === 'login') {
    return (
      <AuthScreen
        mode={authView}
        onAuthenticated={(nextUser) => {
          setUser(nextUser)
          setAuthView('authenticated')
        }}
      />
    )
  }

  return (
    <div className="desktop-stage">
      <div className="phone-shell">
        {loadError && <div className="offline-banner">{loadError}</div>}

        {activeNav === 'search' ? (
          <SearchScreen allItems={items} />
        ) : activeNav === 'settings' ? (
          <SettingsScreen
            onDeleted={handleDeleted}
            onImported={handleImported}
            onLogout={() => {
              void logout()
            }}
            settings={settings}
            setSettings={setSettings}
            setUser={setUser}
            user={user}
          />
        ) : (
          <InboxScreen
            alerts={alerts}
            items={items}
            onCreated={(item) => {
              setItems((current) => [...current, item])
              void refreshInbox()
            }}
          />
        )}

        <BottomNav activeNav={activeNav} onChange={setActiveNav} />
      </div>
    </div>
  )
}

export default App

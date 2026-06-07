import { useEffect, useMemo, useState, type FormEvent } from 'react'
import './App.css'

type ItemType =
  | 'note'
  | 'link'
  | 'todo'
  | 'list'
  | 'file'
  | 'announcement'
  | 'recurring_expense'

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

type NavKey = 'inbox' | 'search' | 'more'
type CreateType =
  | 'note'
  | 'link'
  | 'todo'
  | 'list'
  | 'file'
  | 'announcement'
  | 'recurring_expense'

const createTypes: { type: CreateType; label: string }[] = [
  { type: 'note', label: '메모' },
  { type: 'link', label: '링크' },
  { type: 'todo', label: '할일' },
  { type: 'list', label: '리스트' },
  { type: 'file', label: '파일' },
  { type: 'announcement', label: '공지' },
  { type: 'recurring_expense', label: '지출' },
]

const searchTypes: { type: ItemType | 'all'; label: string }[] = [
  { type: 'all', label: '전체' },
  { type: 'note', label: '메모' },
  { type: 'link', label: '링크' },
  { type: 'announcement', label: '공지' },
  { type: 'file', label: '파일' },
]

const moreLinks = [
  'Links',
  'Tasks',
  'Lists',
  'Files',
  'Announcements',
  'Money',
  'Settings',
]

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw new Error('Request failed')
  }

  return response.json() as Promise<T>
}

function asText(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : 0
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function typeLabel(type: ItemType) {
  switch (type) {
    case 'note':
      return '메모'
    case 'link':
      return '링크'
    case 'todo':
      return '할일'
    case 'list':
      return '리스트'
    case 'file':
      return '파일'
    case 'announcement':
      return '공지'
    case 'recurring_expense':
      return '지출'
  }
}

function ItemCard({ item }: { item: InboxItem }) {
  const detail = item.detail ?? {}

  return (
    <article className={`item-card item-${item.type}`}>
      <div className="card-meta">
        <span>{typeLabel(item.type)}</span>
        <time>{formatDate(item.createdAt)}</time>
      </div>

      {item.type === 'note' && <p>{asText(detail.text)}</p>}

      {item.type === 'link' && (
        <>
          <strong>{asText(detail.title) || asText(detail.url)}</strong>
          <p>{asText(detail.memo)}</p>
          <span className="muted">{asText(detail.url)}</span>
        </>
      )}

      {item.type === 'todo' && (
        <>
          <strong>{asText(detail.title)}</strong>
          <span className="muted">
            {asText(detail.completedAt) ? '완료됨' : '미완료'}
            {asText(detail.dueAt) && ` · ${formatDate(asText(detail.dueAt))}`}
          </span>
        </>
      )}

      {item.type === 'list' && (
        <>
          <strong>{asText(detail.title)}</strong>
          <ul className="check-list">
            {(Array.isArray(detail.items) ? detail.items : []).slice(0, 5).map((row) => {
              const listItem = row as Record<string, unknown>
              return (
                <li key={String(listItem.id)}>
                  <span aria-hidden="true">
                    {asText(listItem.completedAt) ? '✓' : '□'}
                  </span>
                  {asText(listItem.text)}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {item.type === 'file' && (
        <>
          <strong>{asText(detail.originalName)}</strong>
          <span className="muted">
            {asText(detail.mimeType)} · {Math.round(asNumber(detail.sizeBytes) / 1024)} KB
          </span>
        </>
      )}

      {item.type === 'announcement' && (
        <>
          <strong>{asText(detail.title) || '공지'}</strong>
          <p>{asText(detail.body)}</p>
        </>
      )}

      {item.type === 'recurring_expense' && (
        <>
          <strong>{asText(detail.name)}</strong>
          <span className="muted">
            {asText(detail.currency)} {asNumber(detail.amount).toLocaleString()} · 매월{' '}
            {asNumber(detail.billingDay)}일
          </span>
        </>
      )}
    </article>
  )
}

function Alerts({ alerts }: { alerts: AlertItem[] }) {
  if (!alerts.length) {
    return null
  }

  return (
    <section className="alerts" aria-label="내부 알림">
      {alerts.map((alert) => (
        <div className="alert-pill" key={`${alert.type}-${alert.id}`}>
          <strong>{alert.title}</strong>
          <span>
            {alert.severity === 'overdue' ? '지남' : '곧 예정'} · {alert.dueOn}
          </span>
        </div>
      ))}
    </section>
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
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')

  const placeholder = createType === 'note' ? '나에게 입력...' : `${typeLabel(createType)} 입력...`

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (createType === 'file') {
      setError('파일 업로드는 다음 단계에서 연결됩니다.')
      return
    }

    setIsSending(true)
    setError('')

    try {
      let path = '/api/items/notes'
      let payload: Record<string, unknown> = { body: draft }

      if (createType === 'link') {
        path = '/api/items/links'
        payload = { url: draft, title: extra || undefined }
      }
      if (createType === 'todo') {
        path = '/api/items/todos'
        payload = { title: draft, dueAt: extra ? new Date(extra).toISOString() : undefined }
      }
      if (createType === 'list') {
        path = '/api/items/lists'
        payload = {
          title: draft,
          items: extra
            .split('\n')
            .map((text) => text.trim())
            .filter(Boolean)
            .map((text) => ({ text })),
        }
      }
      if (createType === 'announcement') {
        path = '/api/items/announcements'
        payload = { title: extra || undefined, body: draft, pinned: true }
      }
      if (createType === 'recurring_expense') {
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
      setDraft('')
      setExtra('')
      setAmount('')
      setBillingDay('1')
    } catch {
      setError('저장하지 못했습니다. 입력값과 로컬 서버를 확인하세요.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {menuOpen && (
        <div className="create-menu">
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

      {createType !== 'note' && createType !== 'file' && (
        <div className="extra-fields">
          {createType === 'todo' ? (
            <input
              aria-label="마감일"
              onChange={(event) => setExtra(event.target.value)}
              type="datetime-local"
              value={extra}
            />
          ) : createType === 'list' ? (
            <textarea
              aria-label="리스트 항목"
              onChange={(event) => setExtra(event.target.value)}
              placeholder="항목을 줄마다 입력"
              rows={3}
              value={extra}
            />
          ) : (
            <input
              aria-label="추가 정보"
              onChange={(event) => setExtra(event.target.value)}
              placeholder={
                createType === 'link'
                  ? '제목'
                  : createType === 'announcement'
                    ? '제목'
                    : 'KRW'
              }
              value={extra}
            />
          )}

          {createType === 'recurring_expense' && (
            <div className="split-fields">
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
          )}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

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
          placeholder={createType === 'file' ? '파일 업로드 TODO' : placeholder}
          value={draft}
        />
        <button disabled={isSending || !draft.trim()} type="submit">
          보내기
        </button>
      </div>
    </form>
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
  return (
    <>
      <main className="screen inbox-screen">
        <header className="app-header">
          <div>
            <span className="eyebrow">MeBox</span>
            <h1>나와의 인박스</h1>
          </div>
          <span className="status-dot">로컬</span>
        </header>

        <Alerts alerts={alerts} />

        <section className="timeline" aria-label="인박스 타임라인">
          {items.length ? (
            items.map((item) => <ItemCard item={item} key={item.id} />)
          ) : (
            <div className="empty-state">첫 메모를 남겨보세요.</div>
          )}
        </section>
      </main>

      <Composer onCreated={onCreated} />
    </>
  )
}

function SearchScreen() {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<ItemType | 'all'>('all')
  const [items, setItems] = useState<InboxItem[]>([])
  const [error, setError] = useState('')

  async function runSearch(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) {
      setItems([])
      return
    }

    const params = new URLSearchParams({ q: query })
    if (type !== 'all') {
      params.set('type', type)
    }

    try {
      const response = await apiFetch<{ items: InboxItem[] }>(
        `/api/search?${params.toString()}`,
      )
      setItems(response.items)
      setError('')
    } catch {
      setError('검색하지 못했습니다.')
    }
  }

  return (
    <main className="screen">
      <header className="app-header compact">
        <div>
          <span className="eyebrow">검색</span>
          <h1>필요한 것 찾기</h1>
        </div>
      </header>

      <form className="search-box" onSubmit={runSearch}>
        <input
          aria-label="검색어"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="키워드 검색"
          value={query}
        />
        <button type="submit">검색</button>
      </form>

      <div className="filter-row" aria-label="타입 필터">
        {searchTypes.map((entry) => (
          <button
            className={entry.type === type ? 'selected' : ''}
            key={entry.type}
            onClick={() => setType(entry.type)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <section className="timeline search-results">
        {items.map((item) => (
          <ItemCard item={item} key={item.id} />
        ))}
      </section>
    </main>
  )
}

function MoreScreen() {
  return (
    <main className="screen">
      <header className="app-header compact">
        <div>
          <span className="eyebrow">더보기</span>
          <h1>보관함</h1>
        </div>
      </header>

      <section className="more-grid">
        {moreLinks.map((label) => (
          <a href={`#${label.toLowerCase()}`} key={label}>
            <span>{label}</span>
            <span aria-hidden="true">›</span>
          </a>
        ))}
      </section>
    </main>
  )
}

function App() {
  const [activeNav, setActiveNav] = useState<NavKey>('inbox')
  const [items, setItems] = useState<InboxItem[]>([])
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loadError, setLoadError] = useState('')

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

  useEffect(() => {
    void Promise.resolve().then(refreshInbox)
  }, [])

  const screen = useMemo(() => {
    if (activeNav === 'search') {
      return <SearchScreen />
    }
    if (activeNav === 'more') {
      return <MoreScreen />
    }
    return (
      <InboxScreen
        alerts={alerts}
        items={items}
        onCreated={(item) => {
          setItems((current) => [item, ...current])
          void refreshInbox()
        }}
      />
    )
  }, [activeNav, alerts, items])

  return (
    <div className="app-shell">
      {loadError && activeNav === 'inbox' && (
        <div className="offline-banner">{loadError}</div>
      )}

      {screen}

      <nav className="bottom-nav" aria-label="하단 내비게이션">
        <button
          className={activeNav === 'inbox' ? 'active' : ''}
          onClick={() => setActiveNav('inbox')}
          type="button"
        >
          인박스
        </button>
        <button
          className={activeNav === 'search' ? 'active' : ''}
          onClick={() => setActiveNav('search')}
          type="button"
        >
          검색
        </button>
        <button
          className={activeNav === 'more' ? 'active' : ''}
          onClick={() => setActiveNav('more')}
          type="button"
        >
          더보기
        </button>
      </nav>
    </div>
  )
}

export default App

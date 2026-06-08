export type ItemType =
  | 'note'
  | 'link'
  | 'todo'
  | 'list'
  | 'file'
  | 'announcement'
  | 'recurring_expense'

export type CategoryLabel =
  | 'All'
  | 'Chat'
  | 'Link'
  | 'Reminders'
  | 'List'
  | 'File'
  | 'Notification'
  | 'Fixed'

export type DisplayInboxItem = {
  id: number
  type: ItemType
  createdAt: string
}

export const categoryLabels: CategoryLabel[] = [
  'All',
  'Chat',
  'Link',
  'Reminders',
  'List',
  'File',
  'Notification',
  'Fixed',
]

export function normalizeLinkUrl(input: string) {
  const trimmed = input.trim()

  if (!trimmed || /\s/.test(trimmed)) {
    return null
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(withProtocol)
    const protocol = url.protocol.toLowerCase()
    const hostname = url.hostname.toLowerCase()

    if (!['http:', 'https:'].includes(protocol)) {
      return null
    }

    if (!hostname || (!hostname.includes('.') && hostname !== 'localhost')) {
      return null
    }

    url.protocol = protocol
    url.hostname = hostname

    if ((url.pathname === '/' || url.pathname === '') && !url.search && !url.hash) {
      return `${url.protocol}//${url.host}`
    }

    return url.toString()
  } catch {
    return null
  }
}

export function categoryForItemType(type: ItemType): Exclude<CategoryLabel, 'All'> {
  switch (type) {
    case 'note':
      return 'Chat'
    case 'link':
      return 'Link'
    case 'todo':
      return 'Reminders'
    case 'list':
      return 'List'
    case 'file':
      return 'File'
    case 'announcement':
      return 'Notification'
    case 'recurring_expense':
      return 'Fixed'
  }
}

export function filterItemsByCategory<T extends DisplayInboxItem>(
  items: T[],
  category: CategoryLabel,
) {
  if (category === 'All') {
    return items
  }

  return items.filter((item) => categoryForItemType(item.type) === category)
}

export function parseAppDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`)
  }

  return new Date(value)
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatDateTitle(value: string, now = new Date()) {
  const day = startOfLocalDay(parseAppDate(value))
  const today = startOfLocalDay(now)
  const oneDay = 24 * 60 * 60 * 1000

  if (day === today) {
    return 'Today'
  }

  if (day === today - oneDay) {
    return 'Yesterday'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(parseAppDate(value))
}

export function formatMessageTime(value: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(parseAppDate(value))
}

export function sortItemsOldestFirst<T extends DisplayInboxItem>(items: T[]) {
  return [...items].sort((left, right) => {
    const byDate = parseAppDate(left.createdAt).getTime() - parseAppDate(right.createdAt).getTime()

    return byDate === 0 ? left.id - right.id : byDate
  })
}

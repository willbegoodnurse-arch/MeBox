export type ItemType =
  | 'note'
  | 'link'
  | 'todo'
  | 'list'
  | 'file'
  | 'announcement'
  | 'recurring_expense'

export type InboxItem = {
  id: number
  type: ItemType
  body: string | null
  createdAt: string
  updatedAt: string
  detail: Record<string, unknown> | null
}

export type AlertItem = {
  id: number
  type: 'todo' | 'recurring_expense'
  title: string
  dueOn: string
  severity: 'due_soon' | 'overdue'
  detail?: string
}

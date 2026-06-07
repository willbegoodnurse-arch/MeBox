import type Database from 'better-sqlite3'
import type { AlertItem } from './model'

type TodoAlertRow = {
  item_id: number
  title: string
  due_at: string
}

type ExpenseAlertRow = {
  item_id: number
  name: string
  amount: number
  currency: string
  billing_day: number
  reminder_days_before: number
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function toDateOnly(value: Date) {
  return dateFormatter.format(value)
}

function utcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day))
}

function clampDay(year: number, month: number, day: number) {
  return Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
}

export function nextBillingDate(today: Date, billingDay: number) {
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()
  const thisMonth = utcDate(year, month, clampDay(year, month, billingDay))

  if (thisMonth >= utcDate(year, month, today.getUTCDate())) {
    return thisMonth
  }

  const nextMonth = month + 1
  const nextYear = year + Math.floor(nextMonth / 12)
  const normalizedMonth = nextMonth % 12
  return utcDate(
    nextYear,
    normalizedMonth,
    clampDay(nextYear, normalizedMonth, billingDay),
  )
}

function daysBetween(start: Date, end: Date) {
  const startUtc = utcDate(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  ).getTime()
  const endUtc = utcDate(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  ).getTime()

  return Math.round((endUtc - startUtc) / 86_400_000)
}

export function listAlerts(db: Database.Database, now = new Date()): AlertItem[] {
  const today = toDateOnly(now)
  const todos = db
    .prepare(
      `
      SELECT item_id, title, due_at
      FROM todos
      WHERE completed_at IS NULL
        AND due_at IS NOT NULL
        AND date(due_at) <= date(?)
      ORDER BY due_at ASC
    `,
    )
    .all(today) as TodoAlertRow[]

  const todoAlerts = todos.map((todo) => ({
    id: todo.item_id,
    type: 'todo' as const,
    title: todo.title,
    dueOn: todo.due_at,
    severity: 'overdue' as const,
  }))

  const expenses = db
    .prepare(
      `
      SELECT item_id, name, amount, currency, billing_day, reminder_days_before
      FROM recurring_expenses
    `,
    )
    .all() as ExpenseAlertRow[]

  const expenseAlerts = expenses.flatMap((expense) => {
    const nextDue = nextBillingDate(now, expense.billing_day)
    const daysUntilDue = daysBetween(now, nextDue)

    if (daysUntilDue > expense.reminder_days_before) {
      return []
    }

    return [
      {
        id: expense.item_id,
        type: 'recurring_expense' as const,
        title: expense.name,
        dueOn: toDateOnly(nextDue),
        severity: daysUntilDue < 0 ? ('overdue' as const) : ('due_soon' as const),
        detail: `${expense.currency} ${expense.amount.toFixed(2)}`,
      },
    ]
  })

  return [...todoAlerts, ...expenseAlerts]
}

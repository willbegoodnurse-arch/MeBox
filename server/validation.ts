import { z } from 'zod'

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const noteInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
})

function normalizeLinkUrl(input: string) {
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

const linkUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => normalizeLinkUrl(value) !== null)
  .transform((value) => normalizeLinkUrl(value) ?? value)

export const linkInputSchema = z.object({
  url: linkUrlSchema,
  title: z.string().trim().max(300).optional(),
  memo: z.string().trim().max(5_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
})

export const todoInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  dueAt: z.iso.datetime().optional(),
  reminderAt: z.iso.datetime().optional(),
})

export const listInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(500),
        completed: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
})

export const listItemAddSchema = z.object({
  text: z.string().trim().min(1).max(500),
})

export const announcementInputSchema = z.object({
  title: z.string().trim().max(300).optional(),
  body: z.string().trim().min(1).max(20_000),
  pinned: z.boolean().default(true),
})

export const recurringExpenseInputSchema = z.object({
  name: z.string().trim().min(1).max(300),
  amount: z.number().finite().nonnegative(),
  currency: z.string().trim().min(3).max(8).default('KRW'),
  billingDay: z.number().int().min(1).max(31),
  reminderDaysBefore: z.number().int().min(0).max(31).default(3),
})

export const itemRenameSchema = z.object({
  name: z.string().trim().min(1).max(300),
})

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.string().trim().optional(),
})

export const usernameSchema = z.string().trim().min(1).max(80)

export const setupInputSchema = z.object({
  username: usernameSchema.optional(),
  password: z.string().min(8).max(200),
})

export const loginInputSchema = z.object({
  username: usernameSchema.optional(),
  password: z.string().min(1).max(200),
})

export const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must be different',
    path: ['newPassword'],
  })

export const updateUsernameInputSchema = z.object({
  username: usernameSchema,
})

export const deleteAccountInputSchema = z.object({
  confirmation: z.literal('DELETE'),
})

export const settingsPatchSchema = z.object({
  defaultReminderAdvanceMinutes: z
    .union([
      z.literal(0),
      z.literal(5),
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(120),
      z.literal(1440),
    ])
    .optional(),
})

export const exportInputSchema = z.object({
  format: z.enum(['plain', 'encrypted']),
  password: z.string().max(200).optional(),
})

export const importInputSchema = z.object({
  format: z.enum(['plain', 'encrypted']),
  password: z.string().max(200).optional(),
  payload: z.unknown(),
})

import { z } from 'zod'

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const noteInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
})

export const linkInputSchema = z.object({
  url: z.url(),
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

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.string().trim().optional(),
})

export const setupInputSchema = z.object({
  username: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(8).max(200),
})

export const loginInputSchema = z.object({
  password: z.string().min(1).max(200),
})

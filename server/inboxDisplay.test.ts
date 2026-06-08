import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  categoryForItemType,
  categoryLabels,
  filterItemsByCategory,
  formatDateTitle,
  formatMessageTime,
  normalizeLinkUrl,
  sortItemsOldestFirst,
  type DisplayInboxItem,
} from '../src/inboxDisplay'

const items: DisplayInboxItem[] = [
  { id: 1, type: 'note', createdAt: '2026-06-08T02:00:00.000Z' },
  { id: 2, type: 'link', createdAt: '2026-06-08T01:00:00.000Z' },
  { id: 3, type: 'todo', createdAt: '2026-06-08T03:00:00.000Z' },
  { id: 4, type: 'list', createdAt: '2026-06-08T04:00:00.000Z' },
  { id: 5, type: 'file', createdAt: '2026-06-08T05:00:00.000Z' },
  { id: 6, type: 'announcement', createdAt: '2026-06-08T06:00:00.000Z' },
  { id: 7, type: 'recurring_expense', createdAt: '2026-06-08T07:00:00.000Z' },
]

test('category labels are the Phase 1 English labels in visible order', () => {
  assert.deepEqual(categoryLabels, [
    'All',
    'Chat',
    'Link',
    'Reminders',
    'List',
    'File',
    'Notification',
    'Fixed',
  ])
})

test('item types map to inbox display categories', () => {
  assert.equal(categoryForItemType('note'), 'Chat')
  assert.equal(categoryForItemType('link'), 'Link')
  assert.equal(categoryForItemType('todo'), 'Reminders')
  assert.equal(categoryForItemType('list'), 'List')
  assert.equal(categoryForItemType('file'), 'File')
  assert.equal(categoryForItemType('announcement'), 'Notification')
  assert.equal(categoryForItemType('recurring_expense'), 'Fixed')
})

test('category filter returns only matching inbox items', () => {
  assert.deepEqual(filterItemsByCategory(items, 'All').map((item) => item.id), [
    1, 2, 3, 4, 5, 6, 7,
  ])
  assert.deepEqual(filterItemsByCategory(items, 'Chat').map((item) => item.id), [1])
  assert.deepEqual(filterItemsByCategory(items, 'Reminders').map((item) => item.id), [
    3,
  ])
  assert.deepEqual(filterItemsByCategory(items, 'Notification').map((item) => item.id), [
    6,
  ])
  assert.deepEqual(filterItemsByCategory(items, 'Fixed').map((item) => item.id), [7])
})

test('sortItemsOldestFirst uses createdAt then id as accessible DOM order', () => {
  assert.deepEqual(sortItemsOldestFirst(items).map((item) => item.id), [
    2, 1, 3, 4, 5, 6, 7,
  ])
})

test('local date formatting treats UTC sqlite timestamps using local browser time', () => {
  const now = new Date('2026-06-08T01:00:00+09:00')

  assert.equal(formatDateTitle('2026-06-07 15:30:00', now), 'Today')
  assert.equal(formatDateTitle('2026-06-06 15:30:00', now), 'Yesterday')
})

test('message time is formatted from the parsed local browser time', () => {
  assert.equal(formatMessageTime('2026-06-07 15:30:00', 'en-US'), '12:30 AM')
})

test('common link URLs are normalized before saving', () => {
  assert.equal(normalizeLinkUrl('naver.com'), 'https://naver.com')
  assert.equal(normalizeLinkUrl('www.naver.com'), 'https://www.naver.com')
  assert.equal(normalizeLinkUrl('WWW.NAVER.COM'), 'https://www.naver.com')
  assert.equal(normalizeLinkUrl('https://Example.test/path'), 'https://example.test/path')
})

test('clearly invalid link URLs are rejected', () => {
  assert.equal(normalizeLinkUrl('not a url'), null)
  assert.equal(normalizeLinkUrl('justtext'), null)
  assert.equal(normalizeLinkUrl('ftp://example.test'), null)
})

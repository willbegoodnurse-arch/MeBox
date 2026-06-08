import { expect, test, type Page, type TestInfo } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { initializeSchema } from '../../server/db/schema'

const E2E_DB_PATH = resolve(process.cwd(), '.e2e', 'mebox-e2e.sqlite')
const E2E_UPLOAD_DIR = resolve(process.cwd(), '.e2e', 'uploads')
const ADMIN_PASSWORD = 'ChangeThisPassword123!'
const EXPORT_PASSWORD = 'ExportPassword123!'

function resetAppState() {
  mkdirSync(dirname(E2E_DB_PATH), { recursive: true })
  rmSync(E2E_UPLOAD_DIR, { recursive: true, force: true })
  mkdirSync(E2E_UPLOAD_DIR, { recursive: true })

  const db = new Database(E2E_DB_PATH)
  initializeSchema(db)
  db.pragma('foreign_keys = OFF')
  db.exec(`
    DELETE FROM list_items;
    DELETE FROM recurring_expenses;
    DELETE FROM announcements;
    DELETE FROM files;
    DELETE FROM lists;
    DELETE FROM todos;
    DELETE FROM links;
    DELETE FROM app_settings;
    DELETE FROM sessions;
    DELETE FROM users;
    DELETE FROM items;
    DELETE FROM sqlite_sequence;
  `)
  db.pragma('foreign_keys = ON')
  db.close()
}

async function expectSetupScreen(page: Page) {
  await expect(page.locator('form.auth-panel')).toBeVisible()
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible()
  await expect(page.locator('input[autocomplete="new-password"]')).toBeVisible()
}

async function expectMainApp(page: Page) {
  await expect(page.locator('.phone-shell')).toBeVisible()
  await expect(page.locator('.composer')).toBeVisible()
}

async function createAccount(page: Page, username = 'admin', password = ADMIN_PASSWORD) {
  await expectSetupScreen(page)
  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[autocomplete="new-password"]').fill(password)
  await page.locator('form.auth-panel button[type="submit"]').click()
  await expectMainApp(page)
}

async function login(page: Page, username: string, password = ADMIN_PASSWORD) {
  await expect(page.locator('form.auth-panel')).toBeVisible()
  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('form.auth-panel button[type="submit"]').click()
}

async function openSettingsHome(page: Page) {
  await page.locator('.bottom-nav button').first().click()
  await page.locator('.bottom-nav button').nth(2).click()
  await expect(page.getByRole('button', { name: /User name/ })).toBeVisible()
}

async function logout(page: Page) {
  await openSettingsHome(page)
  await page.getByRole('button', { name: /Log out/ }).click()
  await expect(page.locator('form.auth-panel')).toBeVisible()
}

async function createNote(page: Page, text: string) {
  await page.locator('.composer-row input').fill(text)
  await page.locator('.send-button').click()
  await expect(page.getByText(text)).toBeVisible()
}

async function createLink(page: Page, url: string, title: string) {
  await page.locator('.plus-button').click()
  await page.locator('.create-sheet button').nth(1).click()
  await page.locator('.detail-tray input').fill(title)
  await page.locator('.composer-row input').fill(url)
  await page.locator('.send-button').click()
  await expect(page.getByText(title)).toBeVisible()
}

async function createTodo(page: Page, title: string) {
  await page.locator('.plus-button').click()
  await page.locator('.create-sheet button').nth(2).click()
  await page.locator('.composer-row input').fill(title)
  await page.locator('.send-button').click()
  await expect(page.getByText(title)).toBeVisible()
}

async function createInboxFixture(page: Page, suffix: string) {
  const note = `E2E note ${suffix}`
  const linkTitle = `E2E link ${suffix}`
  const todo = `E2E todo ${suffix}`

  await createNote(page, note)
  await createLink(page, `https://example.test/${suffix}`, linkTitle)
  await createTodo(page, todo)

  return { note, linkTitle, todo }
}

async function exportData(
  page: Page,
  testInfo: TestInfo,
  format: 'plain' | 'encrypted',
) {
  await openSettingsHome(page)
  await page.getByRole('button', { name: /Export Data/ }).click()

  if (format === 'encrypted') {
    await page.locator('.choice-group button').nth(1).click()
    await page.locator('input[type="password"]').fill(EXPORT_PASSWORD)
  }

  const downloadPromise = page.waitForEvent('download')
  await page.locator('.settings-form > button').click()
  const download = await downloadPromise
  const path = testInfo.outputPath(`${format}-export.json`)
  await download.saveAs(path)
  expect(existsSync(path)).toBe(true)
  return path
}

async function importData(
  page: Page,
  filePath: string,
  format: 'plain' | 'encrypted',
  password = EXPORT_PASSWORD,
) {
  await openSettingsHome(page)
  await page.getByRole('button', { name: /Import Data/ }).click()

  if (format === 'encrypted') {
    await page.locator('.choice-group button').nth(1).click()
    await page.locator('input[type="password"]').fill(password)
  }

  await page.locator('input[type="file"]').setInputFiles(filePath)
  await page.locator('.settings-form > button').click()
}

async function expectInboxItems(page: Page, items: string[]) {
  await page.locator('.bottom-nav button').first().click()
  for (const item of items) {
    await expect(page.getByText(item).first()).toBeVisible()
  }
}

test.beforeEach(async ({ context, page }) => {
  resetAppState()
  await context.clearCookies()
  await page.goto('/')
})

test('first-run setup creates an account and the created account can log in', async ({ page }) => {
  await createAccount(page)
  await logout(page)
  await login(page, 'admin')
  await expectMainApp(page)
})

test('username change invalidates the old username and allows login with the new username', async ({
  page,
}) => {
  await createAccount(page)

  await openSettingsHome(page)
  await page.getByRole('button', { name: /User name/ }).click()
  await page.locator('input[autocomplete="username"]').fill('admin2')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /admin2/ })).toBeVisible()

  await logout(page)
  await login(page, 'admin')
  await expect(page.locator('.form-error')).toBeVisible()

  await login(page, 'admin2')
  await expectMainApp(page)
})

test('plain JSON export/import round trip restores visible inbox items after reload', async ({
  page,
}, testInfo) => {
  await createAccount(page)
  const items = await createInboxFixture(page, 'plain-round-trip')
  const exportPath = await exportData(page, testInfo, 'plain')

  await importData(page, exportPath, 'plain')
  await expect(page.locator('.form-success')).toBeVisible()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])

  await page.reload()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])
})

test('encrypted JSON export/import round trip restores visible inbox items after reload', async ({
  page,
}, testInfo) => {
  await createAccount(page)
  const items = await createInboxFixture(page, 'encrypted-round-trip')
  const exportPath = await exportData(page, testInfo, 'encrypted')

  await importData(page, exportPath, 'encrypted')
  await expect(page.locator('.form-success')).toBeVisible()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])

  await page.reload()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])
})

test('encrypted import with the wrong password fails safely without corrupting inbox data', async ({
  page,
}, testInfo) => {
  await createAccount(page)
  const items = await createInboxFixture(page, 'wrong-password')
  const exportPath = await exportData(page, testInfo, 'encrypted')

  await importData(page, exportPath, 'encrypted', 'WrongPassword123!')
  await expect(page.locator('.form-error')).toBeVisible()
  await expect(page.locator('.phone-shell')).toBeVisible()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])

  await page.reload()
  await expectInboxItems(page, [items.note, items.linkTitle, items.todo])
})

test('delete account requires DELETE and returns to setup for a new first-run account', async ({
  page,
}) => {
  await createAccount(page)
  await openSettingsHome(page)
  await page.getByRole('button', { name: /Delete Account/ }).click()

  const deleteButton = page.getByRole('button', { name: 'Delete Account' })
  await expect(deleteButton).toBeDisabled()
  await page.locator('input[placeholder="DELETE"]').fill('delete')
  await expect(deleteButton).toBeDisabled()

  await page.locator('input[placeholder="DELETE"]').fill('DELETE')
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expectSetupScreen(page)

  const oldLoginResponse = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  expect(oldLoginResponse.status()).toBe(401)

  await createAccount(page, 'new-admin')
  await expectMainApp(page)
})

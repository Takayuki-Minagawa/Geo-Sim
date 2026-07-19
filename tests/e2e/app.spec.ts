import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'

const APP_HOST = '127.0.0.1'
const APP_PORT = '4173'

function tabButton(page: Page, label: string) {
  return page
    .getByRole('navigation', { name: '解析画面' })
    .getByRole('button')
    .filter({ hasText: label })
}

function isLocalOrInline(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  return (
    ['about:', 'blob:', 'data:'].includes(url.protocol) ||
    (url.hostname === APP_HOST && url.port === APP_PORT)
  )
}

test.describe('地盤解析Webアプリ MVP受入', () => {
  test('7画面を表示し、タブで相互に移動できる', async ({ page }) => {
    await page.goto('/')

    const navigation = page.getByRole('navigation', { name: '解析画面' })
    await expect(navigation.getByRole('button')).toHaveCount(7)

    const screens = [
      ['案件', '案件と計算条件'],
      ['地盤モデル', 'N値と地層モデル'],
      ['適用条件', '精算法の適用条件'],
      ['地盤増幅', '地盤増幅 Gs(T)'],
      ['液状化', '液状化結果'],
      ['時刻歴', '加速度時刻歴'],
      ['レポート', '計算概要と出力'],
    ] as const

    for (const [tabLabel, heading] of screens) {
      const button = tabButton(page, tabLabel)
      await button.click()
      await expect(button).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }
  })

  test('案件JSONを保存し、再読込して入力を復元できる', async ({ page }) => {
    await page.goto('/')

    const projectName = page.getByLabel('案件名')
    await projectName.fill('E2E JSON往復案件')

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '案件JSON保存', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('E2E JSON往復案件.jiban.json')

    const downloadedPath = await download.path()
    expect(downloadedPath).not.toBeNull()
    if (!downloadedPath) throw new Error('案件JSONの一時保存先を取得できませんでした')
    const jsonText = await fs.readFile(downloadedPath, 'utf8')
    const saved = JSON.parse(jsonText) as {
      schemaVersion: string
      appVersion: string
      project: { name: string }
    }
    expect(saved.schemaVersion).toBe('1.0.0')
    expect(saved.appVersion).toBe('0.1.0')
    expect(saved.project.name).toBe('E2E JSON往復案件')

    await projectName.fill('読込前の仮名称')
    await page.locator('header input[type="file"]').setInputFiles({
      name: 'saved.jiban.json',
      mimeType: 'application/json',
      buffer: Buffer.from(jsonText),
    })

    await expect(projectName).toHaveValue('E2E JSON往復案件')
    await expect(page.locator('.definition-list').getByText('jiban-json', { exact: true })).toBeVisible()
    await expect(page.locator('.message-error')).toHaveCount(0)
  })

  test('Web Workerで主要解析を実行し、結果CSVを外部通信なしで保存できる', async ({
    page,
  }) => {
    test.slow()
    const offOriginRequests = new Set<string>()
    page.on('request', (request) => {
      if (!isLocalOrInline(request.url())) offOriginRequests.add(request.url())
    })
    page.on('websocket', (socket) => {
      if (!isLocalOrInline(socket.url())) offOriginRequests.add(socket.url())
    })

    await page.goto('/')
    await page.getByRole('button', { name: '解析を実行', exact: true }).click()

    await expect(page.getByRole('heading', { name: '地盤増幅 Gs(T)', exact: true })).toBeVisible({
      timeout: 45_000,
    })
    await expect(
      page.locator('.metric').filter({ hasText: '収束' }).first().locator('strong'),
    ).toHaveText('収束')
    await expect(page.locator('.message-error')).toHaveCount(0)

    await tabButton(page, 'レポート').click()
    await expect(page.getByText('計算済み', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('definition').filter({ hasText: 'jp-mlit-kokuji-1457-current' }),
    ).toBeVisible()
    await expect(page.getByRole('definition').filter({ hasText: 'regulatory' })).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Gs明細CSV', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('新規案件-gs.csv')

    const downloadedPath = await download.path()
    expect(downloadedPath).not.toBeNull()
    if (!downloadedPath) throw new Error('Gs明細CSVの一時保存先を取得できませんでした')
    const csvText = await fs.readFile(downloadedPath, 'utf8')
    expect(csvText).toContain('\uFEFFperiod_s,gs,base_sa_m_s2,surface_sa_m_s2')
    expect(csvText.split(/\r?\n/).length).toBeGreaterThan(10)

    expect([...offOriginRequests]).toEqual([])
  })

  test('レポート画面からブラウザ印刷を呼び出す', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => {
      Object.defineProperty(window, 'print', {
        configurable: true,
        value: () => {
          document.documentElement.dataset.printCalled = 'true'
        },
      })
    })

    await tabButton(page, 'レポート').click()
    await page.getByRole('button', { name: '印刷 / PDF', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-print-called', 'true')
  })

  test('壊れた案件JSONを拒否し、入力中の案件を保持する', async ({ page }) => {
    await page.goto('/')
    const projectName = page.getByLabel('案件名')
    await projectName.fill('保持される案件名')

    await page.locator('header input[type="file"]').setInputFiles({
      name: 'broken.jiban.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"schemaVersion":"1.0.0",'),
    })

    const error = page.locator('.message-error')
    await expect(error).toBeVisible()
    await expect(error.getByText('FILE_IMPORT_FAILED', { exact: true })).toBeVisible()
    await expect(error).toContainText('JSONを解析できません')
    await expect(projectName).toHaveValue('保持される案件名')
  })
})

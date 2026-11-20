import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser } from 'playwright'
import { Pool } from 'pg'
import { createApp } from '../src/app.js'
import { configFrom } from '../src/config.js'
import { migrate } from '../src/db.js'
import { docx, sourceTexts, testTexts } from './fixture.js'

test('browser to Fastify, pgvector and BGE-M3', {
  skip: !process.env.DATASET_TEST_DATABASE_URL || process.env.DATASET_TEST_REAL_MODEL !== '1',
  timeout: 180000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dataset-browser-'))
  const config = configFrom({ ...process.env,
    DATABASE_URL: process.env.DATASET_TEST_DATABASE_URL, DOCUMENT_ROOT: directory })
  const pool = new Pool({ connectionString: config.DATABASE_URL })
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  let browser: Browser | undefined
  const name = '浏览器联调 ' + Date.now()
  let datasetId: string | undefined
  const documentIds: string[] = []
  t.after(async () => {
    await browser?.close()
    await app?.close()
    if (datasetId) {
      await pool.query('DELETE FROM cases WHERE dataset_id=$1', [datasetId])
      await pool.query('DELETE FROM datasets WHERE id=$1', [datasetId])
      await pool.query('DELETE FROM file_cleanup_jobs WHERE id=ANY($1::uuid[])', [documentIds])
    }
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  })
  await migrate(pool)
  app = await createApp(config, { logger: false, cleanup: false })
  let origin = await app.listen({ port: 0 })
  browser = await chromium.launch({ channel: process.env.DATASET_BROWSER_CHANNEL || undefined })
  let page = await browser.newPage({ acceptDownloads: true })
  page.setDefaultTimeout(30000)
  await page.goto(origin + '/datasets')
  await page.getByRole('button', { name: '新建数据集' }).click()
  const create = page.getByRole('dialog', { name: '新建数据集' })
  await create.getByLabel('数据集名称').fill(name)
  await create.getByRole('button', { name: '保存' }).click()
  await page.getByRole('link', { name, exact: true }).click()
  datasetId = new URL(page.url()).pathname.split('/')[2]
  const scope = '/api/v1/datasets/' + datasetId

  const files = [
    { label: '导入源需求／设计资料', name: '源侧.docx', buffer: docx(sourceTexts) },
    { label: '导入人工测试需求', name: '测试侧.docx', buffer: docx(testTexts) },
  ]
  for (const file of files) {
    const uploaded = page.waitForResponse(response => response.url() === origin + scope + '/documents'
      && response.request().method() === 'POST')
    await page.getByLabel(file.label, { exact: true }).setInputFiles({
      name: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file.buffer,
    })
    const response = await uploaded
    assert.equal(response.status(), 201, await response.text())
    documentIds.push((await response.json()).id)
    await page.getByText(file.name, { exact: true }).last().waitFor()
  }

  await page.getByRole('link', { name: '标注工作台' }).click()
  const sourcePane = page.locator('.slice-pane').first()
  const table = sourcePane.locator('.original-table')
  const selectTable = table.getByRole('checkbox', { name: '选中整表' })
  const selectRow = table.getByRole('checkbox', { name: '选择第 2 行' })
  const selectTestTable = page.locator('.slice-pane').nth(1).getByRole('checkbox', { name: '选中整表' })
  await selectTable.check()
  await selectTestTable.check()
  await selectRow.check()
  await page.locator('.selections summary').click()
  await page.locator('.selections .original-table').locator('.table-row-match').waitFor()
  await page.getByRole('button', { name: '预览配对' }).click()
  const pairPreview = page.getByRole('dialog', { name: '预览案例配对' })
  await pairPreview.locator('.original-table .table-row-match').waitFor()
  await pairPreview.locator('.split > section').nth(1).getByRole('table').waitFor()
  await pairPreview.getByRole('button', { name: '关闭' }).click()
  await page.locator('.selections .split > section').nth(1).getByRole('table').waitFor()
  await selectTestTable.uncheck()
  assert.equal(await selectTable.isChecked(), false)
  const searchText = sourcePane.getByRole('searchbox')
  await searchText.fill('CAN-01')
  await table.locator('.table-row-match').getByText('CAN-01', { exact: true }).waitFor()
  assert.equal(await selectRow.isChecked(), true)
  await selectRow.uncheck()
  await searchText.clear()
  for (const text of [...sourceTexts, ...testTexts]) {
    await page.locator('.slice-option').filter({ hasText: text }).getByRole('checkbox').check()
  }
  await selectTestTable.check()
  await selectRow.check()
  const title = '浏览器发布案例'
  await page.getByLabel('案例标题').fill(title)
  await page.getByLabel('测试对象').fill('控制器')
  await page.getByRole('button', { name: '功能', exact: true }).click()
  await page.getByRole('button', { name: '人工确认' }).click()
  const published = page.waitForResponse(response => response.url().endsWith('/publish'))
  await page.getByRole('button', { name: '确认并发布' }).click()
  const publishedResponse = await published
  assert.equal(publishedResponse.status(), 200, await publishedResponse.text())
  const record = await publishedResponse.json()
  assert.equal(record.sourceSliceIds.length, 3)
  await selectRow.waitFor()
  assert.equal(await selectRow.isChecked(), true)

  const search = async (text: string) => {
    await page.getByLabel('查询内容').fill(text)
    const responsePromise = page.waitForResponse(response => response.url() === origin + '/api/v1/search')
    await page.getByRole('button', { name: '发送' }).click()
    const response = await responsePromise
    assert.equal(response.status(), 200, await response.text())
    const direct = await page.request.post(origin + '/api/v1/search', { data: { query: text } })
    assert.deepEqual(await direct.json(), await response.json())
  }
  await page.getByRole('link', { name: '案例检索' }).click()
  for (const text of sourceTexts) {
    await search(text)
    const card = page.locator('.turn').last().locator('.result-card').filter({ hasText: title })
    await card.waitFor()
    for (const expected of testTexts) await card.getByText(expected, { exact: true }).waitFor()
    await card.getByText('测试侧.docx', { exact: false }).first().waitFor()
  }
  await search('CAN-01')
  const tableResult = page.locator('.turn').last().locator('.result-card').filter({ hasText: title })
  await tableResult.locator('.split > section').first().locator('.table-row-match').waitFor()
  await tableResult.locator('.split > section').nth(1).getByRole('table').waitFor()
  await page.locator('.turn').last().getByRole('button', { name: '查看案例详情' }).click()
  const searchDetail = page.getByRole('dialog', { name: title })
  await searchDetail.locator('.split > section').nth(1).getByRole('table').waitFor()
  await searchDetail.locator('.table-row-match').waitFor()
  assert.equal(new URL(page.url()).pathname, '/search')
  await searchDetail.getByRole('button', { name: '关闭' }).click()
  await page.locator('.turn').last().getByRole('button', { name: '查看案例详情' }).waitFor()

  await page.context().close()
  await app.close()
  app = await createApp(config, { logger: false, cleanup: false })
  origin = await app.listen({ port: 0 })
  page = await browser.newPage({ acceptDownloads: true })
  page.setDefaultTimeout(30000)
  await page.goto(origin + '/datasets/' + datasetId + '/cases')
  await page.getByText(title, { exact: true }).waitFor()
  await page.getByRole('link', { name: '详情', exact: true }).click()
  const listDetail = page.getByRole('dialog', { name: title })
  await listDetail.locator('.split > section').nth(1).getByRole('table').waitFor()
  await listDetail.getByRole('button', { name: '关闭' }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: /导出/ }).click()
  const download = await downloadEvent
  const exportPath = await download.path()
  assert.equal(JSON.parse((await readFile(exportPath, 'utf8')).trim()).caseId, record.id)
  for (const id of documentIds) assert.ok((await readFile(join(directory, id, 'original.docx'))).length)

  await page.getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认停用', exact: true }).click()
  await page.getByRole('cell', { name: '已停用', exact: true }).waitFor()
  await page.getByRole('link', { name: '案例检索' }).click()
  await search(sourceTexts[0])
  await page.locator('.turn').last().getByText('没有匹配的案例').waitFor()
  await page.goto(origin + '/datasets')
  await page.getByRole('button', { name: '删除 ' + name }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).waitFor({ state: 'hidden' })
  assert.equal((await page.request.get(origin + scope)).status(), 404)
})

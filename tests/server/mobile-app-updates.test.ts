import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-app updates for the Android test build. The phone holds no GitHub token:
// it asks this server, and the server reads the owner's private release with a
// token configured once, server side. These tests pin the contract the Android
// client is built against and prove the token never reaches a response body.

const GITHUB_TOKEN = 'ghp_TESTONLY_never_in_a_response_body'

let db: any = null
const responseBodies: string[] = []

function fakeCtx(query: Record<string, string> = {}, options: {
  headers?: Record<string, string>
  body?: unknown
} = {}) {
  const set: Record<string, string> = {}
  return {
    query,
    status: 200,
    body: undefined as unknown,
    headers: set,
    request: { body: options.body },
    set(name: string, value: string) { set[name.toLowerCase()] = value },
    get(name: string) { return options.headers?.[name.toLowerCase()] || '' },
    state: {},
  }
}

/** Every response body in this suite is recorded and scanned for the token. */
function recordBody(ctx: { body: unknown }): unknown {
  if (ctx.body !== undefined && typeof ctx.body !== 'object') {
    responseBodies.push(String(ctx.body))
  } else if (ctx.body && !(ctx.body instanceof Readable)) {
    responseBodies.push(JSON.stringify(ctx.body))
  }
  return ctx.body
}

async function loadController() {
  return await import('../../packages/server/src/modules/studio/controllers/app-updates')
}

async function initStores(): Promise<void> {
  const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
  initAllStores()
}

async function configureSource(overrides: Record<string, unknown> = {}): Promise<void> {
  const ctrl = await loadController()
  const ctx = fakeCtx({}, { body: { githubToken: GITHUB_TOKEN, ...overrides } })
  await ctrl.saveSettings(ctx as any)
  recordBody(ctx)
  expect(ctx.status).toBe(200)
}

function githubAsset(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    name,
    size: 25 * 1024 * 1024,
    created_at: '2026-09-18T10:00:00Z',
    updated_at: '2026-09-18T10:00:00Z',
    ...extra,
  }
}

function releaseResponse(assets: unknown[], body = 'Test build notes') {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ body, published_at: '2026-09-18T09:00:00Z', assets }),
  }
}

function assetResponse(bytes: Buffer, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers(),
    body: new Response(bytes).body,
  }
}

describe('mobile in-app updates', () => {
  beforeEach(async () => {
    vi.resetModules()
    responseBodies.length = 0
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    await initStores()
  })

  afterEach(() => {
    // Nothing in this suite may ever echo the configured GitHub token.
    for (const body of responseBodies) {
      expect(body).not.toContain(GITHUB_TOKEN)
    }
    db?.close()
    db = null
    vi.unstubAllGlobals()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('answers the check with not_configured and the download with 409 before the owner configures a source', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = await loadController()

    const check = fakeCtx({ platform: 'android', channel: 'test' })
    await ctrl.checkMobile(check as any)
    recordBody(check)
    expect(check.status).toBe(200)
    expect(check.body).toMatchObject({ available: false, reason: 'not_configured', downloadPath: null })

    const download = fakeCtx({ platform: 'android', channel: 'test' })
    await ctrl.downloadMobile(download as any)
    recordBody(download)
    expect(download.status).toBe(409)
    expect(download.body).toMatchObject({ code: 'updates_not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the parsed version, build number, size and a server download path once configured', async () => {
    const fetchMock = vi.fn(async () => releaseResponse([
      githubAsset('Core.Hub.Mobile-1.4.0-test.37-android.apk', { id: 900, size: 26_214_400 }),
    ], 'Build 37'))
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = await loadController()
    await configureSource()

    const ctx = fakeCtx({ platform: 'android', channel: 'test' })
    await ctrl.checkMobile(ctx as any)
    recordBody(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      available: true,
      version: '1.4.0-test.37',
      buildNumber: 37,
      notes: 'Build 37',
      sizeBytes: 26_214_400,
      publishedAt: '2026-09-18T10:00:00Z',
      downloadPath: '/api/studio/app-updates/mobile/download?platform=android&channel=test',
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/twuijri/core-hub-test-builds/releases/tags/latest-test-mobile')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${GITHUB_TOKEN}`)
    // The client is never handed a GitHub URL.
    expect(JSON.stringify(ctx.body)).not.toContain('github')
  })

  it('picks the newest matching asset when the rolling release holds several', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => releaseResponse([
      nonApkAsset(),
      githubAsset('Core.Hub.Mobile-1.4.0-test.9-android.apk', { id: 1 }),
      githubAsset('Core.Hub.Mobile-1.4.0-test.37-android.apk', { id: 2 }),
      githubAsset('Core.Hub.Mobile-1.3.9-test.99-android.apk', { id: 3 }),
    ])))
    const ctrl = await loadController()
    await configureSource()

    const ctx = fakeCtx({ platform: 'android' })
    await ctrl.checkMobile(ctx as any)
    recordBody(ctx)

    expect(ctx.body).toMatchObject({ available: true, version: '1.4.0-test.37', buildNumber: 37 })
  })

  it('serves a byte range as 206 and forwards the range to GitHub so a dropped download resumes', async () => {
    const payload = Buffer.from('0123456789abcdefghij')
    const fetchMock = vi.fn(async (url: string) => (
      url.includes('/releases/tags/')
        ? releaseResponse([githubAsset('Core.Hub.Mobile-2.0.0-test.4-android.apk', { id: 55, size: payload.length })])
        : assetResponse(payload.subarray(5, 10), 206)
    ))
    vi.stubGlobal('fetch', fetchMock)
    const ctrl = await loadController()
    await configureSource()

    const ctx = fakeCtx({ platform: 'android' }, { headers: { range: 'bytes=5-9' } })
    await ctrl.downloadMobile(ctx as any)

    expect(ctx.status).toBe(206)
    expect(ctx.headers['content-type']).toBe('application/vnd.android.package-archive')
    expect(ctx.headers['content-range']).toBe(`bytes 5-9/${payload.length}`)
    expect(ctx.headers['content-length']).toBe('5')
    expect(ctx.headers['accept-ranges']).toBe('bytes')

    const chunks: Buffer[] = []
    for await (const chunk of ctx.body as Readable) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('56789')

    const assetCall = fetchMock.mock.calls.find(call => String(call[0]).includes('/releases/assets/'))
    expect(assetCall?.[0]).toBe('https://api.github.com/repos/twuijri/core-hub-test-builds/releases/assets/55')
    expect(((assetCall?.[1] as RequestInit).headers as Record<string, string>).Range).toBe('bytes=5-9')

    // An unsatisfiable range is answered 416, never 500.
    const bad = fakeCtx({ platform: 'android' }, { headers: { range: 'bytes=999-1000' } })
    await ctrl.downloadMobile(bad as any)
    recordBody(bad)
    expect(bad.status).toBe(416)
    expect(bad.headers['content-range']).toBe(`bytes */${payload.length}`)
  })

  it('reports a rejected GitHub token with a code the client can show, not a 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
    })))
    const ctrl = await loadController()
    await configureSource()

    const check = fakeCtx({ platform: 'android' })
    await ctrl.checkMobile(check as any)
    recordBody(check)
    expect(check.status).toBe(502)
    expect(check.body).toMatchObject({ code: 'github_auth_failed' })

    const download = fakeCtx({ platform: 'android' })
    await ctrl.downloadMobile(download as any)
    recordBody(download)
    expect(download.status).toBe(502)
    expect(download.body).toMatchObject({ code: 'github_auth_failed' })
  })

  it('reports a GitHub rate limit separately with a retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0', 'retry-after': '60' }),
      json: async () => ({}),
    })))
    const ctrl = await loadController()
    await configureSource()

    const ctx = fakeCtx({ platform: 'android' })
    await ctrl.checkMobile(ctx as any)
    recordBody(ctx)
    expect(ctx.status).toBe(503)
    expect(ctx.body).toMatchObject({ code: 'github_rate_limited', retryAfterSeconds: 60 })
  })

  it('tells iOS honestly that no in-app install is possible', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const ctrl = await loadController()
    await configureSource()

    const check = fakeCtx({ platform: 'ios' })
    await ctrl.checkMobile(check as any)
    recordBody(check)
    expect(check.status).toBe(200)
    expect(check.body).toMatchObject({ available: false, reason: 'ios_not_supported' })
    expect(String((check.body as any).message)).toMatch(/TestFlight/)

    const download = fakeCtx({ platform: 'ios' })
    await ctrl.downloadMobile(download as any)
    recordBody(download)
    expect(download.status).toBe(409)
    expect(download.body).toMatchObject({ code: 'ios_not_supported' })
  })

  it('masks the stored token on read and keeps it when the masked marker is written back', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const ctrl = await loadController()
    await configureSource({ repository: 'twuijri/core-hub-test-builds', releaseTag: 'latest-test-mobile' })

    const read = fakeCtx({})
    await ctrl.getSettings(read as any)
    recordBody(read)
    expect((read.body as any).settings).toMatchObject({
      channel: 'test',
      configured: true,
      settings: { repository: 'twuijri/core-hub-test-builds', releaseTag: 'latest-test-mobile' },
      secrets: { githubToken: '[stored]' },
    })

    // Saving the masked marker back must not wipe the real token.
    const resave = fakeCtx({}, { body: { releaseTag: 'latest-test-mobile', githubToken: '[stored]' } })
    await ctrl.saveSettings(resave as any)
    recordBody(resave)
    expect((resave.body as any).settings.configured).toBe(true)

    const cleared = fakeCtx({})
    await ctrl.deleteToken(cleared as any)
    recordBody(cleared)
    expect((cleared.body as any).settings.configured).toBe(false)
    expect((cleared.body as any).settings.secrets).toEqual({})

    const after = fakeCtx({ platform: 'android' })
    await ctrl.checkMobile(after as any)
    recordBody(after)
    expect(after.body).toMatchObject({ available: false, reason: 'not_configured' })
  })

  it('rejects a malformed repository instead of storing it', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const ctrl = await loadController()

    const ctx = fakeCtx({}, { body: { repository: 'not a repo', githubToken: GITHUB_TOKEN } })
    await ctrl.saveSettings(ctx as any)
    recordBody(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({ code: 'invalid_update_settings' })
  })
})

/** A non-APK release asset that must be ignored by asset selection. */
function nonApkAsset() {
  return githubAsset('Core.Hub.Desktop-1.4.0-test.40.dmg', { id: 99 })
}

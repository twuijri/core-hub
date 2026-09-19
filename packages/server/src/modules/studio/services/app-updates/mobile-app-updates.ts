import { Readable } from 'stream'
import {
  clearAppUpdateToken,
  getAppUpdateSettings,
  normalizeAppUpdateChannel,
  saveAppUpdateSettings,
  type StoredAppUpdateSettings,
} from '../../repositories/app-update-settings-store'
import { logger } from '../../public/logging'

export {
  AppUpdateSettingsValidationError,
  DEFAULT_APP_UPDATE_CHANNEL,
  DEFAULT_APP_UPDATE_RELEASE_TAG,
  DEFAULT_APP_UPDATE_REPOSITORY,
  normalizeAppUpdateChannel,
} from '../../repositories/app-update-settings-store'
export type { StoredAppUpdateSettings } from '../../repositories/app-update-settings-store'

/**
 * Mobile in-app updates.
 *
 * The phone must not hold a GitHub token. It asks this server, and the server
 * reads the owner's private release with the token configured once, server
 * side. Only server paths are handed back to the client; the GitHub asset URL
 * and the token never leave this module.
 */

export const MOBILE_UPDATE_PLATFORMS = ['android', 'ios'] as const
export type MobileUpdatePlatform = (typeof MOBILE_UPDATE_PLATFORMS)[number]

export const ANDROID_APK_CONTENT_TYPE = 'application/vnd.android.package-archive'
const ANDROID_ASSET_PATTERN = /^Core\.Hub\.Mobile-(.+)-android\.apk$/i
const GITHUB_API_ROOT = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'core-hub-app-updates'
const METADATA_TIMEOUT_MS = 15_000

export interface MobileUpdateCheckResult {
  available: boolean
  reason?: string
  message?: string
  version: string | null
  buildNumber: number | null
  notes: string
  sizeBytes: number | null
  publishedAt: string | null
  downloadPath: string | null
}

export interface AndroidUpdateAsset {
  assetId: number
  fileName: string
  version: string
  buildNumber: number | null
  sizeBytes: number
  publishedAt: string | null
  notes: string
}

/** Carries a stable code the client can map to a message of its own. */
export class MobileUpdateError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | null

  constructor(code: string, message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'MobileUpdateError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isMobileUpdatePlatform(value: unknown): value is MobileUpdatePlatform {
  return typeof value === 'string' && (MOBILE_UPDATE_PLATFORMS as readonly string[]).includes(value)
}

export function normalizeMobileUpdatePlatform(value: unknown): MobileUpdatePlatform {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!platform) return 'android'
  if (!isMobileUpdatePlatform(platform)) {
    throw new MobileUpdateError('unsupported_platform', `Unsupported platform: ${platform}`, 400)
  }
  return platform
}

export function mobileDownloadPath(platform: MobileUpdatePlatform, channel: string): string {
  const params = new URLSearchParams({ platform, channel })
  return `/api/studio/app-updates/mobile/download?${params.toString()}`
}

/**
 * `Core.Hub.Mobile-1.4.0-test.37-android.apk` → version `1.4.0-test.37`,
 * build number 37. A plain `1.4.0` has no build number; report null rather
 * than inventing one from the patch digit.
 */
export function parseAndroidAssetName(fileName: string): { version: string; buildNumber: number | null } | null {
  const match = ANDROID_ASSET_PATTERN.exec(fileName.trim())
  if (!match) return null
  const version = match[1].trim()
  if (!version) return null
  const build = /-[A-Za-z][A-Za-z0-9]*\.(\d+)$/.exec(version)
  return { version, buildNumber: build ? Number(build[1]) : null }
}

function versionCoreParts(version: string): number[] {
  const core = version.split('-')[0]
  return core.split('.').map(part => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
}

function compareVersionCores(left: string, right: string): number {
  const leftParts = versionCoreParts(left)
  const rightParts = versionCoreParts(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

interface GithubAsset {
  id: number
  name: string
  size: number
  created_at?: string
  updated_at?: string
}

interface GithubRelease {
  body?: string
  published_at?: string
  assets?: GithubAsset[]
}

function assetTimestamp(asset: GithubAsset): number {
  const raw = asset.updated_at || asset.created_at || ''
  const value = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(value) ? value : 0
}

/**
 * A rolling release tag can end up holding more than one APK (an old build
 * that failed to be replaced, or two runs racing). Pick the newest by version,
 * then build number, then upload time — never "the only asset".
 */
export function selectNewestAndroidAsset(assets: GithubAsset[]): {
  asset: GithubAsset
  version: string
  buildNumber: number | null
} | null {
  const candidates = assets
    .map(asset => {
      const parsed = parseAndroidAssetName(asset.name)
      return parsed ? { asset, ...parsed } : null
    })
    .filter((entry): entry is { asset: GithubAsset; version: string; buildNumber: number | null } => entry !== null)

  if (!candidates.length) return null

  candidates.sort((left, right) => {
    const byVersion = compareVersionCores(left.version, right.version)
    if (byVersion !== 0) return byVersion
    const byBuild = (right.buildNumber ?? -1) - (left.buildNumber ?? -1)
    if (byBuild !== 0) return byBuild
    return assetTimestamp(right.asset) - assetTimestamp(left.asset)
  })

  return candidates[0]
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  }
}

function rateLimitRetrySeconds(response: { headers: Headers }): number | null {
  const retryAfter = Number(response.headers.get('retry-after') || '')
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter)
  const reset = Number(response.headers.get('x-ratelimit-reset') || '')
  if (!Number.isFinite(reset) || reset <= 0) return null
  return Math.max(1, Math.ceil(reset - Date.now() / 1000))
}

function isRateLimited(response: { status: number; headers: Headers }): boolean {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  return response.headers.get('x-ratelimit-remaining') === '0'
    || Boolean(response.headers.get('retry-after'))
}

/** Maps a GitHub failure to a stable code. The token is never logged. */
function githubFailure(
  response: { status: number; headers: Headers },
  context: { repository: string; releaseTag: string },
): MobileUpdateError {
  if (isRateLimited(response)) {
    const retryAfterSeconds = rateLimitRetrySeconds(response)
    return new MobileUpdateError(
      'github_rate_limited',
      'GitHub rate limit reached while reading the update release',
      503,
      retryAfterSeconds,
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new MobileUpdateError(
      'github_auth_failed',
      'The configured GitHub token was rejected for this repository',
      502,
    )
  }
  if (response.status === 404) {
    return new MobileUpdateError(
      'github_release_not_found',
      `Release ${context.releaseTag} was not found in ${context.repository}`,
      502,
    )
  }
  return new MobileUpdateError(
    'github_unavailable',
    `GitHub returned HTTP ${response.status} while reading the update release`,
    502,
  )
}

function requireConfigured(channel: string): StoredAppUpdateSettings {
  const stored = getAppUpdateSettings(channel, { includeSecrets: true })
  if (!stored.configured || !stored.secrets.githubToken) {
    throw new MobileUpdateError(
      'updates_not_configured',
      'In-app updates are not configured on this server yet',
      409,
    )
  }
  return stored
}

async function readRelease(stored: StoredAppUpdateSettings): Promise<GithubRelease> {
  const { repository, releaseTag } = stored.settings
  const url = `${GITHUB_API_ROOT}/repos/${repository}/releases/tags/${encodeURIComponent(releaseTag)}`

  let response: Response
  try {
    response = await fetch(url, {
      headers: githubHeaders(stored.secrets.githubToken as string, 'application/vnd.github+json'),
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    })
  } catch (error) {
    logger.warn({
      repository,
      releaseTag,
      err: error instanceof Error ? error.message : String(error),
    }, '[app-updates] release lookup failed')
    throw new MobileUpdateError('github_unavailable', 'Could not reach GitHub to check for updates', 502)
  }

  if (!response.ok) {
    const failure = githubFailure(response, { repository, releaseTag })
    logger.warn({ repository, releaseTag, status: response.status, code: failure.code }, '[app-updates] release lookup rejected')
    throw failure
  }

  return await response.json() as GithubRelease
}

export async function resolveAndroidUpdateAsset(channel: string): Promise<AndroidUpdateAsset | null> {
  const stored = requireConfigured(channel)
  const release = await readRelease(stored)
  const selected = selectNewestAndroidAsset(Array.isArray(release.assets) ? release.assets : [])
  if (!selected) return null

  return {
    assetId: selected.asset.id,
    fileName: selected.asset.name,
    version: selected.version,
    buildNumber: selected.buildNumber,
    sizeBytes: Number(selected.asset.size || 0),
    publishedAt: selected.asset.updated_at || selected.asset.created_at || release.published_at || null,
    notes: typeof release.body === 'string' ? release.body : '',
  }
}

/**
 * Answers the phone's update check. Nothing here throws for the two states the
 * owner can legitimately be in — no source configured, or no build published
 * yet — and iOS is answered honestly instead of pretending.
 */
export async function checkMobileUpdate(input: {
  platform: MobileUpdatePlatform
  channel: string
}): Promise<MobileUpdateCheckResult> {
  const empty: MobileUpdateCheckResult = {
    available: false,
    version: null,
    buildNumber: null,
    notes: '',
    sizeBytes: null,
    publishedAt: null,
    downloadPath: null,
  }

  if (input.platform === 'ios') {
    return {
      ...empty,
      reason: 'ios_not_supported',
      message: 'iOS cannot install builds from inside the app; use TestFlight for the iOS test build.',
    }
  }

  const stored = getAppUpdateSettings(input.channel, { includeSecrets: true })
  if (!stored.configured || !stored.secrets.githubToken) {
    return { ...empty, reason: 'not_configured' }
  }

  const asset = await resolveAndroidUpdateAsset(input.channel)
  if (!asset) {
    return { ...empty, reason: 'no_build_published' }
  }

  return {
    available: true,
    version: asset.version,
    buildNumber: asset.buildNumber,
    notes: asset.notes,
    sizeBytes: asset.sizeBytes,
    publishedAt: asset.publishedAt,
    downloadPath: mobileDownloadPath('android', normalizeAppUpdateChannel(input.channel)),
  }
}

/**
 * Opens the asset bytes as a stream. The range is forwarded to GitHub so a
 * dropped download resumes instead of restarting, and the 25 MB APK is never
 * buffered in server memory.
 */
export async function openAndroidUpdateAssetStream(input: {
  channel: string
  assetId: number
  range: { start: number; end: number } | null
}): Promise<{ body: Readable; upstreamStatus: number }> {
  const stored = requireConfigured(input.channel)
  const { repository, releaseTag } = stored.settings
  const url = `${GITHUB_API_ROOT}/repos/${repository}/releases/assets/${input.assetId}`
  const headers = githubHeaders(stored.secrets.githubToken as string, 'application/octet-stream')
  if (input.range) headers.Range = `bytes=${input.range.start}-${input.range.end}`

  let response: Response
  try {
    response = await fetch(url, { headers, redirect: 'follow' })
  } catch (error) {
    logger.warn({
      repository,
      releaseTag,
      assetId: input.assetId,
      err: error instanceof Error ? error.message : String(error),
    }, '[app-updates] asset download failed')
    throw new MobileUpdateError('github_unavailable', 'Could not reach GitHub to download the update', 502)
  }

  if (!response.ok || !response.body) {
    const failure = githubFailure(response, { repository, releaseTag })
    logger.warn({
      repository,
      releaseTag,
      assetId: input.assetId,
      status: response.status,
      code: failure.code,
    }, '[app-updates] asset download rejected')
    throw failure
  }

  return {
    body: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    upstreamStatus: response.status,
  }
}

export function readMobileUpdateSettings(channel: string): StoredAppUpdateSettings {
  return getAppUpdateSettings(channel)
}

export function writeMobileUpdateSettings(
  channel: string,
  input: { repository?: unknown; releaseTag?: unknown; githubToken?: unknown },
): StoredAppUpdateSettings {
  return saveAppUpdateSettings(channel, input)
}

export function removeMobileUpdateToken(channel: string): StoredAppUpdateSettings {
  return clearAppUpdateToken(channel)
}

import { getDb } from '../infrastructure/database'
import { APP_UPDATE_SETTINGS_TABLE } from '../infrastructure/database/schemas'

/**
 * Owner-configured source for mobile in-app updates. The phone never holds a
 * GitHub token: it asks this server, and the server reads the private release
 * with the token stored here. Secrets follow the STT/TTS convention — the
 * stored value is returned to clients only as the `[stored]` marker.
 */

export const DEFAULT_APP_UPDATE_CHANNEL = 'test'
export const DEFAULT_APP_UPDATE_REPOSITORY = 'twuijri/core-hub-test-builds'
export const DEFAULT_APP_UPDATE_RELEASE_TAG = 'latest-test-mobile'

export const APP_UPDATE_SECRET_STORED_MARKER = '[stored]'

const MAX_TEXT_SETTING_LENGTH = 200
const MAX_TOKEN_LENGTH = 500
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9][A-Za-z0-9-_.]*$/
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-+/]*$/

export class AppUpdateSettingsValidationError extends Error {}

export interface AppUpdateSettings {
  repository: string
  releaseTag: string
}

export interface AppUpdateSecrets {
  githubToken?: string
}

export interface StoredAppUpdateSettings {
  channel: string
  configured: boolean
  settings: AppUpdateSettings
  secrets: AppUpdateSecrets
  createdAt: number
  updatedAt: number
}

type StoredRow = {
  channel: string
  settings_json: string
  secrets_json: string
  created_at: number
  updated_at: number
}

function requireDb() {
  const db = getDb()
  if (!db) throw new Error('App update settings storage unavailable')
  return db
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function normalizeAppUpdateChannel(channel: unknown): string {
  const value = typeof channel === 'string' ? channel.trim() : ''
  if (!value) return DEFAULT_APP_UPDATE_CHANNEL
  if (!CHANNEL_PATTERN.test(value)) {
    throw new AppUpdateSettingsValidationError('invalid update channel')
  }
  return value
}

function normalizeRepository(value: string): string {
  const repository = value.trim().replace(/\.git$/i, '')
  if (!REPOSITORY_PATTERN.test(repository) || repository.length > MAX_TEXT_SETTING_LENGTH) {
    throw new AppUpdateSettingsValidationError('repository must look like owner/name')
  }
  return repository
}

function normalizeReleaseTag(value: string): string {
  const tag = value.trim()
  if (!RELEASE_TAG_PATTERN.test(tag) || tag.length > MAX_TEXT_SETTING_LENGTH) {
    throw new AppUpdateSettingsValidationError('invalid release tag')
  }
  return tag
}

function readStoredSettings(raw: Record<string, unknown>): AppUpdateSettings {
  const repository = typeof raw.repository === 'string' && raw.repository.trim()
    ? raw.repository.trim()
    : DEFAULT_APP_UPDATE_REPOSITORY
  const releaseTag = typeof raw.releaseTag === 'string' && raw.releaseTag.trim()
    ? raw.releaseTag.trim()
    : DEFAULT_APP_UPDATE_RELEASE_TAG
  return { repository, releaseTag }
}

function readStoredToken(raw: Record<string, unknown>): string {
  return typeof raw.githubToken === 'string' ? raw.githubToken.trim() : ''
}

function readRow(channel: string): StoredRow | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT channel, settings_json, secrets_json, created_at, updated_at
     FROM ${APP_UPDATE_SETTINGS_TABLE} WHERE channel = ?`
  ).get(channel) as StoredRow | null
}

/**
 * Reads the stored configuration. Without `includeSecrets` the token is
 * replaced by the `[stored]` marker so a settings response can never echo it.
 */
export function getAppUpdateSettings(
  channel: string,
  options?: { includeSecrets?: boolean },
): StoredAppUpdateSettings {
  const channelName = normalizeAppUpdateChannel(channel)
  const row = readRow(channelName)
  const settings = readStoredSettings(row ? parseJsonObject(row.settings_json) : {})
  const token = row ? readStoredToken(parseJsonObject(row.secrets_json)) : ''
  const secrets: AppUpdateSecrets = {}
  if (token) {
    secrets.githubToken = options?.includeSecrets === true ? token : APP_UPDATE_SECRET_STORED_MARKER
  }

  return {
    channel: channelName,
    // A source counts as configured only once the token exists: the release is
    // private, so repository and tag alone cannot be read.
    configured: Boolean(token),
    settings,
    secrets,
    createdAt: Number(row?.created_at || 0),
    updatedAt: Number(row?.updated_at || 0),
  }
}

export function saveAppUpdateSettings(
  channel: string,
  input: { repository?: unknown; releaseTag?: unknown; githubToken?: unknown },
): StoredAppUpdateSettings {
  const channelName = normalizeAppUpdateChannel(channel)
  const db = requireDb()
  const existing = readRow(channelName)
  const current = readStoredSettings(existing ? parseJsonObject(existing.settings_json) : {})
  const currentToken = existing ? readStoredToken(parseJsonObject(existing.secrets_json)) : ''

  const next: AppUpdateSettings = { ...current }
  if (input.repository !== undefined) {
    if (typeof input.repository !== 'string') {
      throw new AppUpdateSettingsValidationError('repository must be a string')
    }
    next.repository = input.repository.trim()
      ? normalizeRepository(input.repository)
      : DEFAULT_APP_UPDATE_REPOSITORY
  }
  if (input.releaseTag !== undefined) {
    if (typeof input.releaseTag !== 'string') {
      throw new AppUpdateSettingsValidationError('releaseTag must be a string')
    }
    next.releaseTag = input.releaseTag.trim()
      ? normalizeReleaseTag(input.releaseTag)
      : DEFAULT_APP_UPDATE_RELEASE_TAG
  }

  // An omitted, empty, or still-masked token means "keep what is stored".
  let nextToken = currentToken
  if (typeof input.githubToken === 'string') {
    const candidate = input.githubToken.trim()
    if (candidate && candidate !== APP_UPDATE_SECRET_STORED_MARKER) {
      if (candidate.length > MAX_TOKEN_LENGTH || /\s/.test(candidate)) {
        throw new AppUpdateSettingsValidationError('invalid GitHub token')
      }
      nextToken = candidate
    }
  } else if (input.githubToken !== undefined) {
    throw new AppUpdateSettingsValidationError('githubToken must be a string')
  }

  const now = Date.now()
  db.prepare(
    `INSERT INTO ${APP_UPDATE_SETTINGS_TABLE} (channel, settings_json, secrets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET
       settings_json = excluded.settings_json,
       secrets_json = excluded.secrets_json,
       updated_at = excluded.updated_at`
  ).run(
    channelName,
    JSON.stringify(next),
    JSON.stringify(nextToken ? { githubToken: nextToken } : {}),
    Number(existing?.created_at || now),
    now,
  )

  return getAppUpdateSettings(channelName)
}

export function clearAppUpdateToken(channel: string): StoredAppUpdateSettings {
  const channelName = normalizeAppUpdateChannel(channel)
  const db = requireDb()
  const existing = readRow(channelName)
  if (existing) {
    db.prepare(
      `UPDATE ${APP_UPDATE_SETTINGS_TABLE} SET secrets_json = '{}', updated_at = ? WHERE channel = ?`
    ).run(Date.now(), channelName)
  }
  return getAppUpdateSettings(channelName)
}

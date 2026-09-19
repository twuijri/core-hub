import type { Context } from 'koa'
import {
  ANDROID_APK_CONTENT_TYPE,
  AppUpdateSettingsValidationError,
  MobileUpdateError,
  checkMobileUpdate,
  normalizeAppUpdateChannel,
  normalizeMobileUpdatePlatform,
  openAndroidUpdateAssetStream,
  readMobileUpdateSettings,
  removeMobileUpdateToken,
  resolveAndroidUpdateAsset,
  writeMobileUpdateSettings,
} from '../services/app-updates/mobile-app-updates'
import { parseByteRange } from '../services/files/http-range'

/**
 * Mobile in-app updates. Both endpoints run behind the normal authentication
 * middleware, so the device-bound App token the phone carries is what
 * authorizes them; no separate token is involved and the GitHub token stays on
 * the server.
 */

function requestedChannel(ctx: Context): string {
  return normalizeAppUpdateChannel(typeof ctx.query.channel === 'string' ? ctx.query.channel : '')
}

function failRequest(ctx: Context, error: unknown): void {
  if (error instanceof MobileUpdateError) {
    ctx.status = error.status
    const body: Record<string, unknown> = { error: error.message, code: error.code }
    if (error.retryAfterSeconds !== null) {
      body.retryAfterSeconds = error.retryAfterSeconds
      ctx.set('Retry-After', String(error.retryAfterSeconds))
    }
    ctx.body = body
    return
  }
  if (error instanceof AppUpdateSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message, code: 'invalid_update_settings' }
    return
  }
  throw error
}

export async function checkMobile(ctx: Context) {
  try {
    ctx.body = await checkMobileUpdate({
      platform: normalizeMobileUpdatePlatform(ctx.query.platform),
      channel: requestedChannel(ctx),
    })
  } catch (error) {
    failRequest(ctx, error)
  }
}

export async function downloadMobile(ctx: Context) {
  try {
    const platform = normalizeMobileUpdatePlatform(ctx.query.platform)
    if (platform === 'ios') {
      throw new MobileUpdateError(
        'ios_not_supported',
        'iOS builds cannot be installed from inside the app; use TestFlight.',
        409,
      )
    }

    const channel = requestedChannel(ctx)
    const asset = await resolveAndroidUpdateAsset(channel)
    if (!asset) {
      throw new MobileUpdateError('no_build_published', 'No Android build is published on this channel yet', 404)
    }

    ctx.set('Content-Type', ANDROID_APK_CONTENT_TYPE)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(asset.fileName)}"; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`)
    ctx.set('Accept-Ranges', 'bytes')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('X-Core-Hub-App-Version', asset.version)
    if (asset.buildNumber !== null) ctx.set('X-Core-Hub-App-Build', String(asset.buildNumber))

    // Same byte-range rule as the file download controller, so a dropped
    // install can resume from where it stopped.
    const range = parseByteRange(ctx.get('range'), asset.sizeBytes)
    if (range === 'invalid') {
      ctx.status = 416
      ctx.set('Content-Range', `bytes */${asset.sizeBytes}`)
      ctx.body = ''
      return
    }

    const { body } = await openAndroidUpdateAssetStream({ channel, assetId: asset.assetId, range })
    if (range) {
      ctx.status = 206
      ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.sizeBytes}`)
      ctx.set('Content-Length', String(range.end - range.start + 1))
    } else {
      ctx.status = 200
      ctx.set('Content-Length', String(asset.sizeBytes))
    }
    ctx.body = body
  } catch (error) {
    failRequest(ctx, error)
  }
}

export async function getSettings(ctx: Context) {
  try {
    ctx.body = { settings: readMobileUpdateSettings(requestedChannel(ctx)) }
  } catch (error) {
    failRequest(ctx, error)
  }
}

export async function saveSettings(ctx: Context) {
  const body = ctx.request.body as {
    repository?: unknown
    releaseTag?: unknown
    githubToken?: unknown
  } | undefined

  try {
    ctx.body = {
      settings: writeMobileUpdateSettings(requestedChannel(ctx), {
        repository: body?.repository,
        releaseTag: body?.releaseTag,
        githubToken: body?.githubToken,
      }),
    }
  } catch (error) {
    failRequest(ctx, error)
  }
}

export async function deleteToken(ctx: Context) {
  try {
    ctx.body = { success: true, settings: removeMobileUpdateToken(requestedChannel(ctx)) }
  } catch (error) {
    failRequest(ctx, error)
  }
}

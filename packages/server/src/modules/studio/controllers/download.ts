import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename, extname, isAbsolute } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  validatePath,
  resolveProfileFilePath,
} from '../services/files/file-provider'
import { getActiveProfileName } from '../public/profile-config'
import { createAppImagePreview } from '../services/files/app-image-preview'
import { parseByteRange } from '../services/files/http-range'
import { getLanPeerSocketManager } from '../services/network/lan-peer-socket'
import { isDeviceAllowedForProfile } from '../services/devices/device-bindings'

// MIME type mapping for common extensions
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.log': 'text/plain',
}

function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function isStreamableMedia(mime: string): boolean {
  return mime.startsWith('video/') || mime.startsWith('audio/')
}

/**
 * Local files are streamed straight from disk with HTTP range support instead
 * of being buffered: media players need 206 responses to seek and to start
 * playing before the whole file has arrived, and the in-memory buffer has a
 * size cap that silently froze large exports (e.g. a rendered video) at 0:00.
 */
async function streamLocalFile(ctx: any, filePath: string, name: string, mime: string): Promise<void> {
  const info = await stat(filePath)
  if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not_found' })
  const disposition = isStreamableMedia(mime) ? 'inline' : 'attachment'
  ctx.set('Content-Type', mime)
  ctx.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  ctx.set('Accept-Ranges', 'bytes')
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('X-Content-Type-Options', 'nosniff')
  const range = parseByteRange(ctx.get('range'), info.size)
  if (range === 'invalid') {
    ctx.status = 416
    ctx.set('Content-Range', `bytes */${info.size}`)
    ctx.body = ''
    return
  }
  if (range) {
    ctx.status = 206
    ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    ctx.set('Content-Length', String(range.end - range.start + 1))
    ctx.body = createReadStream(filePath, { start: range.start, end: range.end })
    return
  }
  ctx.status = 200
  ctx.set('Content-Length', String(info.size))
  ctx.body = createReadStream(filePath)
}

/**
 * Files on linked devices. A chat link of the form device://<device id>/<abs
 * path> (or ?device=<id>) is streamed from that device through its Device
 * Agent, which enforces the device's shared folders. When no device is named
 * and the path does not exist on the server, the controllable devices bound to
 * the profile are asked in turn — device apps (e.g. a video editor) report
 * plain device paths, and the work they produce stays on the device.
 */
async function streamDeviceFile(ctx: any, deviceId: string, filePath: string, name: string, mime: string, profile: string): Promise<boolean> {
  if (!isDeviceAllowedForProfile(deviceId, profile)) return false
  const connection = getLanPeerSocketManager().findControllableConnection(deviceId)
  if (!connection) return false
  const wantedRange = parseRangeHeader(ctx.get('range'))
  if (wantedRange === 'invalid') {
    ctx.status = 416
    ctx.body = ''
    return true
  }
  const { started, stream } = connection.downloadFileStream(filePath, wantedRange ? { offset: wantedRange.start, length: wantedRange.end === null ? undefined : wantedRange.end - wantedRange.start + 1 } : {})
  let info
  try {
    info = await started
  } catch {
    stream.destroy()
    return false
  }
  const disposition = isStreamableMedia(mime) ? 'inline' : 'attachment'
  ctx.set('Content-Type', mime)
  ctx.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  ctx.set('Accept-Ranges', 'bytes')
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('X-Content-Type-Options', 'nosniff')
  ctx.set('X-Core-Hub-Source', `device:${deviceId}`)
  if (wantedRange) {
    if (info.length <= 0 || info.offset >= info.size) {
      ctx.status = 416
      ctx.set('Content-Range', `bytes */${info.size}`)
      ctx.body = ''
      stream.destroy()
      return true
    }
    ctx.status = 206
    ctx.set('Content-Range', `bytes ${info.offset}-${info.offset + info.length - 1}/${info.size}`)
    ctx.set('Content-Length', String(info.length))
  } else {
    ctx.status = 200
    ctx.set('Content-Length', String(info.size))
  }
  ctx.body = stream
  return true
}

/** Parses a Range header into start/end without knowing the size yet (end null = open). */
function parseRangeHeader(header: string | undefined): { start: number; end: number | null } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const start = Number(match[1])
  const end = match[2] === '' ? null : Number(match[2])
  if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end < start))) return 'invalid'
  return { start, end }
}

export function parseDeviceFileTarget(value: string): { deviceId: string; path: string } | null {
  const match = /^device:\/\/([A-Za-z0-9_.-]+)(\/.*)$/.exec(value)
  return match ? { deviceId: match[1], path: match[2] } : null
}

export async function download(ctx: any) {
  let filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined
  const variant = ctx.query.variant as string | undefined
  let deviceId = typeof ctx.query.device === 'string' && ctx.query.device.trim() ? ctx.query.device.trim() : ''
  const deviceTarget = filePath ? parseDeviceFileTarget(filePath) : null
  if (deviceTarget) {
    deviceId = deviceTarget.deviceId
    filePath = deviceTarget.path
  }

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    if (deviceId) {
      // Explicit device file: the device validates the path against its shared folders.
      const name = fileName || basename(filePath.replace(/\\/g, '/'))
      if (!(await streamDeviceFile(ctx, deviceId, filePath, name, getMimeType(name), profile))) {
        ctx.status = 404
        ctx.body = { error: 'Device file is not available (device offline, not allowed for this profile, or outside its shared folders)', code: 'device_file_unavailable' }
      }
      return
    }
    // Validate the path first
    // Support both absolute and relative paths
    const validPath = isAbsolute(filePath) ? validatePath(filePath) : resolveProfileFilePath(filePath, profile)

    // Determine filename and MIME type
    const name = fileName || basename(validPath)
    let mime = getMimeType(name)

    // Choose provider: always use local for upload directory files
    const provider = isInUploadDir(validPath) ? localProvider : await createFileProvider(profile)
    if (provider.type === 'local' && variant !== 'app-image') {
      try {
        await streamLocalFile(ctx, validPath, name, mime)
        return
      } catch (err: any) {
        if (err?.code !== 'ENOENT' || !isAbsolute(filePath)) throw err
      }
      // Not on the server: a device app may have produced it on a linked device.
      for (const candidate of getLanPeerSocketManager().listConnections()) {
        if (!candidate.controllable || !candidate.device_id) continue
        if (await streamDeviceFile(ctx, candidate.device_id, filePath, name, mime, profile)) return
      }
      throw Object.assign(new Error('File not found'), { code: 'ENOENT' })
    }
    const data: Buffer = await provider.readFile(validPath)
    let responseData = data
    if (variant === 'app-image') {
      const preview = await createAppImagePreview(data, mime)
      responseData = preview.data
      mime = preview.mime
      ctx.set('X-Hermes-Image-Variant', preview.optimized ? 'compressed' : 'original')
      ctx.set('X-Hermes-Original-Bytes', String(preview.originalBytes))
    }

    // Set response headers
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(responseData.length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.body = responseData
  } catch (err: any) {
    const code = err.code || 'unknown'
    const statusMap: Record<string, number> = {
      missing_path: 400,
      invalid_path: 400,
      not_found: 404,
      ENOENT: 404,
      file_too_large: 413,
      unsupported_backend: 501,
      backend_error: 502,
      backend_timeout: 504,
    }
    ctx.status = statusMap[code] || 500
    ctx.body = { error: err.message, code }
  }
}

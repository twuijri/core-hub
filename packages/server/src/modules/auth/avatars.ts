// Avatar files for users and workspaces: `<DATA_DIR>/avatars/<kind>/<id>`, PNG or JPEG, at
// most 512 KB decoded. The row keeps only the MIME type (schema.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HubError } from '../../lib/errors.js';

export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MIMES = ['image/png', 'image/jpeg'] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];
export type AvatarOwnerKind = 'users' | 'workspaces';

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/;

export interface DecodedAvatar {
  mime: AvatarMime;
  bytes: Buffer;
}

export function decodeAvatarDataUrl(dataUrl: string): DecodedAvatar {
  const match = DATA_URL.exec(dataUrl);
  if (!match) throw new HubError('validation_failed', { messageKey: 'auth.avatar_invalid' });
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
    throw new HubError('validation_failed', {
      messageKey: 'auth.avatar_invalid',
      details: { max_bytes: AVATAR_MAX_BYTES },
    });
  }
  return { mime: match[1] as AvatarMime, bytes };
}

function avatarPath(dataDir: string, kind: AvatarOwnerKind, id: string): string {
  return path.join(dataDir, 'avatars', kind, id);
}

export function writeAvatar(
  dataDir: string,
  kind: AvatarOwnerKind,
  id: string,
  avatar: DecodedAvatar,
): void {
  const file = avatarPath(dataDir, kind, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, avatar.bytes);
}

export function readAvatar(dataDir: string, kind: AvatarOwnerKind, id: string): Buffer | null {
  const file = avatarPath(dataDir, kind, id);
  return existsSync(file) ? readFileSync(file) : null;
}

export function deleteAvatar(dataDir: string, kind: AvatarOwnerKind, id: string): void {
  rmSync(avatarPath(dataDir, kind, id), { force: true });
}

/**
 * Agent pictures: `<DATA_DIR>/avatars/agents/<agent id>`, PNG or JPEG, at most 512 KB — the
 * same files, limits and data-URL input `auth` uses for people and profiles
 * (`docs/domain/auth.md`). The registry row keeps nothing: whether an agent has a picture is
 * whether its file is there, and the type is read from the file's first bytes, so no column
 * and no migration are needed. An agent row is the hub's, not a profile's, so is its picture.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DecodedAvatar } from '../auth/index.js';

export type AgentAvatarMime = 'image/png' | 'image/jpeg';

/** The type from the file's signature; null for anything that is neither PNG nor JPEG. */
export function sniffAvatarMime(bytes: Buffer): AgentAvatarMime | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export class AgentAvatars {
  constructor(private readonly dir: string) {}

  private file(agentId: string): string {
    return path.join(this.dir, agentId);
  }

  has(agentId: string): boolean {
    return existsSync(this.file(agentId));
  }

  read(agentId: string): { mime: AgentAvatarMime; bytes: Buffer } | null {
    const file = this.file(agentId);
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    const mime = sniffAvatarMime(bytes);
    return mime ? { mime, bytes } : null;
  }

  write(agentId: string, avatar: DecodedAvatar): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(agentId), avatar.bytes);
  }

  remove(agentId: string): void {
    rmSync(this.file(agentId), { force: true });
  }
}

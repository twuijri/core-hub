/**
 * Hermes's profile archives, scripted, for tests and the e2e hub (ADR 0014 stage 2): an
 * export writes the archive Hermes would — one folder named after the profile — with
 * whatever files the test puts in it (a credential file included, to see the hub remove
 * it), and an import records what it was handed and refuses a name it already holds, in
 * the words Hermes uses. The real thing is `agents/hermes-profiles.ts` over `hermes serve`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ProfileArchiveRefusal, type ProfileArchiveRuntime } from '../profile-transfer.js';
import { tarGz, type TarEntry } from './tar.js';

export interface FakeProfileRuntime {
  runtime: ProfileArchiveRuntime;
  /** Every import, in order: the name and the archive's bytes. */
  imported: Array<{ name: string; bytes: Buffer }>;
  /** Profile names Hermes already has (an import of one of them is refused). */
  names: Set<string>;
}

export function fakeProfileRuntime(
  files: (profile: string) => Array<Omit<TarEntry, 'path'> & { path: string }> = () => [
    { path: 'SOUL.md', content: 'A profile made by the fake Hermes.\n' },
  ],
): FakeProfileRuntime {
  const imported: FakeProfileRuntime['imported'] = [];
  const names = new Set<string>();
  return {
    imported,
    names,
    runtime: {
      async export(profile, target) {
        const entries: TarEntry[] = [
          { path: profile },
          ...files(profile).map((entry) => ({ ...entry, path: `${profile}/${entry.path}` })),
        ];
        writeFileSync(target, tarGz(entries));
        return target;
      },
      async import(archive, name) {
        if (!existsSync(archive)) throw new ProfileArchiveRefusal(`Archive not found: ${archive}`);
        if (names.has(name)) {
          throw new ProfileArchiveRefusal(`Profile '${name}' already exists`);
        }
        names.add(name);
        imported.push({ name, bytes: readFileSync(archive) });
      },
    },
  };
}

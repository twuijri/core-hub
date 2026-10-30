/**
 * Which graphics card this computer has, to pick the Ollama libraries worth downloading
 * (ADR 0032 §3). Only NVIDIA changes what is downloaded: Ollama ships its CUDA libraries in two
 * large folders (`cuda_v12`, `cuda_v13`), and the driver's version says which one runs here.
 * Every other card — AMD, Intel, Apple — uses what every install carries (Vulkan on Windows and
 * Linux, Metal and MLX on a Mac), so detecting it only names it for the person.
 */
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand, whichSync, type HostEnvironment } from '../../agents/adapters/host.js';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'none';

export interface GpuReading {
  vendor: GpuVendor;
  /** What the system calls the card, when it says; for the person, not for decisions. */
  name: string | null;
  /** NVIDIA's driver version (`580.88`), the one input that picks a CUDA folder. */
  driver: string | null;
  /** The CUDA folder Ollama needs here, or null when no CUDA library is needed. */
  cuda: 'cuda_v12' | 'cuda_v13' | null;
}

/** CUDA 13 needs the r580 driver or newer; older drivers run the CUDA 12 build. */
export function cudaFolderFor(driver: string | null): 'cuda_v12' | 'cuda_v13' | null {
  const major = Number(/^(\d+)/.exec(driver ?? '')?.[1] ?? NaN);
  if (!Number.isFinite(major)) return null;
  return major >= 580 ? 'cuda_v13' : 'cuda_v12';
}

const PCI_VENDORS: Record<string, GpuVendor> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x8086': 'intel',
};

export interface GpuProbeOptions {
  host: HostEnvironment;
  platform?: NodeJS.Platform;
  arch?: string;
  /** For tests: where Linux lists its display devices. */
  drmRoot?: string;
}

async function nvidia(host: HostEnvironment): Promise<GpuReading | null> {
  const smi = whichSync('nvidia-smi', host);
  if (!smi) return null;
  const result = await runCommand(
    [smi, '--query-gpu=name,driver_version', '--format=csv,noheader'],
    { timeoutMs: 10_000 },
  );
  if (!result.ok) return null;
  const line = result.stdout.split('\n').find((row) => row.trim() !== '');
  if (!line) return null;
  const [name, driver] = line.split(',').map((part) => part.trim());
  return {
    vendor: 'nvidia',
    name: name || null,
    driver: driver || null,
    cuda: cudaFolderFor(driver ?? null),
  };
}

async function linuxVendor(drmRoot: string): Promise<GpuVendor> {
  let cards: string[];
  try {
    cards = (await readdir(drmRoot)).filter((name) => /^card\d+$/.test(name));
  } catch {
    return 'none';
  }
  const found = new Set<GpuVendor>();
  for (const card of cards) {
    try {
      const id = (await readFile(path.join(drmRoot, card, 'device', 'vendor'), 'utf8')).trim();
      const vendor = PCI_VENDORS[id.toLowerCase()];
      if (vendor) found.add(vendor);
    } catch {
      // A card without a readable vendor says nothing.
    }
  }
  // A discrete card wins over the integrated one beside it.
  for (const vendor of ['nvidia', 'amd', 'intel'] as const) if (found.has(vendor)) return vendor;
  return 'none';
}

async function windowsCard(
  host: HostEnvironment,
): Promise<{ vendor: GpuVendor; name: string | null }> {
  const shell = whichSync('powershell', host);
  if (!shell) return { vendor: 'none', name: null };
  const result = await runCommand(
    [
      shell,
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }',
    ],
    { timeoutMs: 15_000 },
  );
  if (!result.ok) return { vendor: 'none', name: null };
  const names = result.stdout
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  for (const [pattern, vendor] of [
    [/nvidia/i, 'nvidia'],
    [/amd|radeon/i, 'amd'],
    [/intel/i, 'intel'],
  ] as const) {
    const name = names.find((row) => pattern.test(row));
    if (name) return { vendor, name };
  }
  return { vendor: 'none', name: names[0] ?? null };
}

export async function detectGpu(options: GpuProbeOptions): Promise<GpuReading> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? os.arch();
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { vendor: 'apple', name: 'Apple silicon', driver: null, cuda: null }
      : { vendor: 'none', name: null, driver: null, cuda: null };
  }
  const fromSmi = await nvidia(options.host);
  if (fromSmi) return fromSmi;
  if (platform === 'win32') {
    const card = await windowsCard(options.host);
    // An NVIDIA card whose driver tools are missing gets no CUDA: there is no driver to run it.
    return { vendor: card.vendor, name: card.name, driver: null, cuda: null };
  }
  const vendor = await linuxVendor(options.drmRoot ?? '/sys/class/drm');
  return { vendor, name: null, driver: null, cuda: null };
}

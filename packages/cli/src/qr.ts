// QR rendering for the terminal with a pure-JS encoder (qrcode-generator, MIT). Two modules
// per character row using half blocks; light modules are drawn, dark ones are left blank, so
// the code reads on the usual dark terminal and `invert` serves a light one.
import qrcode from 'qrcode-generator';

export type QrLevel = 'L' | 'M' | 'Q' | 'H';

/** The module matrix (`true` = dark), version chosen automatically. */
export function qrModules(text: string, level: QrLevel = 'M'): boolean[][] {
  const qr = qrcode(0, level);
  // The encoder maps each char to one byte; hand it the UTF-8 bytes so non-Latin text survives.
  qr.addData(Buffer.from(text, 'utf8').toString('latin1'), 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

export interface RenderOptions {
  /** Quiet zone in modules on every side (the standard asks for 4; 2 is fine on screens). */
  quiet?: number;
  /** Draw dark modules instead of light ones (for light terminals). */
  invert?: boolean;
}

export function renderModules(modules: boolean[][], options: RenderOptions = {}): string {
  const quiet = options.quiet ?? 2;
  const size = modules.length;
  const width = size + quiet * 2;
  const height = size + quiet * 2;
  const dark = (r: number, c: number): boolean => {
    const row = r - quiet;
    const col = c - quiet;
    if (row < 0 || col < 0 || row >= size || col >= size) return false;
    return modules[row]?.[col] ?? false;
  };
  const lit = (r: number, c: number): boolean => {
    if (r >= height) return false;
    return options.invert ? dark(r, c) : !dark(r, c);
  };
  const lines: string[] = [];
  for (let r = 0; r < height; r += 2) {
    let line = '';
    for (let c = 0; c < width; c += 1) {
      const top = lit(r, c);
      const bottom = lit(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function renderQr(text: string, options: RenderOptions & { level?: QrLevel } = {}): string {
  return renderModules(qrModules(text, options.level ?? 'M'), options);
}

/**
 * A physical arrangement of lights as a grid (an "LED matrix" made of bulbs).
 *
 * `cells[row][col]` holds the device id at that spot (or null). Row 0 is the
 * top row as the user sees it, col 0 the left column. Sequence numbers aren't
 * stored: they're derived from `numbering`, so changing the wiring order
 * (start corner, zigzag, reverse) renumbers everything instantly.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface Numbering {
  start: Corner;
  /** 'rows': 1..cols along the first row, then the next row. 'columns': down the first column first. */
  direction: 'rows' | 'columns';
  /** Zigzag: every other row/column runs back the other way (how LED strips are usually wired). */
  serpentine: boolean;
  /** Count from the end: the last cell becomes 1. */
  reverse: boolean;
}

export interface MatrixLayout {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: (string | null)[][];
  numbering: Numbering;
  /** Timing measured for this installation (see calibration.ts). */
  calibration?: Calibration;
}

export interface Calibration {
  /** Typical delay from sending a command to the bulb visibly changing (ms). */
  lightLatencyMs?: number;
  /** How lightLatencyMs was obtained. */
  lightSource?: 'estimate' | 'tap';
  lightMeasuredAt?: string;
  /** Raw tap-test results, kept for reference. */
  tap?: { audioTapMs: number; lightTapMs: number; outputLatencyMs: number; taps: number };
  /** Network round trip per bulb (ms); null = didn't answer. */
  bulbs?: Record<string, { rttMs: number | null }>;
  networkMeasuredAt?: string;
}

export const DEFAULT_NUMBERING: Numbering = { start: 'top-left', direction: 'rows', serpentine: false, reverse: false };

export function createLayout(rows: number, cols: number, name = 'Auditorium', id = 'auditorium'): MatrixLayout {
  return {
    id,
    name,
    rows,
    cols,
    cells: Array.from({ length: rows }, () => Array<string | null>(cols).fill(null)),
    numbering: { ...DEFAULT_NUMBERING },
  };
}

/** Grid positions in sequence order: element 0 is cell #1. */
export function sequence(layout: Pick<MatrixLayout, 'rows' | 'cols' | 'numbering'>): Array<[number, number]> {
  const { rows, cols, numbering: n } = layout;
  const fromBottom = n.start.startsWith('bottom');
  const fromRight = n.start.endsWith('right');
  const out: Array<[number, number]> = [];
  const outer = n.direction === 'rows' ? rows : cols;
  const inner = n.direction === 'rows' ? cols : rows;
  for (let i = 0; i < outer; i++) {
    for (let j = 0; j < inner; j++) {
      // Zigzag flips the inner direction on every other line.
      const jj = n.serpentine && i % 2 === 1 ? inner - 1 - j : j;
      let r: number, c: number;
      if (n.direction === 'rows') {
        r = fromBottom ? rows - 1 - i : i;
        c = fromRight ? cols - 1 - jj : jj;
      } else {
        c = fromRight ? cols - 1 - i : i;
        r = fromBottom ? rows - 1 - jj : jj;
      }
      out.push([r, c]);
    }
  }
  return n.reverse ? out.reverse() : out;
}

/** numbers[row][col] = 1-based sequence number. */
export function numberGrid(layout: MatrixLayout): number[][] {
  const grid = Array.from({ length: layout.rows }, () => Array<number>(layout.cols).fill(0));
  sequence(layout).forEach(([r, c], i) => (grid[r][c] = i + 1));
  return grid;
}

/** Resize, keeping assignments that still fit. */
export function resize(layout: MatrixLayout, rows: number, cols: number): MatrixLayout {
  const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => layout.cells[r]?.[c] ?? null));
  return { ...layout, rows, cols, cells };
}

/** Put a device at (row, col). A device lives in one cell only; any previous spot is cleared. */
export function assign(layout: MatrixLayout, row: number, col: number, deviceId: string | null): MatrixLayout {
  const cells = layout.cells.map((r) => r.map((id) => (deviceId && id === deviceId ? null : id)));
  cells[row][col] = deviceId;
  return { ...layout, cells };
}

export function assignedIds(layout: MatrixLayout): Set<string> {
  return new Set(layout.cells.flat().filter((x): x is string => !!x));
}

export function validateLayout(input: any): MatrixLayout {
  const rows = Number(input?.rows), cols = Number(input?.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 32 || cols > 32) {
    throw new Error('Rows and columns must be whole numbers between 1 and 32');
  }
  const corners: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const n = input.numbering ?? {};
  const numbering: Numbering = {
    start: corners.includes(n.start) ? n.start : DEFAULT_NUMBERING.start,
    direction: n.direction === 'columns' ? 'columns' : 'rows',
    serpentine: !!n.serpentine,
    reverse: !!n.reverse,
  };
  const base = resize({ id: String(input.id ?? 'auditorium'), name: String(input.name ?? 'Auditorium'), rows: 0, cols: 0, cells: input.cells ?? [], numbering }, rows, cols);
  if (input.calibration && typeof input.calibration === 'object') base.calibration = input.calibration;
  // Drop duplicates (a bulb can only be in one place); first occurrence wins.
  const seen = new Set<string>();
  base.cells = base.cells.map((r) => r.map((id) => (typeof id === 'string' && id && !seen.has(id) ? (seen.add(id), id) : null)));
  return base;
}

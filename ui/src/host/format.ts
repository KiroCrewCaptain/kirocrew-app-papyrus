/**
 * Number, unit and date formatting in the dashboard's active language.
 *
 * `fmtDateTime` and `compareText` are the host SDK's own. `fmtUnit` and
 * `fmtBytes` are not exported by the SDK, so they are restated here over its
 * `fmtNumber`, exactly as the dashboard builds them: narrow units, decimal byte
 * multiples, and every plain space promoted to a no-break space so a quantity
 * never wraps between its number and its unit.
 */
import { fmtNumber, type NumberOptions } from '@kirocrew/app-sdk'

export { compareText, fmtDateTime } from '@kirocrew/app-sdk'

export type FormatUnit =
  | 'byte' | 'kilobyte' | 'megabyte' | 'gigabyte' | 'terabyte'
  | 'millisecond' | 'second'

export function fmtUnit(value: number, unit: FormatUnit, options?: NumberOptions): string {
  if (!Number.isFinite(value)) return '—'
  return fmtNumber(value, { style: 'unit', unit, unitDisplay: 'narrow', ...options }).replace(/ /g, '\u00A0')
}

function roundToDigits(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function fmtBytes(bytes: number, options?: NumberOptions): string {
  if (!Number.isFinite(bytes)) return '—'
  const digits = options?.maximumFractionDigits
  const b = roundToDigits(bytes, digits ?? 0)
  if (Math.abs(b) < 1000) return fmtUnit(b, 'byte', { maximumFractionDigits: 0, ...options })
  const kb = roundToDigits(bytes / 1000, digits ?? 1)
  if (Math.abs(kb) < 1000) return fmtUnit(kb, 'kilobyte', { maximumFractionDigits: 1, ...options })
  const mb = roundToDigits(bytes / 1000 ** 2, digits ?? 1)
  if (Math.abs(mb) < 1000) return fmtUnit(mb, 'megabyte', { maximumFractionDigits: 1, ...options })
  const gb = roundToDigits(bytes / 1000 ** 3, digits ?? 1)
  if (Math.abs(gb) < 1000) return fmtUnit(gb, 'gigabyte', { maximumFractionDigits: 1, ...options })
  return fmtUnit(bytes / 1000 ** 4, 'terabyte', { maximumFractionDigits: 1, ...options })
}

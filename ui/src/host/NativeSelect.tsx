import type { SelectProps } from '@kirocrew/app-sdk/ui'

/**
 * The fallback for `Select` on a host that does not export one: a plain native
 * `<select>` with the same props, so the call sites do not branch.
 */
export default function NativeSelect({
  options,
  optionLabels,
  value,
  onChange,
  clearLabel,
  disabled,
  'aria-label': ariaLabel,
  title,
  className,
}: SelectProps) {
  // A value no option carries would otherwise show the first option while the
  // state still holds ''. The empty row keeps what is shown equal to what is held.
  const emptyRow = clearLabel !== undefined || !options.includes(value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={
        'text-sm px-2 py-1 rounded-md bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text)]' +
        (className ? ` ${className}` : '')
      }
    >
      {emptyRow && <option value="">{clearLabel ?? ''}</option>}
      {options.map((option, index) => (
        <option key={option} value={option}>
          {optionLabels?.[index] ?? option}
        </option>
      ))}
    </select>
  )
}

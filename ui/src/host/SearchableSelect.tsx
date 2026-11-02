/**
 * The main-document picker. The built-in used the dashboard's private
 * `SearchableSelect` (a filterable list); an installed app has the host's
 * `Select` from `@kirocrew/app-sdk/ui` (App Kit level 1), or a native
 * `<select>` on an older host. Same props as the built-in's call site.
 */
import { Select } from '../hostSdk'

export interface SearchableOption {
  value: string
  label: string
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  options: SearchableOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <Select
      className="w-full"
      options={options.map(o => o.value)}
      optionLabels={options.map(o => o.label)}
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
    />
  )
}

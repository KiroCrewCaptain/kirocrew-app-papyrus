/**
 * Promise-based one-line prompt for one component: `textPrompt(opts)` resolves
 * the entered text when the user presses the confirm button (or Enter), and
 * `null` for Cancel, Escape, the close button, a backdrop click, a second ask
 * and an unmount. Render `textPromptDialog` once.
 *
 * It stands in for `window.prompt`, which on Windows leaves the window ignoring
 * the keyboard until it is re-activated. The host's own prompt component is
 * private, so this builds the same contract over `Modal`, `Btn` and `Input`
 * from `@kirocrew/app-sdk/ui`.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useImeGuard } from '@kirocrew/app-sdk'
import { Btn, Input, Modal } from '@kirocrew/app-sdk/ui'
import { i18nT } from '../i18n'

export interface TextPromptOptions {
  title: string
  body: string
  confirmLabel: string
  /** Accept an empty entry. Off by default: the confirm button waits for text. */
  allowEmpty?: boolean
}

interface PendingPrompt {
  opts: TextPromptOptions
  resolve: (value: string | null) => void
}

/** The field and its buttons. Its state lives here so a keystroke repaints this
 *  dialog, not the page that owns the hook. */
function PromptForm({ opts, inputRef, onSettle }: {
  opts: TextPromptOptions
  inputRef: RefObject<HTMLInputElement>
  onSettle: (result: string | null) => void
}) {
  const [value, setValue] = useState('')
  const ime = useImeGuard()
  const canSubmit = opts.allowEmpty === true || value.trim() !== ''
  const submit = () => { if (canSubmit) onSettle(value) }
  return (
    <Modal
      open
      wrapTitle
      onClose={() => onSettle(null)}
      title={opts.title}
      maxWidth={440}
      footer={
        <>
          <Btn onClick={() => onSettle(null)}>{i18nT('components.confirmDialog.cancel')}</Btn>
          <Btn primary disabled={!canSubmit} onClick={submit}>{opts.confirmLabel}</Btn>
        </>
      }
    >
      <label className="block text-sm text-text">
        <span className="block mb-2 break-words">{opts.body}</span>
        <Input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          {...ime.bindEnter({ onEnter: submit })}
        />
      </label>
    </Modal>
  )
}

export function useTextPrompt(): {
  textPrompt: (opts: TextPromptOptions) => Promise<string | null>
  cancel: () => void
  textPromptDialog: ReactNode
} {
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const pendingRef = useRef<PendingPrompt | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const textPrompt = useCallback((opts: TextPromptOptions) => {
    return new Promise<string | null>(resolve => {
      pendingRef.current?.resolve(null)
      const next = { opts, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  const settle = useCallback((result: string | null) => {
    pendingRef.current?.resolve(result)
    pendingRef.current = null
    setPending(null)
  }, [])

  useEffect(() => () => {
    pendingRef.current?.resolve(null)
    pendingRef.current = null
  }, [])

  // The modal's focus trap moves focus to its close button when it mounts and
  // would override an `autoFocus`; this effect belongs to the parent, so it
  // runs after the trap's.
  useEffect(() => {
    if (pending) inputRef.current?.focus()
  }, [pending])

  const cancel = useCallback(() => settle(null), [settle])
  const textPromptDialog = pending
    ? <PromptForm key={pending.opts.title} opts={pending.opts} inputRef={inputRef} onSettle={settle} />
    : null

  return { textPrompt, cancel, textPromptDialog }
}

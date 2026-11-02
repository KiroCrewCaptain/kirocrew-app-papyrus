/**
 * PapyrusEditor — the LaTeX source pane.
 *
 * The built-in mounted the dashboard's private Pierre editor. An installed app
 * cannot import it, and the App SDK exposes no code editor, so this is a plain
 * `<textarea>` with a line-number gutter: no syntax colouring, everything else
 * the page relies on kept. The component owns no document state: the page holds
 * the buffer and passes it down, and edits come back through `onChange`. It
 * exposes `jumpToLine` (a click on a compiler error moves the caret there) and
 * `focus`. A diagnostic marks its line in the gutter, coloured by severity, with
 * the message as the tooltip. Cmd/Ctrl+S calls `onSave`; Tab inserts two spaces
 * instead of leaving the field.
 *
 * Lines do not wrap, so a gutter number always sits beside its own line.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from 'react'
import type { Diagnostic } from './api'

export interface PapyrusEditorHandle {
  /** Move the cursor to `line`, scroll it into view, and focus the editor. */
  jumpToLine: (line: number) => void
  /** Focus without moving the cursor. */
  focus: () => void
}

export interface PapyrusEditorProps {
  /** The file being edited, as a project-relative path. */
  path: string
  value: string
  onChange: (value: string) => void
  /** Invoked on Cmd/Ctrl+S. The page saves and compiles. */
  onSave: () => void
  diagnostics: Diagnostic[]
  onCursorChange?: (line: number, column: number) => void
  /**
   * Refuse edits while the file's content is still in flight: `path` changes the
   * moment the user picks a file, but `value` only catches up when the fetch
   * lands, so between the two the editor would show the PREVIOUS file's text
   * under the NEW path.
   */
  readOnly?: boolean
}

const LINE_HEIGHT_PX = 20
const INDENT = '  '

type Severity = 'error' | 'warning' | 'info'

function severityOf(d: Diagnostic): Severity {
  return d.level === 'error' ? 'error' : d.level === 'warning' ? 'warning' : 'info'
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

const MARK_CLASS: Record<Severity, string> = {
  error: 'bg-danger/20 text-danger-text',
  warning: 'bg-warn/20 text-warn',
  info: 'bg-accent/15 text-accent',
}

/** Caret offset -> 1-based (line, column). */
function caretPosition(text: string, offset: number): [number, number] {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1
      lineStart = i + 1
    }
  }
  return [line, offset - lineStart + 1]
}

/** 1-based line -> caret offset of its first character (clamped to the text). */
function lineOffset(text: string, line: number): number {
  let remaining = Math.max(1, Math.floor(line)) - 1
  let i = 0
  while (remaining > 0) {
    const next = text.indexOf('\n', i)
    if (next < 0) return text.length
    i = next + 1
    remaining -= 1
  }
  return i
}

const PapyrusEditor = forwardRef<PapyrusEditorHandle, PapyrusEditorProps>(function PapyrusEditor(
  { path, value, onChange, onSave, diagnostics, onCursorChange, readOnly = false },
  ref,
) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)

  useImperativeHandle(ref, () => ({
    jumpToLine: (line: number) => {
      const area = areaRef.current
      if (!area) return
      const offset = lineOffset(area.value, line)
      area.focus()
      area.setSelectionRange(offset, offset)
      area.scrollTop = Math.max(0, (Math.max(1, line) - 4) * LINE_HEIGHT_PX)
      onCursorChange?.(...caretPosition(area.value, offset))
    },
    focus: () => areaRef.current?.focus(),
  }), [onCursorChange])

  // The worst diagnostic on each line, and the messages to show for it. A
  // diagnostic with no line cannot be placed — it is listed in the diagnostics
  // pane but marks no line, rather than pointing at innocent source.
  const marks = useMemo(() => {
    const byLine = new Map<number, { severity: Severity; messages: string[] }>()
    for (const d of diagnostics) {
      if (d.line === null || d.line < 1) continue
      const severity = severityOf(d)
      const entry = byLine.get(d.line)
      if (!entry) byLine.set(d.line, { severity, messages: [d.message] })
      else {
        entry.messages.push(d.message)
        if (RANK[severity] > RANK[entry.severity]) entry.severity = severity
      }
    }
    return byLine
  }, [diagnostics])

  const lineCount = useMemo(() => {
    let n = 1
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n += 1
    return n
  }, [value])

  const reportCursor = useCallback(() => {
    const area = areaRef.current
    if (area && onCursorChange) onCursorChange(...caretPosition(area.value, area.selectionStart))
  }, [onCursorChange])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave()
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (readOnly) return
      event.preventDefault()
      const area = event.currentTarget
      const { selectionStart, selectionEnd } = area
      const next = area.value.slice(0, selectionStart) + INDENT + area.value.slice(selectionEnd)
      onChange(next)
      const caret = selectionStart + INDENT.length
      requestAnimationFrame(() => areaRef.current?.setSelectionRange(caret, caret))
    }
  }, [onSave, onChange, readOnly])

  const syncGutter = useCallback(() => {
    if (gutterRef.current && areaRef.current) gutterRef.current.scrollTop = areaRef.current.scrollTop
  }, [])

  const gutter = useMemo(() => {
    const rows = []
    for (let line = 1; line <= lineCount; line++) {
      const mark = marks.get(line)
      rows.push(
        <div
          key={line}
          className={`pr-2 pl-1 text-right tabular-nums ${mark ? MARK_CLASS[mark.severity] : ''}`}
          title={mark ? mark.messages.join('\n') : undefined}
          data-marker={mark ? mark.severity : undefined}
        >
          {line}
        </div>,
      )
    }
    return rows
  }, [lineCount, marks])

  return (
    <div className="h-full w-full min-h-0 flex overflow-hidden bg-bg font-mono text-[13px]" data-testid="papyrus-editor">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="shrink-0 overflow-hidden select-none text-muted border-r border-border py-2"
        style={{ lineHeight: `${LINE_HEIGHT_PX}px`, minWidth: '3.25rem' }}
      >
        {gutter}
      </div>
      <textarea
        ref={areaRef}
        key={path}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        aria-label={path}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={reportCursor}
        onClick={reportCursor}
        onSelect={reportCursor}
        onScroll={syncGutter}
        className={`flex-1 min-w-0 h-full resize-none border-0 outline-none bg-transparent text-text px-3 py-2 whitespace-pre overflow-auto ${readOnly ? 'opacity-60' : ''}`}
        style={{ lineHeight: `${LINE_HEIGHT_PX}px`, tabSize: 2 }}
      />
    </div>
  )
})

export default PapyrusEditor

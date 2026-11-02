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
 * Long lines wrap, as prose does. A gutter number sits at the top of its line,
 * and each gutter row is as tall as its line is on screen: a hidden mirror with
 * the textarea's width, font and wrapping lays the lines out once more so their
 * heights can be measured. Where nothing can be measured (no layout, as under
 * jsdom), every row is one line tall.
 */
import {
  forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from 'react'
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
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  // The on-screen height of each line, in pixels, from the mirror. Empty until
  // measured, and a missing or zero entry means one line.
  const [heights, setHeights] = useState<number[]>([])
  const heightsRef = useRef<number[]>([])

  const lines = useMemo(() => value.split('\n'), [value])

  const measure = useCallback(() => {
    const area = areaRef.current
    const mirror = mirrorRef.current
    if (!area || !mirror) return
    // `clientWidth` leaves out the textarea's scrollbar, so the mirror wraps at
    // the same column as the text the user sees.
    mirror.style.width = `${area.clientWidth}px`
    const next = Array.from(mirror.children, child => (child as HTMLElement).offsetHeight)
    const prev = heightsRef.current
    if (next.length === prev.length && next.every((h, i) => h === prev[i])) return
    heightsRef.current = next
    setHeights(next)
  }, [])

  useLayoutEffect(() => { measure() }, [lines, measure])

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(area)
    return () => observer.disconnect()
  }, [measure])

  useImperativeHandle(ref, () => ({
    jumpToLine: (line: number) => {
      const area = areaRef.current
      if (!area) return
      const offset = lineOffset(area.value, line)
      area.focus()
      area.setSelectionRange(offset, offset)
      // Three lines of context above the target, counted in on-screen rows.
      const target = Math.max(1, Math.floor(line)) - 1
      let top = 0
      for (let i = 0; i < target; i++) top += heightsRef.current[i] || LINE_HEIGHT_PX
      area.scrollTop = Math.max(0, top - 3 * LINE_HEIGHT_PX)
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

  const lineCount = lines.length

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
          style={{ height: heights[line - 1] || LINE_HEIGHT_PX }}
          title={mark ? mark.messages.join('\n') : undefined}
          data-marker={mark ? mark.severity : undefined}
        >
          {line}
        </div>,
      )
    }
    return rows
  }, [lineCount, marks, heights])

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
      <div className="relative flex-1 min-w-0 h-full">
      {/* The measuring mirror: the same box, font and wrapping as the textarea,
          one block per line. Invisible and out of the accessibility tree. */}
      <div
        ref={mirrorRef}
        aria-hidden="true"
        className="absolute top-0 left-0 invisible pointer-events-none px-3 whitespace-pre-wrap [overflow-wrap:anywhere]"
        style={{ lineHeight: `${LINE_HEIGHT_PX}px`, tabSize: 2, boxSizing: 'border-box' }}
      >
        {lines.map((text, i) => <div key={i}>{text || '\u200b'}</div>)}
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
        wrap="soft"
        aria-label={path}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={reportCursor}
        onClick={reportCursor}
        onSelect={reportCursor}
        onScroll={syncGutter}
        className={`relative block w-full h-full resize-none border-0 outline-none bg-transparent text-text px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] overflow-x-hidden overflow-y-auto ${readOnly ? 'opacity-60' : ''}`}
        style={{ lineHeight: `${LINE_HEIGHT_PX}px`, tabSize: 2 }}
      />
      </div>
    </div>
  )
})

export default PapyrusEditor

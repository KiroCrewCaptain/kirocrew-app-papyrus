/**
 * What changed when the page left the dashboard: its own editor, its own string
 * catalogs, the host's scoped client as the transport, and the fallbacks for a
 * host older than App Kit level 1.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import PapyrusEditor, { type PapyrusEditorHandle } from '../src/PapyrusEditor'
import { CATALOGS, localeChain, t } from '../src/i18n'
import { papyrusApi, setTransport } from '../src/api'
import { stubLocale } from './stubs/app-sdk'

const SRC = join(__dirname, '..', 'src')

describe('the source editor', () => {
  const diagnostics = [
    { level: 'error' as const, message: 'Undefined control sequence', line: 2, file: 'main.tex' },
    { level: 'warning' as const, message: 'Overfull box', line: 2, file: 'main.tex' },
    { level: 'warning' as const, message: 'Citation undefined', line: 3, file: 'main.tex' },
    { level: 'typesetting' as const, message: 'no line', line: null, file: null },
  ]

  function renderEditor(over: Partial<Parameters<typeof PapyrusEditor>[0]> = {}) {
    const onChange = vi.fn()
    const onSave = vi.fn()
    const onCursorChange = vi.fn()
    const ref = createRef<PapyrusEditorHandle>()
    render(
      <PapyrusEditor
        ref={ref}
        path="main.tex"
        value={'a\nb\nc\nd'}
        onChange={onChange}
        onSave={onSave}
        diagnostics={diagnostics}
        onCursorChange={onCursorChange}
        {...over}
      />,
    )
    return { onChange, onSave, onCursorChange, ref, area: screen.getByLabelText('main.tex') as HTMLTextAreaElement }
  }

  it('reports edits through onChange and owns no document state', () => {
    const { onChange, area } = renderEditor()
    fireEvent.change(area, { target: { value: 'changed' } })
    expect(onChange).toHaveBeenCalledWith('changed')
    expect(area.value).toBe('a\nb\nc\nd')
  })

  it('saves on Cmd+S and on Ctrl+S', () => {
    const { onSave, area } = renderEditor()
    fireEvent.keyDown(area, { key: 's', metaKey: true })
    fireEvent.keyDown(area, { key: 'S', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('inserts two spaces for Tab instead of leaving the field', () => {
    const { onChange, area } = renderEditor({ value: 'ab' })
    area.setSelectionRange(1, 1)
    fireEvent.keyDown(area, { key: 'Tab' })
    expect(onChange).toHaveBeenCalledWith('a  b')
  })

  it('does not insert anything while read-only', () => {
    const { onChange, area } = renderEditor({ readOnly: true })
    fireEvent.keyDown(area, { key: 'Tab' })
    expect(onChange).not.toHaveBeenCalled()
    expect(area.readOnly).toBe(true)
  })

  it('marks each line with its worst diagnostic and places none without a line', () => {
    renderEditor()
    const marked = Array.from(document.querySelectorAll('[data-marker]'))
    expect(marked.map(el => [el.textContent, el.getAttribute('data-marker')])).toEqual([
      ['2', 'error'],
      ['3', 'warning'],
    ])
    expect(marked[0].getAttribute('title')).toBe('Undefined control sequence\nOverfull box')
  })

  it('jumps the caret to a line and reports the position', () => {
    const { ref, area, onCursorChange } = renderEditor()
    ref.current!.jumpToLine(3)
    expect(area.selectionStart).toBe(4)
    expect(onCursorChange).toHaveBeenLastCalledWith(3, 1)
    expect(document.activeElement).toBe(area)
  })

  it('clamps a jump past the last line to the end of the text', () => {
    const { ref, area } = renderEditor()
    ref.current!.jumpToLine(99)
    expect(area.selectionStart).toBe(area.value.length)
  })

  it('numbers every line in the gutter', () => {
    renderEditor({ value: 'x\ny\nz' })
    const gutter = screen.getByTestId('papyrus-editor').firstElementChild!
    expect(gutter.textContent).toBe('123')
  })
})

describe('the string catalogs', () => {
  const keysOf = (node: object, prefix = ''): string[] =>
    Object.entries(node).flatMap(([k, v]) =>
      typeof v === 'string' ? [prefix + k] : keysOf(v as object, `${prefix}${k}.`))

  it('carries every locale the dashboard ships', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(
      ['bn', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'zh-CN'],
    )
  })

  it('has every key the source names, in English', () => {
    const english = new Set(keysOf(CATALOGS.en))
    const used = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(path, 'utf-8').matchAll(/i18nT\('([^']+)'/g)) used.add(m[1])
        }
      }
    }
    walk(SRC)
    expect(used.size).toBeGreaterThan(50)
    const missing = [...used].filter(key => !english.has(key) && !english.has(`${key}_other`))
    expect(missing).toEqual([])
  })

  it('falls back from a regional locale to its base language, then English', () => {
    expect(localeChain('pt-BR')).toEqual(['pt', 'en'])
    expect(localeChain('xx')).toEqual(['en'])
  })

  it('picks the plural form the locale names', () => {
    stubLocale('en')
    expect(t('apps.papyrus.workspace.error_count', { count: 1 })).toBe('1 error')
    expect(t('apps.papyrus.workspace.error_count', { count: 2 })).toBe('2 errors')
    stubLocale('ru')
    expect(t('apps.papyrus.workspace.error_count', { count: 5 })).not.toBe('5 errors')
  })

  it('shows the key itself for a string no catalog has', () => {
    expect(t('apps.papyrus.no_such_key')).toBe('apps.papyrus.no_such_key')
  })
})

describe('the transport', () => {
  it('sends every call through the scoped client the root hands it', async () => {
    const raw = vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { status: 200 }))
    setTransport({ raw })
    try {
      await papyrusApi.listProjects()
      expect(raw).toHaveBeenCalledWith('/api/apps/papyrus/projects', undefined)
    } finally {
      setTransport(null)
    }
  })

  it("reads the backend's code back out of the scoped client's refusal", async () => {
    const raw = vi.fn(async () => {
      throw Object.assign(new Error('API 403'), {
        status: 403,
        body: JSON.stringify({ error: 'owner authorization required', code: 'owner_only' }),
      })
    })
    setTransport({ raw })
    try {
      await expect(papyrusApi.listProjects()).rejects.toMatchObject({ status: 403, code: 'owner_only' })
    } finally {
      setTransport(null)
    }
  })

  it('returns a failed compile carried by a refusal as a compile result', async () => {
    const result = { ok: false, log: '! Undefined control sequence.', errors: [], duration_ms: 3, code: 'compile_failed' }
    setTransport({
      raw: async () => {
        throw Object.assign(new Error('API 422'), { status: 422, body: JSON.stringify(result) })
      },
    })
    try {
      expect(await papyrusApi.compile('p')).toMatchObject({ ok: false, log: result.log })
    } finally {
      setTransport(null)
    }
  })
})

describe('an older host', () => {
  it('uses a native select and no caution marker without the level-1 names', async () => {
    vi.resetModules()
    vi.doMock('@kirocrew/app-sdk/ui', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('./stubs/app-sdk-ui')
      const { Select: _s, guideCaution: _g, ...older } = actual
      return older
    })
    try {
      const hostSdk = await import('../src/hostSdk')
      const NativeSelect = (await import('../src/host/NativeSelect')).default
      expect(hostSdk.Select).toBe(NativeSelect)
      expect(hostSdk.guideCaution).toEqual({})
    } finally {
      vi.doUnmock('@kirocrew/app-sdk/ui')
      vi.resetModules()
    }
  })
})

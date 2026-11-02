/**
 * Coming back to Papyrus after the co-author edited the open file.
 *
 * The co-author chat opens in Sessions, so the agent can rewrite a file while the
 * paper sits in another tab with unsaved typing. Returning to the tab must not
 * let the next save write that typing over the agent's version: the change on
 * disk is recorded as a conflict, the editor goes read-only with a notice, and
 * the notice's button is the only way out. A tab switch with nothing changed on
 * disk must block nothing, and a clean buffer simply shows the new text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PapyrusPage from '../src/PapyrusPage'
import { renderWithProviders } from './helpers'
import { papyrusApi } from '../src/api'
import { LAST_PROJECT_KEY } from '../src/lib'

const hoisted = vi.hoisted(() => ({
  jumpToLine: vi.fn(),
}))

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  papyrusApi: {
    health: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    saveFile: vi.fn(),
    createFile: vi.fn(),
    deleteFile: vi.fn(),
    setMainFile: vi.fn(),
    compile: vi.fn(),
    gitStatus: vi.fn(),
    gitCommit: vi.fn(),
    gitPush: vi.fn(),
    gitPull: vi.fn(),
    deleteProject: vi.fn(),
    createProject: vi.fn(),
    cloneProject: vi.fn(),
  },
}))

// Monaco has no accessible input under jsdom. The two extra buttons stand in for
// the editor callbacks the page owns but Monaco would otherwise be the only caller
// of: the cursor readout and the diagnostics jump handle.
vi.mock('../src/PapyrusEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    default: forwardRef<
      { jumpToLine: (line: number) => void; focus: () => void },
      {
        value: string
        onChange: (v: string) => void
        onSave?: () => void
        onCursorChange?: (line: number, column: number) => void
      }
    >(({ value, onChange, onSave, onCursorChange }, ref) => {
      useImperativeHandle(ref, () => ({
        jumpToLine: hoisted.jumpToLine,
        focus: () => {},
      }))
      return (
        <>
          <textarea aria-label="editor" value={value} onChange={e => onChange(e.target.value)} />
          <button type="button" onClick={() => onCursorChange?.(12, 5)}>move caret</button>
          {/* Stands in for Monaco's Cmd+S binding, the one save path with no
              button to disable — which is why the page also keeps a ref guard. */}
          <button type="button" onClick={() => onSave?.()}>save shortcut</button>
        </>
      )
    }),
  }
})

vi.mock('../src/PdfPreview', () => ({ default: () => <div data-testid="pdf" /> }))

const api = vi.mocked(papyrusApi)

const PROJECT = 'thesis'
const MAIN = 'main.tex'
const BODY = '\\documentclass{article}'
const AGENT = '\\documentclass{article} % edited by the co-author'
const NOTICE = 'Co-author changed this file'

let disk = BODY

function openWorkspace() {
  localStorage.setItem(LAST_PROJECT_KEY, PROJECT)
  const rendered = renderWithProviders(<PapyrusPage />, {
    queryDefaults: { staleTime: 30_000 },
  })
  return { ...rendered, user: userEvent.setup() }
}

async function workspaceReady() {
  await screen.findByTestId('papyrus-workspace')
  await screen.findByLabelText('editor')
  await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue(BODY))
}

function makeDirty(text: string) {
  fireEvent.change(screen.getByLabelText('editor'), { target: { value: text } })
}

/** The tab becomes visible again, as when the author comes back from Sessions. */
async function comeBack() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  disk = BODY
  api.health.mockResolvedValue({ status: 'ok', compiler: '/usr/bin/pdflatex', git: true })
  api.listProjects.mockResolvedValue({ projects: [{ name: PROJECT, modified: 0, has_pdf: false }] })
  api.getProject.mockResolvedValue({
    name: PROJECT, main_file: MAIN, files: [MAIN], has_pdf: false,
  })
  api.listFiles.mockResolvedValue({ files: [MAIN] })
  api.readFile.mockImplementation((_name: string, path: string) =>
    Promise.resolve({ path, content: disk }))
  api.saveFile.mockImplementation((_name: string, path: string, content: string) => {
    disk = content
    return Promise.resolve({ ok: true, path })
  })
  api.gitStatus.mockResolvedValue({ is_git: false })
  api.compile.mockResolvedValue({ ok: true, log: '', errors: [], duration_ms: 10 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Papyrus after a co-author edit in another tab', () => {
  it('records a conflict instead of letting the next save overwrite the agent', async () => {
    const { user } = openWorkspace()
    await workspaceReady()
    makeDirty('my unsaved paragraph')
    disk = AGENT

    await comeBack()

    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(screen.getByLabelText('editor')).toHaveValue('my unsaved paragraph')
    await user.click(screen.getByRole('button', { name: 'save shortcut' }))
    expect(api.saveFile).not.toHaveBeenCalled()
    expect(disk).toBe(AGENT)
  })

  it('loads the agent version once the author discards their changes', async () => {
    const { user } = openWorkspace()
    await workspaceReady()
    makeDirty('my unsaved paragraph')
    disk = AGENT
    await comeBack()

    await user.click(await screen.findByRole('button', { name: 'Discard my changes and reload' }))
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue(AGENT))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    expect(api.saveFile).not.toHaveBeenCalled()
  })

  it('blocks nothing when the file did not change on disk', async () => {
    const { user } = openWorkspace()
    await workspaceReady()
    makeDirty('my unsaved paragraph')
    const readsBefore = api.readFile.mock.calls.length

    await comeBack()
    await waitFor(() => expect(api.readFile.mock.calls.length).toBeGreaterThan(readsBefore))

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'save shortcut' }))
    await waitFor(() =>
      expect(api.saveFile).toHaveBeenCalledWith(PROJECT, MAIN, 'my unsaved paragraph'))
  })

  it('compares against what was last saved, not what was first loaded', async () => {
    const { user } = openWorkspace()
    await workspaceReady()
    makeDirty('first draft')
    await user.click(screen.getByRole('button', { name: 'save shortcut' }))
    await waitFor(() => expect(disk).toBe('first draft'))
    makeDirty('second draft')

    await comeBack()
    await waitFor(() => expect(api.readFile.mock.calls.length).toBeGreaterThan(1))

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })

  it('shows the agent version straight away when nothing was unsaved', async () => {
    openWorkspace()
    await workspaceReady()
    disk = AGENT

    await comeBack()

    await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue(AGENT))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })
})

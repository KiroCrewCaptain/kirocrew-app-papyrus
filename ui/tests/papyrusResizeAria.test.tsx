/**
 * The three resize grips as ARIA window-splitters: the position each one reports
 * must lie inside the range it advertises.
 *
 * This is not decoration. `ResizeHandle` is the splitter widget, so a screen
 * reader announces `aria-valuenow` against `aria-valuemin`/`aria-valuemax`
 * verbatim — a position outside the range is read out as-is, and two Papyrus
 * grips could produce one:
 *
 *  - the PDF grip, because its ceiling is a share of the window while its
 *    starting width was a flat constant, so a window between the two advertised
 *    a maximum below the width being rendered;
 *  - the file-tree grip, because the collapsed rail is 28px and sits outside the
 *    [120, 420] range a drag is clamped to.
 *
 * Both are invisible to a sighted user, which is exactly why they need a test.
 * The same mocks as `PapyrusPageCoverage` apply for the same reasons (Monaco has
 * no accessible input under jsdom, `PdfPreview` fetches a blob URL, and
 * `CoAuthorPanel` mounts the whole ChatPage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PapyrusPage from '../src/PapyrusPage'
import { renderWithProviders } from './helpers'
import { papyrusApi } from '../src/api'
import {
  CHAT_OPEN_KEY, CHAT_WIDTH_KEY, DEFAULT_PDF_WIDTH, DEFAULT_TREE_WIDTH,
  LAST_PROJECT_KEY, MIN_CHAT_WIDTH, MIN_EDITOR_WIDTH,
} from '../src/lib'

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  papyrusApi: {
    health: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    saveFile: vi.fn(),
    compile: vi.fn(),
    gitStatus: vi.fn(),
  },
}))

vi.mock('../src/PapyrusEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    default: forwardRef<{ jumpToLine: (line: number) => void; focus: () => void }, {
      value: string
      onChange: (v: string) => void
    }>(({ value, onChange }, ref) => {
      useImperativeHandle(ref, () => ({ jumpToLine: () => {}, focus: () => {} }))
      return <textarea aria-label="editor" value={value} onChange={e => onChange(e.target.value)} />
    }),
  }
})

vi.mock('../src/PdfPreview', () => ({ default: () => <div data-testid="pdf" /> }))
const api = vi.mocked(papyrusApi)
const PROJECT = 'thesis'
const MAIN = 'main.tex'

/** Every splitter on screen, with the three ARIA numbers it is announcing. */
function splitters() {
  return screen.getAllByTestId('resize-handle').map(el => ({
    label: el.getAttribute('aria-label') ?? '',
    now: Number(el.getAttribute('aria-valuenow')),
    min: Number(el.getAttribute('aria-valuemin')),
    max: Number(el.getAttribute('aria-valuemax')),
  }))
}

async function openWorkspace() {
  localStorage.setItem(LAST_PROJECT_KEY, PROJECT)
  renderWithProviders(<PapyrusPage />, {
    queryDefaults: { staleTime: 30_000 },
  })
  const user = userEvent.setup()
  await screen.findByTestId('papyrus-workspace')
  await screen.findByLabelText('editor')
  return user
}

beforeEach(() => {
  localStorage.clear()
  api.health.mockResolvedValue({ ok: true, pdflatex: true })
  api.listProjects.mockResolvedValue({ projects: [{ name: PROJECT, files: 1 }] })
  api.getProject.mockResolvedValue({
    name: PROJECT, main_file: MAIN, files: [MAIN], content: '\\documentclass{article}',
    pdf_url: null, log: null,
  })
  api.readFile.mockResolvedValue({ content: '\\documentclass{article}' })
  api.gitStatus.mockResolvedValue({ is_repo: false })
})

describe('papyrus resize grips report a position inside the range they advertise', () => {
  it('holds for every grip on first load, with no stored width to fall back from', async () => {
    // jsdom reports a 1024px window, where the preview's ceiling (512) is BELOW
    // the 520 starting width the column used to take unconditionally — so this
    // assertion fails on an unbounded default rather than passing either way.
    await openWorkspace()
    const grips = splitters()
    expect(grips.length, 'the tree and preview grips are both mounted').toBeGreaterThanOrEqual(2)
    for (const grip of grips) {
      expect(grip.now, `${grip.label} reports below its own minimum`)
        .toBeGreaterThanOrEqual(grip.min)
      expect(grip.now, `${grip.label} reports above its own maximum`)
        .toBeLessThanOrEqual(grip.max)
    }
  })

  it('holds for the file-tree grip once the tree is collapsed to its rail', async () => {
    const user = await openWorkspace()
    const tree = screen.getAllByTestId('resize-handle')[0]
    const before = Number(tree.getAttribute('aria-valuenow'))

    // Shift+ArrowLeft is the coarse step (64px): from 176 it lands on 112, under
    // the 120 minimum, which is the drag's collapse condition.
    tree.focus()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')

    const collapsed = splitters()[0]
    expect(collapsed.now, 'the step must have moved the column').not.toBe(before)
    expect(collapsed.now, 'the 28px rail must not be announced below the minimum')
      .toBeGreaterThanOrEqual(collapsed.min)
    expect(collapsed.now).toBeLessThanOrEqual(collapsed.max)
  })
})

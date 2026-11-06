# Porting notes: built-in → external app

This repository was ported from Kiro Crew's built-in Papyrus at KiroCrew `main`
`390c5315be` (the last commit touching the app is `6fcbaeb62c`):

- the backend, `src/kiro_crew/apps/builtins/papyrus/` (`app.json`,
  `ATTRIBUTION.md`, `backend/*.py`);
- the dashboard page, `website/src/apps/papyrus/`, and its store art,
  `website/public/app-assets/papyrus/`;
- the five skills the co-author prompt names, which shipped in Kiro Crew core:
  `src/kiro_crew/builtin_skills/papyrus-{writing,make-fluent,latex-comments,latex-suggestions,diagnose-compilation}/`;
- the `apps.papyrus.*` strings of `website/src/i18n/locales/*.json` (plus
  `en.manual.json`);
- the tests: `test/test_papyrus_{routes,routes_clone_title,store,latex,gitops,tectonic,doc_title}.py`,
  the Papyrus cases of `test/test_git_config_hooks.py`,
  `test/test_windows_extended_prefix_containment.py`,
  `test/test_regex_anchor_contract.py` and `test/metrics/test_feature_usage.py`,
  and the frontend tests under `website/src/test/Papyrus*`,
  `website/src/test/papyrus*` and `website/src/apps/papyrus/*.test.tsx`.

Paths with a line number below refer to that commit. A **gap** is something the
built-in gets from Kiro Crew that an external app has no public way to get yet;
closing one is a Kiro Crew change (a generic, app-agnostic App Kit seam), not a
change here.

## What carried over unchanged

- `app.json` `name` (`papyrus`), `author`, `license`, `permissions`,
  `dependencies`, `platform`, `defaultEnabled: false` and every display field
  (`displayName`, `description`, `highlights`, `useCases`, `configuration`).
  `tests/test_manifest_contract.py` compares them with the built-in's manifest
  (`tests/fixtures/builtin-app.json`), because adoption refuses a manifest that
  widens a grant or forces the app off. The `version` started equal to the
  built-in's (`0.2.0`) and only moves forward, one patch release per batch of
  Kiro Crew fixes carried over (see below).
- Every route's method, path, validation, status codes, error `code`s and
  response shape. The handler bodies are the built-in's.
- The security behaviour: the compiler runs in the sandbox's `strict` mode with
  the data home's keystone files hidden, never with shell escape, with
  `openout_any=p`/`openin_any=p`, and refuses a project containing a link; git
  runs in `standard` mode with every repository-config execution hook
  overridden, the attributes pin, the pack-program flags and
  `GIT_PROXY_COMMAND`; the managed Tectonic install is sha256-pinned and
  installed from a descriptor; all compiler and git output and every displayed
  title are redacted. These live in `backend/{latex,gitops,tectonic,store}.py`,
  which are the built-in's files with their imports changed.
- The data location: the gateway hands an app's hooks
  `ctx.data_dir = <data home>/apps/papyrus/data`, the directory the built-in
  resolved through `app_data_dir("papyrus")`
  (`src/kiro_crew/apps/builtins/papyrus/backend/store.py:43`, `:179`). Projects
  (`projects/<name>/`, each with its `.papyrus.json`) and the managed compiler
  (`vendor/tectonic/`) keep their paths, so a user's papers are read as they are.
- The skill directory names and frontmatter (`name: papyrus-*`, `app: papyrus`),
  so the co-author prompt loads the same skills.

## What changed, and why

| Built-in | Here | Why |
|---|---|---|
| `"backend": {"routes": "backend.routes:register_routes"}` (`app.json:44-46`) | `"backend": {"hooks": {"routes": "backend.routes:register_routes"}}` | Top-level `backend.routes` is read only by the built-in boot loop (`src/kiro_crew/dashboard/routes/system.py:234-243`). An external app's routes go through the gateway's `RouteRegistry`. |
| `register_routes(app: web.Application)` adding 20 absolute routes (`backend/routes.py:1085-1117`) | `register_routes(ctx) -> list[Route]`, relative paths, handlers `(request, ctx)` | The `hooks.routes` contract. `Route` is the app's own frozen dataclass (`backend/_host.py`), accepted structurally from App Kit level 1. The table is `routes.ROUTES`. |
| `_require_enabled`: an `is_app_enabled` read on every request (`backend/routes.py:146-177`) | Removed | The registry deregisters an app's routes on disable, so a disabled app answers 404. The `app_disabled` 403 is gone; the page never branched on it. |
| Owner gate through `kiro_crew.dashboard.handlers._shared.require_owner_dashboard_request` (`backend/routes.py:168-172`) | `ctx.require_owner(request, operation)` in `routes._owner_only` | The level-1 owner gate. It is the same host predicate and still refuses every app token, Papyrus's own included. Denials are audited as `papyrus.<verb>`, the built-in's operation names. A gateway without the seam refuses every caller. |
| `kiro_crew.security.redact` with an import-failure flag (`backend/routes.py:97-101`, `:202`) | `ctx.scrub.outbound(text).text` (`_host.redact`) | The level-0 scrub seam, which applies the gateway's active policy on top of the same two baseline passes. Output is withheld when the context has no scrubber or the scrubber raises. |
| `sel().log_api_access(caller="core:papyrus", source="builtin-app", …)` (`backend/latex.py:294`, `backend/gitops.py:156`, `backend/tectonic.py:383`) | `ctx.audit.record(operation, outcome, …)` (`_host.audit`) | The level-0 audit seam. Operation names are unchanged (`papyrus.compile`, `papyrus.git_push`, `papyrus.tectonic_provision`); the row's caller is now `app:papyrus` and its source `app`. |
| `app_data_dir("papyrus")` (`backend/store.py:43`, `:179`) | `ctx.data_dir`, bound by `register_routes` (`_host.bind`) | An external app has no ambient data home. The compiler-install thread and the runners reach the bound context, so it is held in `_host`. With no context bound, `store.data_dir()` raises rather than guessing a location. |
| Absolute self-imports `from kiro_crew.apps.builtins.papyrus.backend import …` (`backend/routes.py:92`, `latex.py:43`, `gitops.py:36`, `tectonic.py:71`, `:935`) | Relative imports | Hook files load into a synthetic package (App Kit `manifest-reference.md`, "Importing your own modules"). |
| Package `__init__.py` re-exporting `register_routes` (`__init__.py:14`) | Removed | Only the built-in boot loop reads it. |
| `kiro_crew.slugs.refused_slug_char` / `SLUG_CHARS`, `kiro_crew.git_divergence` helpers, `kiro_crew.atomic_write.atomic_write` | `backend/slugs.py`, `gitops.divergence_count_args` / `parse_divergence_counts`, `backend/_fs.py` | Small and carrying no security decision, so restated (see gap 6). |
| `kiro_crew.platform_compat` (`IS_WINDOWS`, `rmtree_force`, `strip_extended_length_prefix`, `fchmod_safe`, the kill helpers) | `backend/_compat.py` | The constants and file helpers are restated. The two process-tree kills use the gateway's own when it has them; the fallback signals only a group the child leads, never the gateway's. |
| `iconUrl` / `hero*` as absolute `/app-assets/papyrus/*.svg`, `screenshots` `/app-assets/…` (`app.json:66-73`) | `iconPath` / `hero*` / `screenshots` as repo-relative PNGs under `assets/` | A registry app's art is repo-relative, and the catalog's publish step refuses SVG for a non-builtin source. The PNGs were rendered from the built-in SVGs (kept beside them): the icon at 512×512 on an opaque tile with `--ico-a` / `--ico-b` resolved to fixed colours, the heroes at 1200×675 and the detail heroes at 1200×288. |
| `ui.pages` `[{"route": "/papyrus", "icon": "ScrollText"}]`, page compiled into the dashboard (`app.json:47-55`, `website/src/apps/builtinRegistry.ts:61`) | `ui.entry: "dist/index.mjs"` (a committed ESM bundle built from `ui/src/`), `ui.pages` `[{"route": "/apps/papyrus"}]`, no `icon` | An installed app ships its page as a bundle AppHost loads. The legacy `/papyrus` route and `ScrollText` glyph of an adopted record come from Kiro Crew's adoption pin, never from this manifest. |
| App Store copy keys in the dashboard catalogs (`website/src/components/appstore/appManifest.ts:318-332`) | `l10n` block in `app.json` for the 11 non-English locales | The listing copy travels with the app. It is the `apps.papyrus.manifest` subtree of `ui/i18n/<locale>.json`, kept equal by a test. |
| Skills under Kiro Crew's `builtin_skills/`, synced into every install | `skills/papyrus-*`, declared in `app.json` `skills` | An app's skills ship with the app. Two sentences changed, in `papyrus-writing` and `papyrus-diagnose-compilation`: they told the agent that the page recompiles when its turn ends, which is true only of the embedded panel (gap 1). They now tell it to ask the author to press Compile. |
| No `minKiroCrewVersion` | `"minKiroCrewVersion": "0.12.0"` | The first Kiro Crew with App Kit level 1. |

## Host controls without a seam: resolved from the gateway, fail closed

Nothing in `backend/` but `_host.py` names `kiro_crew`, and `_host.py` imports it
only lazily, by name, through one function (`_host._host_attr`;
`tests/test_no_host_imports.py` pins both). These are security controls: copying
them into this repository would leave a control that looks present and drifts
from the one the gateway enforces. Each is looked up at the moment it is needed;
when the gateway lacks it, the operation that needs it is **refused**, never run
without it, and `register_routes` reports the reason through `ctx.health`.

| Built-in import | Where | Without it |
|---|---|---|
| `kiro_crew.sandbox.{sandboxed_spawn_argv, shielded_prepare_off_loop, create_subprocess_limited, SandboxUnavailableError}` | `backend/latex.py:47-52`, `backend/gitops.py:44-49` | Compile answers 422 `compiler_sandbox_unavailable`, git answers 422 `git_sandbox_unavailable`; nothing is spawned |
| `kiro_crew.apps.registry.minimal_env`, `kiro_crew.security.sensitive_home_dirs`, `kiro_crew.config.loader.config_dir` | `backend/latex.py:44-45`, `:289`, `:316`, `:331` | The same compile refusal |
| `kiro_crew.executors.subprocess_executor` | `backend/latex.py:46`, `backend/gitops.py:38` | The loop's default pool |
| `kiro_crew.git_config_hooks.config_hook_disable_args_sandboxed_async` | `backend/gitops.py:39-42` | Git refused with "cannot check the repository's git hooks" |
| `kiro_crew.security.is_sensitive_path` | `backend/store.py:46` | Every path is treated as sensitive (refused) |
| `kiro_crew.hooks.safe_read_file_bytes_nolink` | `backend/store.py:45` | A `.papyrus.json` is unreadable, so no settings write proceeds |
| `kiro_crew.asset_downloader`, `kiro_crew.pinned_fs.fd_real_path` | `backend/tectonic.py:70` | The one-click compiler install fails with its reason |
| `kiro_crew.metrics.feature_usage.record_app_task` | `backend/routes.py:94`, `:845` | Nothing is counted (optional; a metric never fails a compile) |
| `kiro_crew.platform_compat.{kill_process_tree_async, kill_and_reap}` | `backend/latex.py:434`, `:451`, `backend/gitops.py:505`, `:519` | `_compat`'s fallback (see above) |

## Remaining gaps

1. **Embedded co-author chat.** The built-in mounted the dashboard's whole
   `ChatPage` beside the PDF (`website/src/apps/papyrus/CoAuthorPanel.tsx:23-29`,
   `:233`), created the paper's persistent session through the private API
   client and injected the paper's context silently
   (`website/src/apps/papyrus/PapyrusPage.tsx:686-701`, `:781-809`), and
   recompiled when the agent's turn ended (`PapyrusPage.tsx:866-901`). The SDK's
   `ChatEmbed` can show a session, but it needs `/api/chat` and
   `/api/chat/slots` in `permissions.api`, which the built-in never declared, and
   adoption refuses a widened grant (`permission_refusal` in Kiro Crew's adoption
   checks). So here **Co-author** saves the paper and opens a new
   persistent-memory chat in Sessions (`useChatLauncher`) whose message box holds
   the paper's context, visibly, for the author to send with their request
   (`ui/src/PapyrusPage.tsx`, `openCoAuthor`). There is no per-paper session
   memory (each press opens a new chat) and no automatic recompile; returning to
   the Papyrus tab re-reads the open file when it has no unsaved edits. When it
   has unsaved edits, returning compares the file on disk with the copy the
   buffer was loaded from or last saved as, and a difference records the
   co-author conflict, as the built-in's post-turn refresh did: the editor goes
   read-only with the "Co-author changed this file" notice, saves are refused,
   and `resolveConflict` is the exit (`detectDiskChange`). Closing this needs an app-agnostic seam that lets an app
   embed a chat on a session it creates without widening its manifest grant (or
   an adoption rule that carries such a grant with consent), plus an SDK signal
   for "this session's turn ended".
   - The `description` and highlight 5 still describe a co-author **panel**,
     and the detail hero art shows one, because the listing copy and its 11
     translations are the built-in's (see "What carried over"). Update them in
     every locale when this gap is settled either way.
2. **Sandboxed child processes.** The controls in the table above have no App
   Kit seam. A generic `ctx.subprocess` (spawn an argv through the gateway's
   chokepoint at a named sandbox mode, with the hidden-path floor, resource
   limits and audit) plus `ctx.paths.is_sensitive` / a pinned reader and a
   verified-download seam would remove every `kiro_crew` name from `_host.py`.
3. **Source editor.** The built-in used the dashboard's private Pierre editor
   (`website/src/apps/papyrus/PapyrusEditor.tsx:11`) with syntax colouring and
   inline markers. The SDK exposes no editor, so `ui/src/PapyrusEditor.tsx` is a
   `<textarea>` with a line-number gutter, diagnostic marks in the gutter,
   Cmd/Ctrl+S, Tab-indents and jump-to-line. Long lines wrap.
4. **Other private UI components**, restated in `ui/src/host/` or replaced:
   `useConfirm` (over the SDK `Modal`), `useColumnResize` / `usePointerDrag` /
   `ResizeHandle` / `columnWidth` (copied), `useIsMobile`, `safeStorage`, the
   script-name labels (copied), `fmtUnit` / `fmtBytes` (over SDK `fmtNumber`);
   `SearchableSelect` became the SDK `Select` (a native `<select>` on an older
   host) without type-to-filter; the `framer-motion` open/close animation of the
   log pane is gone (`PapyrusPage.tsx:25`, `:1327-1346`).
5. **Execution trust.** A built-in's in-gateway Python is exempt from the
   third-party execution gate (`src/kiro_crew/apps/execution.py:694-709`). This
   copy's hooks load only when the operator trusts it. For an existing user
   Kiro Crew's adoption writes that grant for this repository; a fresh install
   goes through the normal trust dialog.
6. **File helper drift.** `backend/_fs.py`'s `atomic_write` keeps the temp-file
   + rename, the `0600` default, the mode-before-rename and a short Windows
   sharing-violation retry; it drops the host's data-home owner-only directory
   creation and its descriptor-pinned variants. A public file helper in the SDK
   would remove the copy.
7. **Styles.** The page keeps the built-in's Tailwind utility class strings.
   They render because the dashboard's stylesheet still carries them while the
   compiled built-in page ships with Kiro Crew.
8. **Store listing localization.** The catalog's publish step does not carry
   `l10n` yet, so a store row that is not installed shows the English fields.
9. **Sidebar icon on a fresh install.** The `ScrollText` glyph and the `/papyrus`
   route are shown only for an adopted record (from Kiro Crew's pin). A fresh
   install lives at `/apps/papyrus` with the `iconPath` image.
10. **Usage metric.** Kiro Crew counts Papyrus as an official app by name
    (`src/kiro_crew/metrics/feature_usage.py:239`) and lists its skills
    (`:195-199`); that list has to move to the catalog when the built-in goes.
11. **Skill duplicates on adoption.** Kiro Crew's builtin-skill sync has already
    copied `papyrus-*` into users' `<data home>/skills/` as real directories. The
    app's own skills then get only their namespaced link (`skills/papyrus/<name>`;
    the gateway skips a flat link over a real directory), so until core stops
    shipping and prunes its copies both are present.

## UI

The page is `ui/src/`, ported from `website/src/apps/papyrus/` with the same
markup, class strings and behaviour apart from gaps 1, 3 and 4. `npm run build`
in `ui/` writes the committed `ui/dist/index.mjs`; CI rebuilds it and fails on a
difference. Every request goes through the host's scoped client
(`useAppApi().raw`, handed to `api.setTransport` by the root), so a path outside
`permissions.api` is refused in the browser; the backend's `{error, code, char}`
is read back out of the client's refusal, and aiohttp's plain-text reasons are
kept. Strings are `t()` over `ui/i18n/<locale>.json` for all 12 dashboard
locales, with the dashboard's own key paths (`apps.papyrus.*` plus the handful of
shared strings the page used), plural forms by `Intl.PluralRules`.

## Tests

| Built-in test | Here | Change |
|---|---|---|
| `test/test_papyrus_routes.py` | `tests/test_routes.py` | `TestRequireEnabled` and the `app_disabled` case became registration and fail-closed cases (`TestRouteRegistration`, the owner-gate tests): the 20 method/path pairs, structural records, the gate on every route, no file touched at registration, the context bound, degraded health on an older host or one without the sandbox, a host refusal passed through unchanged. `_HAS_SECURITY` cases now remove or break `ctx.scrub`. |
| `test/test_papyrus_routes_clone_title.py`, `_store.py`, `_doc_title.py` | `tests/test_routes_clone_title.py`, `test_store.py`, `test_doc_title.py` | Data dir from the bound context instead of patching `app_data_dir`. |
| `test/test_papyrus_latex.py` | `tests/test_latex.py` | The host sandbox is the fake in `tests/fakehost.py`; the `_hidden_path_contains_visible_path` assertion is restated as a path-containment check; the data-home cases move the fake host's data home instead of `KIROCREW_HOME`. Dropped: `test_windows_location_hints_survive_the_allowlist`, which tests the host's `minimal_env` allowlist (Kiro Crew keeps it). |
| `test/test_papyrus_gitops.py` | `tests/test_gitops.py` | The host's refusal type is raised as the app's own `SandboxUnavailableError`, which `_host` translates to (pinned in `tests/test_host_seams.py`). The real-git demonstrations run unchanged. |
| `test/test_papyrus_tectonic.py` | `tests/test_tectonic.py` | Downloads go through the fake host's verified downloader over the same mocked opener. Dropped: the three `redact_url` cases, which test the host's `asset_downloader` (Kiro Crew keeps them). |
| Papyrus cases of `test_git_config_hooks.py`, `test_windows_extended_prefix_containment.py`, `test_regex_anchor_contract.py`, `metrics/test_feature_usage.py` | `tests/test_host_seams.py` | Ported against the fake scanner and fake metric; plus every fail-closed path above, the audit rows and the data directory. |
| (none) | `tests/test_no_host_imports.py`, `tests/test_manifest_contract.py` | Only `_host.py` reaches `kiro_crew`, lazily. The bundle imports only host modules and only names every supported host exports; manifest parity with the built-in; the `l10n` block; repo-relative PNG art; hooks resolve; the declared skills cover the prompt's; an adoptable tree. |
| `website/src/test/PapyrusLib.test.ts`, `PapyrusDiagnostics`, `PapyrusPdfPreview`, `PapyrusApi.coverage`, `PapyrusPaperTitle`, `PapyrusWorkspaceTitle`, `PapyrusCloseProject`, `PapyrusPageCoverage`, `papyrusResizeAria`, `apps/papyrus/FileTree.cov80.test.tsx` | `ui/tests/` | Run by vitest with stand-ins for the host SDK (`ui/tests/stubs/`). The co-author session and refresh cases became co-author launch cases (save first, persistent memory, the paper's context in the message, stay on a failed save); the API error cases follow the scoped client (status and body, no status text); the main-document picker is a select. |
| `website/src/apps/papyrus/CoAuthorPanel.cov80.test.tsx`, the co-author half of `papyrusResizeAria.test.tsx` | Dropped | The panel is gone (gap 1). |
| `website/src/test/PapyrusEditorSeed.test.tsx` | `ui/tests/externalSeams.test.tsx` | The Pierre seeding it pinned is gone (gap 3); the new editor's contract is tested instead, with the catalogs, the transport and the older-host fallbacks. |
| `website/src/test/papyrusNarrow.test.ts` | Dropped | Source-text assertions over the dashboard's own layout files (`App.tsx`, `routeActive.ts`) and the co-author panel. |
| `test/test_skill_trigger_unusable.py:131` | Stays in Kiro Crew | It tests the host's trigger matcher, reading `papyrus-diagnose-compilation` as a fixture; it needs another fixture when core stops shipping the skill. |

## Kiro Crew fixes carried over after the port

The built-in kept receiving fixes on Kiro Crew `main` after `390c5315be`. Each
user-visible one is carried here so an adopted user has it too; test-only
changes are carried when they add a case this repository lacks.

| Kiro Crew commit | Here | Release |
|---|---|---|
| `00a0937467` fix(papyrus): probe tectonic.exe/pdflatex.exe in userspace on Windows (#30438) | `backend/latex.py` `_userspace_compiler_globs`, its five cases in `tests/test_latex.py` (`TestFindCompiler`) | 0.2.1 |
| `7a4e28199b` test: give weak long-tail tests real outcome checks (#29493) | The Papyrus outcome checks in `tests/test_latex.py` (the compiler cache, the two symlinked-artifact compiles) | 0.2.1 |
| `2f241cbfce` test(papyrus): cover the paper list create, clone and delete (#27774) | `ui/tests/ProjectList.coverage.test.tsx` | 0.2.1 |
| `a430ddd454` refactor: make core independent of the papyrus app (#27978) | Nothing to carry: it moves the built-in's frontend tests and guards core's boundary; `tests/test_host_seams.py` already pins the count-after-compile order it adds | — |
| `ed97f28e63` test(co-author-panel): wait for the chat switch before header clicks (#27977) | Nothing to carry: the panel is gone here (gap 1) | — |

## What Kiro Crew keeps doing

The release that adds adoption still ships the built-in. A user's built-in
record moves onto this repository at the commit Kiro Crew pins, after the tree is
fetched and verified; a record that cannot move keeps running the built-in copy,
unchanged. Because of gap 1, adopting Papyrus changes the co-author from a panel
to a Sessions chat, so its pin should wait for that gap's ruling. Removing the
built-in, its skills, its catalog keys and the core references
(`src/kiro_crew/apps/builtins/__init__.py:16`,
`src/kiro_crew/security_posture.py:1215`,
`src/kiro_crew/metrics/feature_usage.py:195-199`, `:239`,
`website/src/apps/builtinRegistry.ts:61`,
`website/src/components/appstore/appManifest.ts:318-332`) is a later release.

## Release handoff: one commit for both pins

1. Call the full 40-hex SHA of the commit to pin `C` (`git rev-parse HEAD`).
2. In the Kiro Crew release PR that adds adoption, run
   `python3 scripts/adoption_pin.py compute <this URL> C` and add the row it
   prints to `src/kiro_crew/apps/adoption-pins.json`; then
   `python3 scripts/adoption_pin.py verify`.
3. The KiroCrewApps row for `papyrus` switches from `"type": "builtin"` to
   `"type": "git"`, this URL, `"ref": "C"`, never a branch name.
4. Check that both files name the same `C`, and that GitHub serves it
   (`git fetch origin C` in a fresh clone, then `git cat-file -t C` prints
   `commit`).

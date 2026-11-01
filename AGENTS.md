# AGENTS.md

## Project overview

Mantle is a note-taking desktop app (an Obsidian-style vault of Markdown notes,
with optional zero-knowledge encryption) built with Tauri 2 (Rust backend) and
Angular 22 (frontend, signals-based, no NgModules).

- **Frontend** (`src/app/`): a `layout/` shell (header, sidebar with vault
  tree, content area) around a `notes/` feature — a tabbed, ProseMirror-based
  Markdown editor (`notes/editor/`) with a slash command menu, which shows the
  Markdown under the cursor as editable raw text (`syntax-reveal-plugin.ts`:
  `md_raw` / `md_prefix` marks, saved so the file never changes). A `[TOC]`
  paragraph shows the note's headings (`toc-plugin.ts`), and the sidebar's
  Outline section lists them for the editor last focused (`OutlineState`). The editor
  area splits into nested panes (`TabsState.layout`, rendered by
  `layout/pane-layout/`), each with its own `TabStrip`; two panes showing one
  note share its `NotesState` entry and copy each other's edits in — plus
  `shared/` UI primitives (menu surface/item, context menu). The Edit menu acts
  on whichever of the editor or vault tree last had focus (`EditContextState`);
  undo/redo outside the editor go to `VaultHistoryState`, the session's
  vault-action history. Structural tree actions live in `VaultActions`, which
  keeps tabs/notes/`state.json` following moved paths and records each undo
  step; other actions (favorites, tags, encryption, profiles) record their own.
  Undoing a delete restores from the OS trash (`restore_from_trash`; not on
  macOS, where deletes keep their confirmation).
- **Android** (`src-tauri/gen/android/`, arm64, Android 10+): the same app,
  with `isMobile` (`core/tauri-env.ts`, also the `mobile:` Tailwind variant)
  swapping the desktop chrome for `layout/mobile-shell/` — one pane, the
  sidebar as a drawer, a bottom bar that turns into a formatting toolbar
  while the editor has focus, and Android's back gesture closing overlays
  (each closes on Escape) before going back through notes. Vaults are plain
  folders in shared storage behind "All files access"; `MainActivity.kt`
  exposes that check, the storage root and "move to back" as
  `window.MantleAndroid`, and pads the webview clear of the system bars and
  keyboard. Folder and save dialogs go through `FolderPickerState`, an
  in-app browser (`list_folders`) on Android since its picker returns
  `content://` URIs. There's no OS trash there, so deletes are permanent and
  confirmed (`move_to_trash`, `canUndoDelete`). Context-menu items marked
  `desktopOnly` (file explorer, default app, split panes) are left out.
  CI (`build.yml`'s `android` job) builds a release APK signed with the
  committed `debug.keystore`, so each installs over the last.
- **Rust backend** (`src-tauri/`): Tauri commands in `src-tauri/src/vault.rs`
  for scanning a vault directory and reading/writing/creating notes, on top of
  the `mntl-core` crate. Plain Markdown files (`.md` / `.markdown`) also open
  as notes: they're saved in place as Markdown, their own YAML frontmatter is
  hidden and written back verbatim (except the keys Mantle edits as tags and
  properties), and they only become `.mntl` through `convert_markdown_notes`
  or encryption, which move that frontmatter into the note's tags and
  properties (refusing frontmatter that isn't valid YAML) and copy every local
  file the note links or embeds into `attachments/`.
  `src-tauri/src/vault_meta.rs` loads/saves
  `.mantle/state.json` inside the vault — favorites, manual sort order, and
  collapsed folders — a vault-local file so this metadata travels with the
  vault across machines/sync rather than living in this app install's local
  storage (see `goals/vault-state-future.md`).
  `src-tauri/src/credentials.rs` owns credential profiles: the
  `.mantle/profiles.json` registry and the in-memory session keys of unlocked
  profiles. `src-tauri/src/notes_crypto.rs` converts notes between the
  plaintext and encrypted formats and moves them between profiles.
  `src-tauri/src/tags.rs` renames or removes a tag across the whole vault;
  its `edit_note` rewrites one note of any kind, which `src-tauri/src/links.rs`
  also uses to rewrite `[[links]]` after a rename or move.
  `src-tauri/src/typst_render.rs` compiles ` ```typst ` blocks to SVG for
  the editor's code block view (no file or package access, cached in memory
  by content hash); ` ```mermaid ` blocks render in the frontend, the
  `mermaid` package loaded lazily on first use.
  `src-tauri/src/export.rs` turns Mantle notes back into Markdown — in place
  (`convert_to_markdown`) or as a copy of the vault elsewhere (`export_vault`)
  — writing their `attachments/` files out decrypted where the user picks
  (`Placement`), never into `attachments/` itself; notes of locked profiles
  are skipped and reported. `src-tauri/src/migrate.rs` imports an Obsidian
  vault into a new Mantle vault (copy, resolve `![[embeds]]` the way Obsidian
  does, then `convert_markdown_notes` on the copy); the source is never changed.
  `src-tauri/src/attachments.rs` stores attachments — images, and any file a
  converted note linked — in the vault's `attachments/` folder
  (content-hashed for plaintext notes, `<random>.<ext>.enc` sealed in the note
  envelope for encrypted ones) and serves images, videos and PDFs to the
  editor and preview tabs through the `mantle://` protocol, decrypting in
  memory. Videos and PDFs are sealed in `mntl-core`'s chunked envelope
  (`stream.rs`, version 4), so the protocol answers HTTP range requests by
  decrypting only the chunks asked for; other files keep the whole-file
  envelope, and old ones are never rewritten. Any other sealed file only
  leaves as a "Save decrypted copy as…" the user picks. Its link scanner
  (`link_sources`) skips code, so code is never rewritten. An attachment belongs to its
  profile (or to plaintext notes): encrypting, decrypting or re-homing a note,
  and every `write_note`, copies any attachment that belongs elsewhere and
  re-points the link (`write_note` returns those re-pointings for the editor
  to follow). That invariant is what lets `unused_attachments` judge an
  attachment without unlocking every profile — a locked note can only hold
  its own profile's. Attachments are never modified once written, and only
  deleted (to the OS trash) when the user opts in while deleting notes,
  removing an image, or deleting a profile. The vault-root `attachments/`
  folder is hidden from the tree; other non-note files appear as `file` nodes
  and open in a read-only preview tab.
- **`crates/mntl-core`**: standalone Rust crate (Cargo workspace member,
  independent of Tauri) implementing the `.mntl` note format — plaintext
  Markdown with a YAML frontmatter header — and the `.mntl.enc` encrypted
  envelope format (Argon2id KEK derivation, XChaCha20-Poly1305 + AES-KW
  envelope encryption). Its `tags` module defines what a valid tag is and
  reads/edits tags in a plain Markdown file's frontmatter.

## Tags

- A note's tags live **in the note**: `NoteFrontmatter::tags` for `.mntl`
  (sealed inside the ciphertext for `.mntl.enc`), and the Obsidian-style
  `tags:` key of a `.md` file's own frontmatter. There is no separate tag
  store and no cache; the index is derived from `scan_vault`, which reads each
  plaintext note's frontmatter and decrypts the notes of unlocked profiles.
  A locked note's tags are unknown (`tags: null`), so the frontend rescans on
  unlock/lock.
- Tags are flat and case-insensitive (`Idea` = `idea`, first spelling kept).
  New tags must pass `normalize_tag` / `normalizeTag` (letters, digits, `-`,
  `_`; not all digits); tags another tool wrote into a `.md` are read as-is.
- `read_note` returns `{ content, tags }` and `write_note` takes both, so
  every save carries the tags; `NotesState` debounces tag edits like content.
- A vault-wide rename/remove rewrites note files, so `TagsState` flushes
  pending writes first and then mirrors the edit into loaded notes
  (`NotesState.retagLoaded`), or the next save would restore the old tags.
  Notes in locked profiles are skipped and reported, not silently missed.

## Links

- `[[target#heading|alias]]` (and `![[note]]`) is a `wikilink` mark in the
  editor, saved verbatim. Like tags, each note's link targets come from
  `scan_vault` (`links`, null while locked); `NoteLinksState` /
  `LinkIndex` (`links.ts`) resolve them by name (full path, then path
  suffix, then same folder, then shortest path) and derive backlinks. A link
  only resolves within its note's `linkScope`, plaintext notes or one
  profile's notes, so a locked profile's notes can't link outside it.
- Renames and moves go through `VaultActions`, which hands the tree from
  before to `NoteLinksState.fixAfterMove`: every link that no longer leads
  where it did is rewritten (`rewrite_links`), loaded notes reload, and
  locked notes that could have linked to what moved are reported. Undo is the reverse move, fixed the same way.

## Properties

- A note's other frontmatter keys are its **properties**: `NoteFrontmatter::properties`
  (an ordered map nested under `properties:`, sealed for `.mntl.enc`), or a
  `.md` file's own top-level keys. `read_note` / `write_note` carry them as
  JSON (`NoteProperty`); for a `.md`, a save rewrites only the keys whose value
  changed (`mntl_core::set_markdown_property`), and frontmatter that isn't a
  YAML mapping comes back as `properties: null` and is never written.
- Types (`properties.ts`) are vault-wide by lowercased name in
  `.mantle/state.json` `propertyTypes`; a value that doesn't fit its type is
  shown as what it infers to, never coerced.
- Panel edits go through the open editor as doc attributes (`tags`,
  `properties` on the `doc` node), so they share the note's undo history;
  `NotePropertiesState` routes them, and the editor reports every attribute
  change back (an undo included). Changes from elsewhere (a vault-wide tag
  rename) are synced into the doc without a history step.

## Encryption

Notes can be encrypted under a named **credential profile**. A profile's
password derives an Argon2id KEK, which AES-KW-wraps a random per-profile
**master key**; each note has its own content key, wrapped by that master key
and stored in the note's header. Unlocking one profile therefore opens all of
its notes from a single password entry, and changing a password would only
need to rewrap the master key rather than rewrite every note.

Things to know before touching this code:

- **The `.mntl.enc` JSON header is the AEAD's associated data.** A field can
  never be added to an existing note's header without re-encrypting its body,
  so the header holds only what's needed to find the key (profile id, wrapped
  content key, nonce). Everything else about a note belongs in the
  `NoteFrontmatter` sealed inside the ciphertext. `decrypt_note` must keep
  passing the header bytes *as they appear on disk* as AAD, never a
  re-serialization — `test_decrypts_a_golden_fixture_blob` guards this.
- **`.mantle/profiles.json` holds the only copy of each wrapped master key.**
  Losing it makes every encrypted note in that vault unrecoverable, even with
  the right password. Hence the `.bak` written on every save.
- **Errors from `credentials.rs` and `notes_crypto.rs` reach the on-disk log**
  via `logging::logged` — never interpolate a password, key, or decrypted note
  content into one. Key types have hand-written redacting `Debug` impls so a
  stray `{:?}` cannot leak.
- **Master keys never cross the IPC boundary.** The frontend only learns
  whether a profile is unlocked; `read_note`/`write_note` return the sentinel
  `mantle:locked:<profile-id>` when it isn't.
- **Locking must flush pending writes first** — `NotesState` debounces saves by
  a second, and a pending write still needs the key.
- **An encrypted note's favorite is sealed in the note** (`NoteFrontmatter::favorite`,
  set by `set_note_favorite`), not in `.mantle/state.json`, so a locked vault
  doesn't reveal which notes are favorites. Saves decrypt the old version to
  keep the flag (`reseal_note`); decrypting a note clears it.
  `FavoritesState` routes each favorite to the right place and moves any
  `.mntl.enc` path found in `state.json` into the note once it's unlocked.
- **Hidden notes** (`src-tauri/src/hidden.rs`): a profile's "Hide locations" /
  "Hide names" settings seal each note's real folder and name in its
  `NoteFrontmatter` (`location`, `name`) and flag its header `hidden`. The
  frontend knows an unlocked hidden note only by its *virtual* path; resolve
  every incoming note path with `hidden::resolve_note`, never
  `resolve_rel_path`, and write through `hidden::seal_at` whenever a write may
  change whether or where a note is hidden. A rewrite in place keeps the flag
  (`vault::sealed_hidden`). Hidden notes and virtual folders stay out of
  `state.json` and persisted tabs.
- The design gives at-rest confidentiality of the vault directory; it does not
  resist an attacker who can read a running Mantle process's memory.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`), not npm.

- `pnpm start` — run Angular dev server only (port 1420)
- `pnpm run tauri dev` — run the full Tauri app (Angular + Rust) in dev mode
- `pnpm run build` — production Angular build
- `pnpm test` — run Jest test suite
- `pnpm tauri android build --apk --target aarch64` — build the Android APK (needs JDK 17–24, the Android SDK/NDK, `ANDROID_HOME` and `NDK_HOME`; on Windows, Developer Mode for the symlink it makes)
- `cargo check` / `cargo build` (from repo root or `src-tauri/`) — check/build the Rust workspace (`src-tauri` + `crates/mntl-core`)
- `cargo test` (from repo root) — run Rust tests, including `crates/mntl-core`'s crypto tests

## Testing

- Frontend tests use Jest with `jest-preset-angular` (config in `jest.config.ts`, setup in `setup-jest.ts`).
- Test files live next to the code they test (e.g. `header.spec.ts` next to `header.ts`).
- Rust: `#[cfg(test)]` unit tests in `src-tauri/src/vault.rs` (path traversal, note classification, compound `.mntl.enc` extension handling, scanning), `src-tauri/src/vault_meta.rs` (default-on-missing, round trip, forward-compatible parsing), `src-tauri/src/credentials.rs` (slugs, registry, unlock), `src-tauri/src/notes_crypto.rs` (encrypt/decrypt conversion), `src-tauri/src/tags.rs` (vault-wide rename/remove), `src-tauri/src/hidden.rs` (hiding and un-hiding a profile's notes), `src-tauri/src/export.rs` (Markdown conversion and export), `src-tauri/src/links.rs` (link rewrites), `src-tauri/src/migrate.rs` (Obsidian import), and `src-tauri/src/attachments.rs` (image storage, link scanning, path resolution); `crates/mntl-core/tests/crypto_tests.rs` covers the key hierarchy and the envelope formats (golden fixtures for the note envelope and the chunked one), and `crates/mntl-core/src/tags.rs` has unit tests for tag validation and Markdown frontmatter editing.
- Rust tests that need an unlocked profile use `SessionKeys::unlock_for_test` and cheap `KdfParams`, rather than paying for a production-cost Argon2id derivation per test.

## Conventions

- Angular components are standalone (no NgModules); component prefix is `app`. State lives in `Injectable({ providedIn: 'root' })` services named `*-state.ts` (e.g. `VaultState`, `NotesState`, `TabsState`) built on signals/effects, not in components.
- Styling uses Tailwind CSS (`@tailwindcss/postcss`, `.postcssrc.json`) — prefer utility classes over new CSS. Theme colors are CSS custom properties in `src/styles/theme.css` (light/dark via `prefers-color-scheme`) — use those tokens (`bg-[var(--surface)]`, etc.) instead of hardcoded colors.
- The palette is "ember & basalt" — warm neutrals plus one ember `--primary`, defined in both themes in `theme.css`. `--accent` is a soft tint (hover/selection), not the brand color; use `primary` for emphasis and `ring` for focus borders. Type: Inter only — no second face; get hierarchy from size, weight and tracking. Use the `.frame` (grained backdrop), `shadow-card`, `.kbd` and `animate-pop-in` helpers in `styles.css` rather than re-creating them.
- Component style files are omitted (`"style": "none"` in `angular.json` schematics) — keep styling in Tailwind classes or `styles/theme.css`.
- Reusable menu UI (slash menu, context menu) is built from the shared `MenuSurface`/`MenuItem`/`MenuSeparator` components in `src/app/shared/menu/` — extend those rather than duplicating menu markup.
- Icons come from `@lucide/angular`; import only the specific `Lucide*` icons used by a component.
- Keep new Tauri commands in `src-tauri/src/lib.rs` (or split into modules under `src-tauri/src/` as the backend grows, following `vault.rs`) and register them via `invoke_handler(tauri::generate_handler![...])`. Cryptography and note-format logic belongs in `crates/mntl-core`, not `src-tauri`.
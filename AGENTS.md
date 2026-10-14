# AGENTS.md

## Project overview

Mantle is a note-taking desktop app (an Obsidian-style vault of Markdown notes,
with optional zero-knowledge encryption) built with Tauri 2 (Rust backend) and
Angular 22 (frontend, signals-based, no NgModules).

- **Frontend** (`src/app/`): a `layout/` shell (header, sidebar with vault
  tree, content area) around a `notes/` feature — a tabbed, ProseMirror-based
  Markdown editor (`notes/editor/`) with a slash command menu — plus `shared/`
  UI primitives (menu surface/item, context menu).
- **Rust backend** (`src-tauri/`): Tauri commands in `src-tauri/src/vault.rs`
  for scanning a vault directory and reading/writing/creating notes, on top of
  the `mntl-core` crate. Plain Markdown files (`.md` / `.markdown`) also open
  as notes: they're saved in place as Markdown, their own YAML frontmatter is
  hidden and written back verbatim (except the `tags:` key, which Mantle
  edits), and they only become `.mntl` through `convert_markdown_to_note` or
  encryption (both drop that frontmatter but keep its tags).
  `src-tauri/src/vault_meta.rs` loads/saves
  `.mantle/state.json` inside the vault — favorites, manual sort order, and
  collapsed folders — a vault-local file so this metadata travels with the
  vault across machines/sync rather than living in this app install's local
  storage (see `goals/vault-state-future.md`).
  `src-tauri/src/credentials.rs` owns credential profiles: the
  `.mantle/profiles.json` registry and the in-memory session keys of unlocked
  profiles. `src-tauri/src/notes_crypto.rs` converts notes between the
  plaintext and encrypted formats and moves them between profiles.
  `src-tauri/src/tags.rs` renames or removes a tag across the whole vault.
  `src-tauri/src/attachments.rs` stores images in the vault's `attachments/`
  folder (content-hashed for plaintext notes, `<random>.<ext>.enc` sealed in
  the note envelope for encrypted ones) and serves them to the editor through
  the `mantle://` protocol, decrypting in memory. An attachment belongs to its
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
- Encrypted-note filenames are deliberately plaintext on disk for now.
- The design gives at-rest confidentiality of the vault directory; it does not
  resist an attacker who can read a running Mantle process's memory.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`), not npm.

- `pnpm start` — run Angular dev server only (port 1420)
- `pnpm run tauri dev` — run the full Tauri app (Angular + Rust) in dev mode
- `pnpm run build` — production Angular build
- `pnpm test` — run Jest test suite
- `cargo check` / `cargo build` (from repo root or `src-tauri/`) — check/build the Rust workspace (`src-tauri` + `crates/mntl-core`)
- `cargo test` (from repo root) — run Rust tests, including `crates/mntl-core`'s crypto tests

## Testing

- Frontend tests use Jest with `jest-preset-angular` (config in `jest.config.ts`, setup in `setup-jest.ts`).
- Test files live next to the code they test (e.g. `header.spec.ts` next to `header.ts`).
- Rust: `#[cfg(test)]` unit tests in `src-tauri/src/vault.rs` (path traversal, note classification, compound `.mntl.enc` extension handling, scanning), `src-tauri/src/vault_meta.rs` (default-on-missing, round trip, forward-compatible parsing), `src-tauri/src/credentials.rs` (slugs, registry, unlock), `src-tauri/src/notes_crypto.rs` (encrypt/decrypt conversion), `src-tauri/src/tags.rs` (vault-wide rename/remove), and `src-tauri/src/attachments.rs` (image storage, link scanning, path resolution); `crates/mntl-core/tests/crypto_tests.rs` covers the key hierarchy and the envelope format, and `crates/mntl-core/src/tags.rs` has unit tests for tag validation and Markdown frontmatter editing.
- Rust tests that need an unlocked profile use `SessionKeys::unlock_for_test` and cheap `KdfParams`, rather than paying for a production-cost Argon2id derivation per test.

## Conventions

- Angular components are standalone (no NgModules); component prefix is `app`. State lives in `Injectable({ providedIn: 'root' })` services named `*-state.ts` (e.g. `VaultState`, `NotesState`, `TabsState`) built on signals/effects, not in components.
- Styling uses Tailwind CSS (`@tailwindcss/postcss`, `.postcssrc.json`) — prefer utility classes over new CSS. Theme colors are CSS custom properties in `src/styles/theme.css` (light/dark via `prefers-color-scheme`) — use those tokens (`bg-[var(--surface)]`, etc.) instead of hardcoded colors.
- The palette is "ember & basalt" — warm neutrals plus one ember `--primary`, defined in both themes in `theme.css`. `--accent` is a soft tint (hover/selection), not the brand color; use `primary` for emphasis and `ring` for focus borders. Type: Inter only — no second face; get hierarchy from size, weight and tracking. Use the `.frame` (grained backdrop), `shadow-card`, `.kbd` and `animate-pop-in` helpers in `styles.css` rather than re-creating them.
- Component style files are omitted (`"style": "none"` in `angular.json` schematics) — keep styling in Tailwind classes or `styles/theme.css`.
- Reusable menu UI (slash menu, context menu) is built from the shared `MenuSurface`/`MenuItem`/`MenuSeparator` components in `src/app/shared/menu/` — extend those rather than duplicating menu markup.
- Icons come from `@lucide/angular`; import only the specific `Lucide*` icons used by a component.
- Keep new Tauri commands in `src-tauri/src/lib.rs` (or split into modules under `src-tauri/src/` as the backend grows, following `vault.rs`) and register them via `invoke_handler(tauri::generate_handler![...])`. Cryptography and note-format logic belongs in `crates/mntl-core`, not `src-tauri`.
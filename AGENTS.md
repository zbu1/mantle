# AGENTS.md

Mantle: note-taking desktop app (Obsidian-style vault of Markdown notes, optional
zero-knowledge encryption). Tauri 2 (Rust, `src-tauri/`) + Angular 22 frontend
(`src/app/`, signals, standalone components) + `crates/mntl-core` (the `.mntl`
and `.mntl.enc` formats, crypto, tag rules). Also builds for Android
(`src-tauri/gen/android/`), where `isMobile` (`core/tauri-env.ts`) swaps in
`layout/mobile-shell/`.

Package manager is **pnpm**. Run `pnpm test` and `cargo test` after changes.

## Code style

- Comment only where the code alone is unclear: a hidden invariant, a reason
  for a surprising choice, a workaround. Let names and structure carry the rest.
- Ask the user when a requirement is ambiguous.

## Conventions

- State lives in `providedIn: 'root'` `*-state.ts` services on signals, not in components.
- Tailwind utilities only (no component style files); colors via the tokens in
  `src/styles/theme.css` (`bg-[var(--surface)]`), never hardcoded. Use `primary`
  for emphasis, `ring` for focus; `--accent` is only a soft hover/selection tint.
  Inter is the only typeface. Reuse the `.frame`, `shadow-card`, `.kbd`,
  `animate-pop-in` helpers.
- Menus extend `MenuSurface`/`MenuItem`/`MenuSeparator` in `src/app/shared/menu/`.
- Icons: import individual `Lucide*` icons from `@lucide/angular`.
- Tauri commands go in `src-tauri/src/` and are registered in `generate_handler!`.
  Crypto and note-format logic belongs in `mntl-core`, not `src-tauri`.
- Rust tests needing an unlocked profile use `SessionKeys::unlock_for_test` and
  cheap `KdfParams`.
- Android has no OS trash: deletes are permanent and confirmed. Context-menu
  items marked `desktopOnly` are omitted there.

## Vault data

- `.mantle/state.json` (`vault_meta.rs`) holds favorites, sort order, collapsed
  folders, item `styles`, and `propertyTypes`; it is vault-local so it syncs with the vault.
- Plain `.md` files open as notes and are saved in place. Their own frontmatter
  is written back verbatim except the keys Mantle edits (tags, properties). They
  become `.mntl` only via `convert_markdown_notes` or encryption.
- Structural tree changes go through `VaultActions`, which keeps tabs, notes and
  `state.json` following moved paths and records the undo step.

### Tags

- Tags live in the note (`NoteFrontmatter::tags`, or a `.md`'s `tags:` key). No
  separate store or cache; the index is derived from `scan_vault`. A locked
  note's tags are `null`, so rescan on lock/unlock.
- Flat, case-insensitive. New tags must pass `normalize_tag` / `normalizeTag`;
  tags another tool wrote are read as-is.
- Vault-wide rename/remove: `TagsState` flushes pending writes first, then
  mirrors the edit into loaded notes (`NotesState.retagLoaded`), or the next
  save restores the old tags. Locked profiles are skipped and reported.

### Links

- `[[target#heading|alias]]` is saved verbatim. Targets come from `scan_vault`;
  `LinkIndex` resolves them by name. A link only resolves within its note's
  `linkScope` (plaintext, or one profile), so locked notes can't link outside it.
- Renames/moves go through `NoteLinksState.fixAfterMove`, which rewrites broken
  links (`rewrite_links`). Undo is the reverse move, fixed the same way.

### Properties

- Other frontmatter keys. For a `.md`, a save rewrites only keys whose value
  changed, and non-mapping frontmatter is `properties: null` and never written.
- A value that doesn't fit its vault-wide type is shown as its inferred type,
  never coerced.
- Panel edits go through the open editor as doc attributes so they share the
  note's undo history. Edits from elsewhere sync in without a history step.

### Attachments

- An attachment belongs to its profile (or to plaintext notes). Encrypting,
  decrypting or re-homing a note, and every `write_note`, copies attachments that
  belong elsewhere and re-points the link. This invariant lets
  `unused_attachments` judge without unlocking every profile.
- Never modify an attachment once written. Trash only when the user opts in.
- The link scanner (`link_sources`) skips code, so code is never rewritten.

## Encryption

A profile's password derives an Argon2id KEK that wraps a per-profile master
key; each note's content key is wrapped by the master key in the note's header.

- **The `.mntl.enc` header is the AEAD's associated data.** Never add a header
  field to existing notes; put everything else in the sealed `NoteFrontmatter`.
  `decrypt_note` must pass the header bytes *as on disk* as AAD, never a
  re-serialization (`test_decrypts_a_golden_fixture_blob` guards this).
- `.mantle/profiles.json` holds the only copy of each wrapped master key; keep the `.bak` written on every save.
- Errors from `credentials.rs` and `notes_crypto.rs` reach the on-disk log via
  `logging::logged`: never interpolate a password, key, or note content.
- Master keys never cross IPC. `read_note`/`write_note` return
  `mantle:locked:<profile-id>` for a locked profile.
- Locking must flush pending writes first (`NotesState` debounces saves).
- An encrypted note's favorite and style are sealed in the note, not in
  `state.json`, so a locked vault reveals neither.
- **Hidden notes** (`hidden.rs`): the frontend knows them only by *virtual*
  path. Resolve incoming paths with `hidden::resolve_note`, never
  `resolve_rel_path`; write through `hidden::seal_at` when a write may change
  whether or where a note is hidden. Hidden notes stay out of `state.json` and persisted tabs.
- Scope: at-rest confidentiality only, not resistance to reading process memory.

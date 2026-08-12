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
  the `mntl-core` crate.
- **`crates/mntl-core`**: standalone Rust crate (Cargo workspace member,
  independent of Tauri) implementing the `.mntl` note format — plaintext
  Markdown with a YAML frontmatter header — and the `.mntl.enc` encrypted
  envelope format (Argon2id KEK derivation, XChaCha20-Poly1305 + AES-KW
  envelope encryption). Encrypted notes can currently be listed but not
  decrypted from the frontend.

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
- Rust: `#[cfg(test)]` unit tests in `src-tauri/src/vault.rs` (path traversal, note classification); `crates/mntl-core/tests/crypto_tests.rs` covers the encryption/decryption round trip.

## Conventions

- Angular components are standalone (no NgModules); component prefix is `app`. State lives in `Injectable({ providedIn: 'root' })` services named `*-state.ts` (e.g. `VaultState`, `NotesState`, `TabsState`) built on signals/effects, not in components.
- Styling uses Tailwind CSS (`@tailwindcss/postcss`, `.postcssrc.json`) — prefer utility classes over new CSS. Theme colors are CSS custom properties in `src/styles/theme.css` (light/dark via `prefers-color-scheme`) — use those tokens (`bg-[var(--surface)]`, etc.) instead of hardcoded colors.
- Component style files are omitted (`"style": "none"` in `angular.json` schematics) — keep styling in Tailwind classes or `styles/theme.css`.
- Reusable menu UI (slash menu, context menu) is built from the shared `MenuSurface`/`MenuItem`/`MenuSeparator` components in `src/app/shared/menu/` — extend those rather than duplicating menu markup.
- Icons come from `@lucide/angular`; import only the specific `Lucide*` icons used by a component.
- Keep new Tauri commands in `src-tauri/src/lib.rs` (or split into modules under `src-tauri/src/` as the backend grows, following `vault.rs`) and register them via `invoke_handler(tauri::generate_handler![...])`. Cryptography and note-format logic belongs in `crates/mntl-core`, not `src-tauri`.

## Debugging

- Don't reach for `chromium-cli` or other unreliable/hacky tooling to debug the app.
- It's fine to run the app (`pnpm start` or `pnpm run tauri dev`) to check for errors.

# AGENTS.md

## Project overview

Mantle is a desktop app built with Tauri 2 (Rust backend) and Angular 22 (frontend).
The project is early-stage: the Rust side is still the default Tauri template
(`greet` command only), and the Angular side has a single `header` layout component.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`), not npm.

- `pnpm start` — run Angular dev server only (port 1420)
- `pnpm run tauri dev` — run the full Tauri app (Angular + Rust) in dev mode
- `pnpm run build` — production Angular build
- `pnpm test` — run Jest test suite
- `cargo check` / `cargo build` (from `src-tauri/`) — check/build the Rust backend

## Testing

- Frontend tests use Jest with `jest-preset-angular` (config in `jest.config.ts`, setup in `setup-jest.ts`).
- Test files live next to the code they test (e.g. `header.spec.ts` next to `header.ts`).
- No Rust tests exist yet; if adding Rust logic beyond simple commands, add `#[cfg(test)]` unit tests in `src-tauri/src`.

## Conventions

- Angular components are standalone (no NgModules); component prefix is `app`.
- Styling uses Tailwind CSS (`@tailwindcss/postcss`, `.postcssrc.json`) — prefer utility classes over new CSS.
- Component style files are omitted (`"style": "none"` in `angular.json` schematics) — keep styling in Tailwind classes or `styles.css`.
- Keep new Tauri commands in `src-tauri/src/lib.rs` (or split into modules under `src-tauri/src/` as the backend grows) and register them via `invoke_handler(tauri::generate_handler![...])`.

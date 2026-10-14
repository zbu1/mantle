# Mantle

A desktop note-taking app for a vault of Markdown notes, with optional
encryption. Built with Tauri 2 and Angular.

> **Work in progress:** Mantle is early-stage software. Keep backups of your vault.

## Encryption

Notes can be encrypted under a password-protected profile. Encrypted notes and
their images are unreadable on disk without the password. Filenames are not
encrypted.

`.mantle/profiles.json` in the vault holds each profile's keys. If you lose it,
the encrypted notes can't be recovered, even with the right password. Back it up.

## Build & run

Requires [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/),
[Rust](https://rustup.rs/), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install
pnpm run tauri dev     # run the app in dev mode
pnpm run tauri build   # build a release bundle
pnpm test              # frontend tests
cargo test             # Rust tests
```

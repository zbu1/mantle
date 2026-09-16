import { installTauriMock } from './tauri-mock';

export interface FixtureNote {
  id: string;
  title: string;
  content: string;
}

export const FIXTURE_NOTES: FixtureNote[] = [
  {
    id: 'daily-standup',
    title: 'daily-standup',
    content: 'Yesterday: shipped the sidebar resize handle. Today: tab strip. Blockers: none.',
  },
  {
    id: 'architecture-notes',
    title: 'architecture-notes',
    content: 'Notes on the layout shell: header, sidebar, and the tabbed content area.',
  },
  {
    id: 'todo',
    title: 'todo',
    content: '- Wire up sidebar clicks to open tabs\n- Persist open tabs\n- Empty state for no tabs',
  },
];

/**
 * Installs the `window.__TAURI_INTERNALS__` stub (see `tauri-mock.ts`) and
 * overrides its `invoke` handler to serve `FIXTURE_NOTES` out of an
 * in-memory map, standing in for the Rust vault commands (`scan_vault`,
 * `read_note`, `write_note`, `create_note`) in tests.
 */
export function installMockVaultInvoke(): jest.Mock {
  const { invoke } = installTauriMock();
  const contents = new Map(FIXTURE_NOTES.map((n) => [n.id, n.content]));

  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'read_note': {
        const relPath = args['relPath'] as string;
        if (!contents.has(relPath)) throw new Error(`Note not found: ${relPath}`);
        return contents.get(relPath);
      }
      case 'write_note': {
        contents.set(args['relPath'] as string, args['content'] as string);
        return undefined;
      }
      case 'scan_vault': {
        return {
          type: 'folder',
          name: 'vault',
          relPath: '',
          children: FIXTURE_NOTES.map((n) => ({
            type: 'note',
            name: n.title,
            relPath: n.id,
            encrypted: false,
            profile: null,
          })),
        };
      }
      case 'create_note': {
        const name = args['name'] as string;
        const relDir = args['relDir'] as string;
        const relPath = relDir ? `${relDir}/${name}.mntl` : `${name}.mntl`;
        contents.set(relPath, '');
        return { name, relPath };
      }
      case 'rename_note': {
        const relPath = args['relPath'] as string;
        const newName = args['newName'] as string;
        if (!contents.has(relPath)) throw new Error(`Note not found: ${relPath}`);
        const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
        const newRelPath = `${dir}${newName}`;
        if (newRelPath !== relPath && contents.has(newRelPath)) {
          throw new Error(`A note named "${newName}" already exists in this folder`);
        }
        const content = contents.get(relPath)!;
        contents.delete(relPath);
        contents.set(newRelPath, content);
        return { name: newName, relPath: newRelPath };
      }
      case 'start_vault_watch':
      case 'stop_vault_watch':
        return undefined;
      // `@tauri-apps/api/path`'s `join()`, used to resolve a note's full
      // filesystem location for display.
      case 'plugin:path|join': {
        const paths = args['paths'] as string[];
        return paths.join('/');
      }
      // Credential profiles: a vault with none. Present so that any component
      // pulling in CredentialsState doesn't trip the `default` throw below.
      case 'list_credential_profiles':
        return [];
      case 'lock_credential_profile':
      case 'lock_all_credential_profiles':
        return undefined;
      case 'plugin:event|listen':
        return 0;
      case 'plugin:event|unlisten':
        return undefined;
      default:
        throw new Error(`Unhandled mock invoke command: ${command}`);
    }
  });

  return invoke;
}

/** Waits a macrotask tick so pending promise chains (e.g. async invoke mocks) settle. */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
            locked: false,
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

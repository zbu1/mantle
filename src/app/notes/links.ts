import { VaultFolderNode, VaultNoteNode, dirOf, flattenAllNotes } from './vault-tree.model';

/** A note's path without its extension: how a path-style `[[link]]` names it. */
export function linkPath(relPath: string): string {
  return relPath.replace(/(\.mntl\.enc|\.mntl|\.md|\.markdown)$/i, '');
}

/** Whether a `[[link]]` target that leads to no note names a file instead, by its extension. */
export function isFileLink(target: string): boolean {
  return /\.[a-z0-9]+$/i.test(target);
}

/** The parts of a wikilink's inner text, `target#heading|alias`. */
export function splitLink(inner: string): { target: string; heading: string | null; alias: string | null } {
  const bar = inner.indexOf('|');
  const alias = bar < 0 ? null : inner.slice(bar + 1);
  const ref = bar < 0 ? inner : inner.slice(0, bar);
  const hash = ref.indexOf('#');
  return { target: (hash < 0 ? ref : ref.slice(0, hash)).trim(), heading: hash < 0 ? null : ref.slice(hash + 1), alias };
}

/**
 * The notes a note's links can lead to: plaintext notes link among
 * themselves, and each profile's notes among theirs, so a locked profile's
 * notes never hold a link to anything outside it.
 */
export function linkScope(note: Pick<VaultNoteNode, 'encrypted' | 'profile'>): string | null {
  return note.encrypted ? `profile:${note.profile}` : null;
}

/** One link rewrite for the backend's `rewrite_links`. */
export interface LinkRewrite {
  note: string;
  from: string;
  to: string;
}

/**
 * Which note a `[[link]]` leads to, by name the way other Markdown vaults
 * resolve them: a full path matches exactly, a partial path matches the end
 * of one, and a bare name matches every note with that name, preferring one
 * in the linking note's folder, then the shortest path.
 */
export class LinkIndex {
  readonly notes: VaultNoteNode[];
  private readonly byName = new Map<string, VaultNoteNode[]>();
  private readonly byPath = new Map<string, VaultNoteNode>();
  private readonly byRelPath = new Map<string, VaultNoteNode>();

  constructor(tree: VaultFolderNode | null) {
    this.notes = tree ? flattenAllNotes(tree) : [];
    for (const note of this.notes) {
      const path = linkPath(note.relPath).toLowerCase();
      const name = path.slice(path.lastIndexOf('/') + 1);
      this.byName.set(name, [...(this.byName.get(name) ?? []), note]);
      this.byPath.set(path, note);
      this.byRelPath.set(note.relPath, note);
    }
  }

  note(relPath: string): VaultNoteNode | null {
    return this.byRelPath.get(relPath) ?? null;
  }

  /** The `linkScope` of the note at `relPath`, which may not be scanned yet. */
  scopeOf(relPath: string): string | null {
    const note = this.byRelPath.get(relPath);
    return note ? linkScope(note) : relPath.endsWith('.mntl.enc') ? 'profile:?' : null;
  }

  /** The note `target` leads to from the note at `from`, or null. Only notes in `from`'s `linkScope` count. */
  resolve(target: string, from: string): VaultNoteNode | null {
    const path = linkPath(target.trim().replace(/\\/g, '/').replace(/^\/+/, '')).toLowerCase();
    if (!path) return null;
    const scope = this.scopeOf(from);
    const exact = this.byPath.get(path);
    if (exact && linkScope(exact) === scope) return exact;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const candidates = (this.byName.get(name) ?? []).filter((note) => {
      const notePath = linkPath(note.relPath).toLowerCase();
      return linkScope(note) === scope && (!path.includes('/') || notePath === path || notePath.endsWith(`/${path}`));
    });
    if (candidates.length <= 1) return candidates[0] ?? null;
    const dir = dirOf(from);
    return (
      candidates.find((note) => dirOf(note.relPath) === dir) ??
      [...candidates].sort((a, b) => a.relPath.length - b.relPath.length || a.relPath.localeCompare(b.relPath))[0]
    );
  }

  /**
   * The shortest link text that leads to `note` from anywhere in its scope: its
   * name, or its path if another note there shares the name.
   */
  linkText(note: VaultNoteNode): string {
    const path = linkPath(note.relPath);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const namesakes = (this.byName.get(name.toLowerCase()) ?? []).filter((other) => linkScope(other) === linkScope(note));
    return namesakes.length > 1 ? path : name;
  }

  /** The notes with a link that leads to `relPath`. */
  backlinks(relPath: string): VaultNoteNode[] {
    return this.notes.filter(
      (note) => note.relPath !== relPath && note.links?.some((target) => this.resolve(target, note.relPath)?.relPath === relPath),
    );
  }
}

/**
 * The link rewrites that keep every link leading where it did, after notes
 * moved from the vault `before` to `after` (`moved` maps an old path to its
 * new one). A link is rewritten only if it now leads somewhere else, or
 * nowhere.
 */
export function linkFixes(before: LinkIndex, after: LinkIndex, moved: (relPath: string) => string): LinkRewrite[] {
  const fixes: LinkRewrite[] = [];
  for (const note of before.notes) {
    const source = moved(note.relPath);
    if (!note.links?.length || !after.note(source)) continue;
    for (const target of note.links) {
      const was = before.resolve(target, note.relPath);
      const want = was && after.note(moved(was.relPath));
      if (!want || after.resolve(target, source)?.relPath === want.relPath) continue;
      fixes.push({ note: source, from: target, to: after.linkText(want) });
    }
  }
  return fixes;
}

import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../../core/logger';
import { DialogState } from '../../shared/dialog/dialog-state';
import { FavoritesState } from '../favorites-state';
import { NotesState, titleFromRelPath } from '../notes-state';
import { TabsState } from '../tabs-state';
import { VaultActions } from '../vault-actions';
import { VaultHistoryState, canUndoDelete } from '../vault-history-state';
import { VaultMetaState } from '../vault-meta-state';
import { VaultState } from '../vault-state';
import { VaultNoteNode, dirOf, fileNameOf, flattenTreeNodes } from '../vault-tree.model';

/** Where converted notes' attachments go. Mirrors `Placement` in `export.rs`. */
export type Placement =
  | { kind: 'subfolder'; name: string }
  | { kind: 'nextToNote' }
  | { kind: 'vaultRoot' }
  | { kind: 'folder'; path: string };

interface Failure {
  relPath: string;
  error: string;
}

/** Mirrors `ToMarkdownReport` in `export.rs`. */
interface ToMarkdownReport {
  converted: { from: string; name: string; relPath: string }[];
  failed: Failure[];
  locked: string[];
  created: string[];
  removed: string[];
}

/** Mirrors `ExportReport` in `export.rs`. */
interface ExportReport {
  notes: number;
  files: number;
  locked: { relPath: string; profile: string }[];
  renamed: { from: string; to: string }[];
  failed: Failure[];
}

export type MarkdownExportRequest = { mode: 'convert'; notes: readonly VaultNoteNode[] } | { mode: 'export' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Turning Mantle notes back into plain Markdown: converting some in place, or
 * exporting a Markdown copy of the whole vault. Drives the modal that picks
 * where attachments go (`MarkdownExportModal`, rendered once at the layout
 * root) and runs what it confirms.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownExportState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  private readonly history = inject(VaultHistoryState);
  private readonly vaultActions = inject(VaultActions);
  private readonly dialogState = inject(DialogState);

  readonly request = signal<MarkdownExportRequest | null>(null);

  openConvert(notes: readonly VaultNoteNode[]): void {
    if (notes.length > 0) this.request.set({ mode: 'convert', notes });
  }

  openExport(): void {
    if (this.vaultState.rootPath()) this.request.set({ mode: 'export' });
  }

  close(): void {
    this.request.set(null);
  }

  /**
   * Convert `notes` to Markdown files beside them as one undo step, asking
   * whether to rename or skip each one whose `.md` name is taken. Failures,
   * and notes left out as locked, are reported after.
   */
  async convert(notes: readonly VaultNoteNode[], placement: Placement, removeUnused: boolean): Promise<void> {
    const tree = this.vaultState.tree();
    if (!tree) return;
    const taken = new Set(flattenTreeNodes(tree).keys());
    const requests: { relPath: string; name: string | null }[] = [];
    for (const note of notes) {
      const dir = dirOf(note.relPath);
      const pathOf = (name: string) => (dir ? `${dir}/${name}.md` : `${name}.md`);
      let name: string | null = null;
      if (taken.has(pathOf(note.name))) {
        const choice = await this.dialogState.choose(
          `"${pathOf(note.name)}" already exists, so "${note.name}" can't be converted under its own name.`,
          { title: 'File Already Exists', confirmLabel: 'Rename', altLabel: 'Skip', cancelLabel: 'Cancel All' },
        );
        if (choice === null) return;
        if (choice === 'alt') continue;
        let n = 2;
        while (taken.has(pathOf(`${note.name} ${n}`))) n++;
        name = `${note.name} ${n}`;
      }
      taken.add(pathOf(name ?? note.name));
      requests.push({ relPath: note.relPath, name });
    }
    // A sealed favorite goes with the note's ciphertext; a plaintext file's lives in state.json.
    const sealedFavorites = new Set(notes.filter((n) => n.encrypted && this.favorites.isFavorite(n.relPath)).map((n) => n.relPath));

    let report: ToMarkdownReport;
    try {
      report = await this.runConvert(requests, placement, removeUnused, sealedFavorites);
    } catch (err) {
      logError(`Failed to convert notes to Markdown: ${formatError(err)}`);
      await this.dialogState.alert(formatError(err), { title: 'Conversion Failed', tone: 'error' });
      return;
    }
    await this.reportConversion(report);
    // Undoing restores the originals from the trash, which macOS can't do.
    const done = report.converted;
    if (done.length === 0 || !canUndoDelete) return;
    this.history.record({
      label: done.length === 1 ? `Convert "${done[0].name}" to Markdown` : `Convert ${done.length} Notes to Markdown`,
      paths: done.flatMap((c) => [c.from, c.relPath]),
      undo: async () => {
        await this.notesState.flushPending(done.map((c) => c.relPath));
        for (const relPath of [...done.map((c) => c.relPath), ...report.created]) await this.vaultState.deleteNote(relPath);
        await this.vaultActions.restore([...done.map((c) => c.from), ...report.removed]);
        for (const c of done) this.follow(c.relPath, c.from);
      },
      redo: async () => {
        const redone = await this.runConvert(
          done.map((c) => ({ relPath: c.from, name: c.name })),
          placement,
          removeUnused,
          sealedFavorites,
        );
        return redone.failed.length === 0 && redone.locked.length === 0;
      },
    });
  }

  private async runConvert(
    notes: { relPath: string; name: string | null }[],
    placement: Placement,
    removeUnused: boolean,
    sealedFavorites: ReadonlySet<string>,
  ): Promise<ToMarkdownReport> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) throw new Error('No vault is open.');
    await this.notesState.flushPending(notes.map((n) => n.relPath));
    const report = await invoke<ToMarkdownReport>('convert_to_markdown', { vaultRoot, notes, placement, removeUnused });
    for (const c of report.converted) {
      this.follow(c.from, c.relPath);
      if (sealedFavorites.has(c.from)) this.vaultMeta.addFavorites([c.relPath]);
      logInfo(`Converted "${c.from}" to "${c.relPath}"`);
    }
    if (report.removed.length > 0) logInfo(`Moved ${report.removed.length} attachments no note uses any more to the trash`);
    for (const f of report.failed) logError(`Failed to convert "${f.relPath}" to Markdown: ${f.error}`);
    await this.vaultState.refresh();
    return report;
  }

  private async reportConversion(report: ToMarkdownReport): Promise<void> {
    const lines = [
      ...report.failed.map((f) => `${fileNameOf(f.relPath)}: ${f.error}`),
      ...report.locked.map((relPath) => `${fileNameOf(relPath)}: its profile is locked, so it was left as it is.`),
    ];
    if (lines.length === 0) return;
    await this.dialogState.alert(lines.join('\n'), {
      title: report.converted.length === 0 ? 'Nothing Converted' : `${plural(lines.length, 'Note')} Not Converted`,
      tone: report.failed.length > 0 ? 'error' : 'warning',
    });
  }

  /** Write a Markdown copy of the vault to `dest`, then say what was and wasn't included. */
  async export(dest: string, placement: Placement): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) throw new Error('No vault is open.');
    await this.notesState.flushPending();
    const report = await invoke<ExportReport>('export_vault', { vaultRoot, dest, placement });
    logInfo(`Exported ${report.notes} notes and ${report.files} files to "${dest}"`);
    for (const f of report.failed) logError(`Failed to export "${f.relPath}": ${f.error}`);

    const sections = [`${plural(report.notes, 'note')} and ${plural(report.files, 'other file')} written to ${dest}.`];
    if (report.locked.length > 0) {
      sections.push(
        `Left out, as their profiles are locked:\n` +
          report.locked.map((l) => `${l.relPath} (${l.profile})`).join('\n'),
      );
    }
    if (report.renamed.length > 0) {
      sections.push(`Renamed, as another file had the path:\n` + report.renamed.map((r) => `${r.from} → ${r.to}`).join('\n'));
    }
    if (report.failed.length > 0) {
      sections.push(`Failed:\n` + report.failed.map((f) => `${f.relPath}: ${f.error}`).join('\n'));
    }
    await this.dialogState.alert(sections.join('\n\n'), {
      title: report.failed.length > 0 ? 'Export Finished With Errors' : 'Export Finished',
      tone: report.failed.length > 0 ? 'error' : report.locked.length > 0 ? 'warning' : 'default',
    });
  }

  /** Points loaded notes, tabs and `state.json` at a note's new path. */
  private follow(from: string, to: string): void {
    this.notesState.renameNoteId(from, to);
    this.notesState.reload(to);
    this.tabsState.renameNoteId(from, to, titleFromRelPath(to));
    this.vaultMeta.renameNote(from, to);
  }
}

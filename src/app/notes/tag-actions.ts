import { Injectable, inject } from '@angular/core';
import { DialogState } from '../shared/dialog/dialog-state';
import { normalizeTag, TAG_RULES } from './tags';
import { TagEditReport, TagsState } from './tags-state';

/** Vault-wide tag edits behind their dialogs, for the sidebar's tag rows and the editor's tag chips. */
@Injectable({ providedIn: 'root' })
export class TagActions {
  private readonly tagsState = inject(TagsState);
  private readonly dialogState = inject(DialogState);

  async rename(name: string): Promise<void> {
    const to = await this.dialogState.prompt(
      `Rename #${name} in every note that has it. Renaming it to a tag that already exists merges the two.`,
      { title: 'Rename Tag', confirmLabel: 'Rename', initialValue: name, placeholder: 'tag' },
    );
    if (to === null || to.trim() === name) return;
    const normalized = normalizeTag(to);
    if (!normalized) {
      await this.dialogState.alert(`"${to.trim()}" isn't a valid tag. ${TAG_RULES}.`, { title: 'Rename Failed', tone: 'error' });
      return;
    }
    try {
      await this.reportLockedSkips(await this.tagsState.renameTag(name, normalized), 'renamed');
    } catch (err) {
      await this.dialogState.alert(err instanceof Error ? err.message : String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  async remove(name: string, noteCount: number): Promise<void> {
    const confirmed = await this.dialogState.confirm(
      `Remove #${name} from ${noteCount === 1 ? '1 note' : `${noteCount} notes`}? The notes themselves are kept.`,
      { title: 'Remove Tag', tone: 'warning', confirmLabel: 'Remove Tag' },
    );
    if (!confirmed) return;
    try {
      await this.reportLockedSkips(await this.tagsState.removeTag(name), 'removed');
    } catch (err) {
      await this.dialogState.alert(err instanceof Error ? err.message : String(err), { title: 'Remove Failed', tone: 'error' });
    }
  }

  /** Locked notes can't be read, so a vault-wide tag edit can't reach them; say so rather than imply it did. */
  private async reportLockedSkips(report: TagEditReport, verb: string): Promise<void> {
    const skipped = report.lockedSkipped;
    if (skipped === 0) return;
    await this.dialogState.alert(
      `The tag was ${verb} in ${report.updated.length === 1 ? '1 note' : `${report.updated.length} notes`}, but ` +
        `${skipped === 1 ? '1 encrypted note is' : `${skipped} encrypted notes are`} in a locked profile and ` +
        `couldn't be checked. Unlock ${skipped === 1 ? 'its profile' : 'their profiles'} and do this again to include ${skipped === 1 ? 'it' : 'them'}.`,
      { title: 'Some Notes Were Skipped', tone: 'warning' },
    );
  }
}

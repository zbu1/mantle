import { Command, EditorState, Plugin, TextSelection, Transaction } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import {
  TableMap,
  addColumnAfter,
  addColumnBefore,
  addRow,
  addRowAfter,
  addRowBefore,
  cellAround,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  selectedRect,
  tableEditing,
} from 'prosemirror-tables';
import { ContextMenuFlatItem } from '../../../../shared/context-menu/context-menu.model';
import { schema } from '../schema';

const { table, table_row: tableRow, table_cell: tableCell } = schema.nodes;

type Align = 'left' | 'center' | 'right';

/** Adds a row at the end of the selection's table, with the cursor in its cell under `col`. */
function appendRow(state: EditorState, col: number): Transaction {
  const rect = selectedRect(state);
  const tr = addRow(state.tr, rect, rect.map.height);
  const map = TableMap.get(tr.doc.nodeAt(rect.tableStart - 1)!);
  return tr.setSelection(TextSelection.create(tr.doc, rect.tableStart + map.map[(map.height - 1) * map.width + col] + 1));
}

/** Tab: the next cell, or a new row from the last one. Shift-Tab: the previous cell. */
export const goToCell =
  (direction: 1 | -1): Command =>
  (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (goToNextCell(direction)(state, dispatch) || direction < 0) return true;
    dispatch?.(appendRow(state, 0).scrollIntoView());
    return true;
  };

/** Enter: the cell below, or a new row from the last one. A cell holds one line. */
export const cellBelow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  const rect = selectedRect(state);
  if (rect.bottom === rect.map.height) return dispatch(appendRow(state, rect.left).scrollIntoView()), true;
  const pos = rect.tableStart + rect.map.map[rect.bottom * rect.map.width + rect.left] + 1;
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
  return true;
};

/** A 3-column table, a header row and one body row, with the cursor in its first cell. */
export function insertTable(view: EditorView): void {
  if (isInTable(view.state)) return;
  const row = () => tableRow.create(null, [tableCell.create(), tableCell.create(), tableCell.create()]);
  const { from } = view.state.selection;
  const tr = view.state.tr.replaceSelectionWith(table.create(null, [row(), row()]));
  let at = -1;
  tr.doc.nodesBetween(from, tr.doc.content.size, (node, pos) => {
    if (at < 0 && node.type === table) at = pos;
    return at < 0;
  });
  if (at >= 0) tr.setSelection(TextSelection.create(tr.doc, at + 3));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** The alignment of the selection's column, and a command setting it (null clears it). */
function columnAlign(view: EditorView): { current: Align | null; set: (align: Align | null) => void } {
  const $cell = cellAround(view.state.selection.$from);
  return {
    current: $cell?.nodeAfter?.attrs['align'] ?? null,
    set: (align) => {
      const $at = cellAround(view.state.selection.$from);
      if (!$at) return;
      const node = $at.node(-1);
      const start = $at.start(-1);
      const map = TableMap.get(node);
      const col = map.colCount($at.pos - start);
      const tr = view.state.tr;
      for (let row = 0; row < map.height; row++) {
        const pos = map.map[row * map.width + col];
        tr.setNodeMarkup(start + pos, null, { ...node.nodeAt(pos)!.attrs, align });
      }
      view.dispatch(tr);
    },
  };
}

/** The table actions for the selection's cell: its row's, its column's, or (`table`) all of them. */
export function tableMenu(view: EditorView, part: 'row' | 'column' | 'table'): ContextMenuFlatItem[] {
  const run = (command: Command) => () => {
    command(view.state, view.dispatch);
    view.focus();
  };
  const align = columnAlign(view);
  const alignItem = (label: string, value: Align): ContextMenuFlatItem => ({
    kind: 'item',
    label,
    checked: align.current === value,
    // Again to clear it.
    action: () => (align.set(align.current === value ? null : value), view.focus()),
  });
  const row: ContextMenuFlatItem[] = [
    { kind: 'item', label: 'Insert Row Above', action: run(addRowBefore) },
    { kind: 'item', label: 'Insert Row Below', action: run(addRowAfter) },
  ];
  const column: ContextMenuFlatItem[] = [
    { kind: 'item', label: 'Insert Column Left', action: run(addColumnBefore) },
    { kind: 'item', label: 'Insert Column Right', action: run(addColumnAfter) },
    { kind: 'separator' },
    alignItem('Align Left', 'left'),
    alignItem('Align Center', 'center'),
    alignItem('Align Right', 'right'),
  ];
  const deleteRowItem: ContextMenuFlatItem = { kind: 'item', label: 'Delete Row', icon: 'delete', danger: true, action: run(deleteRow) };
  const deleteColumnItem: ContextMenuFlatItem = { kind: 'item', label: 'Delete Column', icon: 'delete', danger: true, action: run(deleteColumn) };
  if (part === 'row') return [...row, { kind: 'separator' }, deleteRowItem];
  if (part === 'column') return [...column, { kind: 'separator' }, deleteColumnItem];
  return [
    ...row,
    { kind: 'separator' },
    ...column,
    { kind: 'separator' },
    deleteRowItem,
    deleteColumnItem,
    { kind: 'item', label: 'Delete Table', icon: 'delete', danger: true, action: run(deleteTable) },
  ];
}

/** Keeps every cell of a column at the column's alignment, so new rows and columns follow it. */
function alignColumns(tr: Transaction): void {
  tr.doc.descendants((node, pos) => {
    if (node.type !== table) return !node.isTextblock;
    const map = TableMap.get(node);
    for (let col = 0; col < map.width; col++) {
      const cells = Array.from({ length: map.height }, (_, row) => map.map[row * map.width + col]);
      const align = cells.map((cell) => node.nodeAt(cell)!.attrs['align']).find(Boolean) ?? null;
      for (const cell of cells) {
        const attrs = node.nodeAt(cell)!.attrs;
        if (attrs['align'] !== align) tr.setNodeMarkup(pos + 1 + cell, null, { ...attrs, align });
      }
    }
    return false;
  });
}

/** Cell selection and table repair (prosemirror-tables), and column alignment. Near the end of the plugins, as it handles mouse and arrow keys broadly. */
export function tablePlugins(): Plugin[] {
  return [
    tableEditing(),
    new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const tr = state.tr;
        alignColumns(tr);
        return tr.docChanged ? tr : null;
      },
    }),
  ];
}

/**
 * A table, scrolling sideways when wide, with a handle on the hovered cell's
 * row and column that opens that row's or column's menu.
 */
export class TableView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly handles: HTMLElement[];
  private cell: HTMLElement | null = null;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly menu: (event: MouseEvent, part: 'row' | 'column') => void,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'md-table';
    const scroller = document.createElement('div');
    scroller.className = 'md-table-scroll';
    this.table = document.createElement('table');
    this.contentDOM = document.createElement('tbody');
    this.table.append(this.contentDOM);
    scroller.append(this.table);
    this.handles = [this.handle('row'), this.handle('column')];
    this.dom.append(scroller, ...this.handles);
    this.dom.addEventListener('mouseover', (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('td, th');
      if (cell && this.contentDOM.contains(cell)) this.show(cell);
    });
    this.dom.addEventListener('mouseleave', () => this.dom.removeAttribute('data-hover'));
    scroller.addEventListener('scroll', () => this.cell && this.show(this.cell));
  }

  private handle(part: 'row' | 'column'): HTMLElement {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.contentEditable = 'false';
    handle.className = `md-table-handle md-table-handle-${part}`;
    handle.title = part === 'row' ? 'Row' : 'Column';
    // Keeps the editor's focus and selection.
    handle.addEventListener('mousedown', (event) => event.preventDefault());
    handle.addEventListener('click', (event) => {
      if (!this.cell?.isConnected) return;
      const pos = this.view.posAtDOM(this.cell, 0);
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos)));
      this.view.focus();
      this.menu(event, part);
    });
    return handle;
  }

  private show(cell: HTMLElement): void {
    this.cell = cell;
    const box = this.dom.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    const whole = this.table.getBoundingClientRect();
    const [row, column] = this.handles;
    row.style.top = `${at.top - box.top + at.height / 2}px`;
    row.style.left = `${whole.left - box.left}px`;
    column.style.top = `${whole.top - box.top}px`;
    column.style.left = `${at.left - box.left + at.width / 2}px`;
    this.dom.setAttribute('data-hover', '');
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    return true;
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    return this.handles.includes(event.target as HTMLElement);
  }
}

import { Injectable, signal } from '@angular/core';

export interface ActiveMarks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
}

const DEFAULT_MARKS: ActiveMarks = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
};

@Injectable({ providedIn: 'root' })
export class BubbleMenuState {
  readonly activeMarks = signal<ActiveMarks>(DEFAULT_MARKS);

  setActiveMarks(marks: ActiveMarks): void {
    this.activeMarks.set(marks);
  }
}

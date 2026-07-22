import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Settings } from './settings';

describe('Settings', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Settings],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(Settings);
    expect(fixture.componentInstance).toBeTruthy();
  });
});

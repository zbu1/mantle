import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MainLayout } from './main-layout';

describe('MainLayout', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MainLayout],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(MainLayout);
    expect(fixture.componentInstance).toBeTruthy();
  });
});

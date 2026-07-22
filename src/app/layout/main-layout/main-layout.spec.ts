import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { MainLayout } from './main-layout';

describe('MainLayout', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MainLayout],
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(MainLayout);
    expect(fixture.componentInstance).toBeTruthy();
  });
});

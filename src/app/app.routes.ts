import { Routes } from '@angular/router';
import { MainLayout } from './layout/main-layout/main-layout';
import { Home } from './pages/home/home';
import { Settings } from './pages/settings/settings';
import { Note } from './pages/note/note'

export const routes: Routes = [
  {
    path: '',
    component: MainLayout,
    children: [
      { path: '', component: Home, title: 'Home' },
      { path: 'settings', component: Settings, title: 'Settings' },
      { path: 'note', component: Note, title: 'Note' },
    ],
  },
];

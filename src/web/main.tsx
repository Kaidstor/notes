import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import Editor from './Editor.tsx';
import { applyTheme, currentTheme } from './lib/themes.ts';
import './styles.css';

applyTheme(currentTheme());

const edit = /^\/([0-9a-fA-F-]{36})\/edit\/?$/.exec(location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{edit ? <Editor uuid={edit[1]!} /> : <App />}</StrictMode>,
);

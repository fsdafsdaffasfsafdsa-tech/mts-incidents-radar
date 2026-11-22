import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Радар можно установить приложением (Chrome: «Установить приложение» в адресной строке). Установленному приложению
// браузер разрешает звук сразу — Джарвис говорит без первого щелчка. Только на проде: в разработке мешал бы Vite.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { HubProvider } from './app/hub-context';
import { initAppearance } from './app/appearance';
import { router } from './app/router';
import './styles/tokens.css';
import '@xyflow/react/dist/base.css';
import './styles/app.css';
import './styles/graph.css';
import './styles/screens.css';
import './styles/ci.css';

initAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HubProvider>
      <RouterProvider router={router} />
    </HubProvider>
  </StrictMode>,
);

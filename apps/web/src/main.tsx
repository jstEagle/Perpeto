import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { HubProvider } from './app/hub-context';
import { router } from './app/router';
import './styles/tokens.css';
import '@xyflow/react/dist/base.css';
import './styles/app.css';
import './styles/graph.css';
import './styles/screens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HubProvider>
      <RouterProvider router={router} />
    </HubProvider>
  </StrictMode>,
);

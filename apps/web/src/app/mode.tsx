import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Project } from '../api/types';
import { useResource } from './hub-context';

/**
 * Observe-only mode: the hub has no projects, so Perpeto only watches the
 * operator's T3 Code sessions and subscriptions. The app opens on the
 * factory home and hides project navigation (workflows, runs, work, merge
 * queue). `observe` is undefined until the project list has loaded, so
 * neither navigation flashes in.
 */
interface AppMode {
  observe: boolean | undefined;
  projects: Project[] | undefined;
}

const ModeContext = createContext<AppMode>({ observe: undefined, projects: undefined });

export function AppModeProvider({ children }: { children: ReactNode }) {
  const projects = useResource((api) => api.listProjects(), [], (e) => e.subject.kind === 'project');
  // A hub that can't list projects still observes; treat an error as no projects.
  const list = projects.data ?? (projects.error ? [] : undefined);
  return <ModeContext.Provider value={{ observe: list ? list.length === 0 : undefined, projects: list }}>{children}</ModeContext.Provider>;
}

export const useAppMode = () => useContext(ModeContext);

import { Outlet } from '@tanstack/react-router';

/** Project screens share the shell's sidebar; this route only scopes them. */
export function ProjectLayout() {
  return <Outlet />;
}

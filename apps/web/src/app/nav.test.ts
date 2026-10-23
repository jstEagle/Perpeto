import { describe, expect, it } from 'vitest';
import { activeNav, FACTORY_NAV_ENTRIES, HOME_NAV_ENTRY, projectNavEntries } from './nav';

const entries = [...projectNavEntries('prj_1'), ...FACTORY_NAV_ENTRIES];
/** Items that would show as current for a path: must be one for every page in a section. */
const current = (path: string) => entries.filter((e) => e.key === activeNav(path)).map((e) => e.key);

describe('sidebar', () => {
  it.each([
    ['/projects/prj_1', 'overview'],
    ['/projects/prj_1/', 'overview'],
    ['/projects/prj_1/workflows', 'workflows'],
    ['/projects/prj_1/workflows/wf_1', 'workflows'],
    ['/projects/prj_1/workflows/wf_1/edit', 'workflows'],
    ['/projects/prj_1/runs', 'runs'],
    ['/projects/prj_1/runs/run_1', 'runs'],
    ['/projects/prj_1/work', 'work'],
    ['/projects/prj_1/messages', 'messages'],
    ['/projects/prj_1/merge-queue', 'merge'],
    ['/projects/prj_1/ci', 'ci'],
    ['/projects/prj_1/ci/plr_1', 'ci'],
    ['/sessions', 'sessions'],
    ['/machines', 'machines'],
    ['/accounts', 'accounts'],
    ['/pacing', 'pacing'],
    ['/usage', 'usage'],
  ])('marks exactly one item current on %s', (path, key) => {
    expect(current(path)).toEqual([key]);
  });

  it('marks Home current on / in observe-only mode', () => {
    const observe = [HOME_NAV_ENTRY, ...FACTORY_NAV_ENTRIES];
    expect(observe.filter((e) => e.key === activeNav('/')).map((e) => e.key)).toEqual(['home']);
    expect(observe.filter((e) => e.key === activeNav('/sessions')).map((e) => e.key)).toEqual(['sessions']);
  });

  it('puts Sessions first under Factory', () => {
    expect(FACTORY_NAV_ENTRIES[0].key).toBe('sessions');
  });

  it.each(['/', '/settings', '/nowhere', '/projects/prj_1/unknown'])('marks nothing current on %s', (path) => {
    expect(current(path)).toEqual([]);
  });

  it('does not confuse Work with Workflows', () => {
    expect(activeNav('/projects/prj_1/workflows')).toBe('workflows');
    expect(activeNav('/projects/prj_1/work')).toBe('work');
  });
});

import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, relative, isAbsolute } from 'node:path';

/** No inherited environment: even PATH and HOME come from local configuration/our workspace. */
export function jobEnvironment(workspace, path) {
  const home = join(workspace, 'home');
  const temp = join(workspace, 'tmp');
  return { PATH: (path ?? [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']).join(delimiter),
    HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

/** Filesystem denial is inherited by descendants. Unsupported hosts fail closed. */
export async function jobSandbox(workspace, protectedPaths = []) {
  const home = homedir();
  const defaults = ['.perpeto', '.t3', '.codex', '.claude', '.claude.json', '.config', '.ssh', '.aws', '.azure', '.kube',
    'Library/Keychains', 'Library/Application Support/Perpeto', 'Library/Application Support/T3 Code'];
  const paths = new Set();
  for (const input of [...defaults.map(path => join(home, path)), ...protectedPaths]) {
    if (!input) continue;
    const path = resolve(input);
    paths.add(path);
    try { paths.add(await realpath(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const work = await realpath(workspace);
  for (const path of paths) {
    const child = relative(path, work);
    if (!child || (!child.startsWith('..') && !isAbsolute(child))) throw new Error('CI workspace overlaps a protected directory.');
  }
  await Promise.all(['home', 'tmp'].map(path => mkdir(join(workspace, path), { mode: 0o700 })));
  if (process.platform === 'darwin') {
    await access('/usr/bin/sandbox-exec', constants.X_OK);
    const filters = [...paths].flatMap(path => [`(literal ${JSON.stringify(path)})`, `(subpath ${JSON.stringify(path)})`]).join(' ');
    const profile = `(version 1)(allow default)(deny file-read* file-write* ${filters})(deny process-info* (target others))(deny signal (target others))`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh'] };
  }
  if (process.platform === 'linux') {
    await access('/usr/bin/bwrap', constants.X_OK);
    const args = ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--ro-bind', '/', '/',
      '--proc', '/proc', '--dev', '/dev', '--bind', workspace, workspace];
    // Mount over the real targets, including symlink destinations. Host mounts stay read-only.
    for (const path of paths) {
      let info;
      try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      args.push(...(info.isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]));
    }
    return { command: '/usr/bin/bwrap', args: [...args, '--', '/bin/sh'] };
  }
  throw new Error('CI requires a supported filesystem sandbox.');
}

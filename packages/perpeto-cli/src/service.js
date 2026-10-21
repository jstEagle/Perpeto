import { readFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { repoRoot, writeNew, privateDir, readJson, configPath } from './config.js';
import { control } from './process.js';

const xml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const systemd = (value, expandEnvironment = false) => `"${value.replaceAll('%', '%%').replaceAll('$', () => expandEnvironment ? '$$' : '$').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
export async function generateService({ role, dir, platform = process.platform, home = homedir(), node = process.execPath, path = process.env.PATH ?? '' }) {
  if (!['hub', 'node'].includes(role) || !['darwin', 'linux'].includes(platform)) throw new Error('Services support hub/node on macOS and Linux.');
  const label = `com.perpeto.${role}`;
  const values = { label, role, dir: resolve(dir), node, bin: resolve(repoRoot, 'packages/perpeto-cli/bin/perpeto.js'),
    path, repo: repoRoot, log: resolve(dir, `${role}.log`), marker: Buffer.from(resolve(dir)).toString('hex') };
  if (Object.values(values).some(value => /[\r\n\0]/.test(value))) throw new Error('Service paths must not contain line breaks or NUL.');
  const template = await readFile(resolve(repoRoot, 'install/templates', platform === 'darwin' ? 'launchd.plist' : 'systemd.service'), 'utf8');
  const contents = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (platform === 'darwin') return xml(values[key]);
    if (['role', 'marker'].includes(key)) return values[key];
    if (key === 'path') return systemd(values[key]).slice(1, -1);
    // WorkingDirectory and stdio paths are single literal values, not ExecStart words.
    if (['repo', 'log'].includes(key)) return values[key].replaceAll('%', '%%');
    return systemd(values[key], true);
  });
  const file = platform === 'darwin' ? resolve(home, 'Library/LaunchAgents', `${label}.plist`)
    : resolve(home, '.config/systemd/user', `perpeto-${role}.service`);
  return { file, contents, label, marker: platform === 'darwin' ? `<key>PerpetoDataDirectory</key><string>${xml(resolve(dir))}</string>` : `# PerpetoDataDirectory=${values.marker}` };
}
export function serviceCommands(action, generated, platform = process.platform, uid = process.getuid()) {
  const unit = `perpeto-${generated.label.split('.').at(-1)}.service`;
  if (platform === 'darwin') return action === 'install' ? [['launchctl', ['bootstrap', `gui/${uid}`, generated.file]]]
    : [['launchctl', ['bootout', `gui/${uid}/${generated.label}`]]];
  return action === 'install' ? [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', unit]]]
    : [['systemctl', ['--user', 'disable', '--now', unit]]];
}
export async function service(action, dir, role, { dryRun = false, platform = process.platform, home = homedir(), run = spawnSync } = {}) {
  if (!dryRun) await privateDir(dir);
  const roles = role ? [role] : (await Promise.all(['hub', 'node'].map(async role => {
    try { await readJson(configPath(dir, role)); return role; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }))).filter(Boolean);
  if (!roles.length) throw new Error('Initialize a hub or join a node first.');
  const results = [];
  for (const role of roles) {
    if (action === 'install') await readJson(configPath(dir, role));
    const generated = await generateService({ role, dir, platform, home });
    if (dryRun) { results.push(generated); continue; }
    const existing = await readFile(generated.file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing !== null) {
      const stat = await lstat(generated.file);
      if (!stat.isFile() || stat.uid !== process.getuid() || !existing.includes(generated.marker)) throw new Error('Existing service belongs to another installation.');
    }
    if (action === 'install') {
      if (await control(dir, role).catch(() => null)) throw new Error(`Stop the ${role} daemon before installing its service.`);
      if (existing && existing !== generated.contents) throw new Error('Service settings changed. Uninstall before reinstalling.');
      await mkdir(dirname(generated.file), { recursive: true });
      if (!existing) await writeNew(generated.file, generated.contents);
    } else if (existing === null) { results.push({ file: generated.file, state: 'absent' }); continue; }
    for (const [cmd, args] of serviceCommands(action, generated, platform)) {
      const result = run(cmd, args, { stdio: 'ignore' });
      if (result.status !== 0 || result.error) throw new Error(`${cmd} failed. Service file retained at ${generated.file}; inspect the user service manager.`);
    }
    if (action === 'uninstall') {
      await unlink(generated.file);
      if (platform === 'linux' && run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }).status !== 0) throw new Error('systemctl daemon-reload failed.');
    }
    results.push({ file: generated.file, state: action === 'install' ? 'installed' : 'uninstalled' });
  }
  return results;
}

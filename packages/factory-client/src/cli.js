#!/usr/bin/env node
import { FactoryClient, loadConfig, ClientError } from './client.js';
import { serveMcp } from './mcp.js';
import { readFileSync } from 'node:fs';

const usage = 'Usage: perpeto-messages --config FILE init-project NAME | create-channel ID NAME | channels | send --body TEXT --key KEY [--to ROLE] [--channel ID] | read [--latest | --after CURSOR | --before CURSOR] [--limit N] [--to ROLE] [--channel ID] | ci-submit --job FILE | ci-status --id ID | ci-retry --id ID | ci-jobs [--limit N] | mcp';
try {
  const args = process.argv.slice(2);
  if (args[0] !== '--config' || !args[1] || !args[2]) throw new ClientError(usage);
  const config = loadConfig(args[1]);
  const client = new FactoryClient(config);
  const [command, ...rest] = args.slice(2);
  if (command === 'mcp' && rest.length === 0) await serveMcp(client);
  else {
    let result;
    if (command === 'init-project' && rest.length === 1) result = await client.initProject(rest[0]);
    else if (command === 'create-channel' && rest.length === 2) result = await client.createChannel(...rest);
    else if (command === 'channels' && rest.length === 0) result = await client.channels();
    else if (command === 'ci-submit' && rest.length === 2 && rest[0] === '--job') {
      let job;
      try { job = JSON.parse(readFileSync(rest[1], 'utf8')); }
      catch { throw new ClientError('Cannot read CI job JSON.'); }
      result = await client.submitCi(job);
    }
    else if (['ci-status', 'ci-retry'].includes(command) && rest.length === 2 && rest[0] === '--id') result = command === 'ci-status' ? await client.ciStatus(rest[1]) : await client.retryCi(rest[1]);
    else if (command === 'ci-jobs' && (rest.length === 0 || (rest.length === 2 && rest[0] === '--limit'))) result = await client.ciJobs(rest.length ? { limit: Number(rest[1]) } : {});
    else if (command === 'send' || command === 'read') {
      const options = {};
      const mapping = command === 'send' ? { '--body': 'body', '--key': 'idempotencyKey', '--to': 'recipientRoleId', '--channel': 'channelId' } : { '--after': 'after', '--before': 'before', '--latest': 'latest', '--limit': 'limit', '--to': 'recipientRoleId', '--channel': 'channelId' };
      for (let i = 0; i < rest.length;) {
        const key = mapping[rest[i]];
        if (key === 'latest') {
          if (key in options) throw new ClientError(usage);
          options.latest = true; i++; continue;
        }
        if (!key || rest[i + 1] === undefined || key in options) throw new ClientError(usage);
        options[key] = key === 'limit' ? Number(rest[i + 1]) : rest[i + 1];
        i += 2;
      }
      result = command === 'send' ? await client.send(options) : await client.read(options);
    } else throw new ClientError(usage);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof ClientError ? error.message : 'Factory client failed.'}\n`);
  process.exitCode = 1;
}

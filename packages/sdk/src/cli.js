#!/usr/bin/env node
import { FactoryClient, loadConfig, ClientError } from './client.js';
import { serveMcp } from './mcp.js';

const channel = { '--channel': 'channelId' };
const BOOLEAN = new Set(['latest', 'markRead']);
const COMMANDS = {
  send: { flags: { '--body': 'body', '--key': 'idempotencyKey', '--to': 'recipientRoleId', ...channel }, call: (client, options) => client.send(options) },
  read: { flags: { '--after': 'after', '--before': 'before', '--latest': 'latest', '--limit': 'limit', '--to': 'recipientRoleId', ...channel }, call: (client, options) => client.read(options) },
  reply: { positional: 'messageId', flags: { '--body': 'body', '--key': 'idempotencyKey', '--to': 'recipientRoleId', ...channel }, call: (client, options) => client.reply(options) },
  thread: { positional: 'threadId', flags: { '--after': 'after', '--limit': 'limit', ...channel }, call: (client, options) => client.thread(options) },
  message: { positional: 'messageId', flags: { ...channel }, call: (client, options) => client.message(options) },
  ack: { positional: 'messageId', flags: { '--note': 'note', ...channel }, call: (client, options) => client.ack(options) },
  unread: { flags: { '--limit': 'limit', '--mark-read': 'markRead', ...channel }, call: (client, options) => client.unread(options) },
};
const usage = 'Usage: perpeto-messages --config FILE init-project NAME | create-channel ID NAME | channels | send --body TEXT --key KEY [--to ROLE] [--channel ID] | read [--latest | --after CURSOR | --before CURSOR] [--limit N] [--to ROLE] [--channel ID] | reply MESSAGE_ID --body TEXT --key KEY [--to ROLE] [--channel ID] | thread THREAD_ID [--after CURSOR] [--limit N] [--channel ID] | message MESSAGE_ID [--channel ID] | ack MESSAGE_ID [--note TEXT] [--channel ID] | unread [--limit N] [--mark-read] [--channel ID] | mcp';
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
    else if (Object.hasOwn(COMMANDS, command)) {
      const { positional, flags, call } = COMMANDS[command];
      const options = {};
      let i = 0;
      if (positional) {
        if (rest[0] === undefined || rest[0].startsWith('--')) throw new ClientError(usage);
        options[positional] = rest[0]; i = 1;
      }
      while (i < rest.length) {
        const key = flags[rest[i]];
        if (!key || key in options) throw new ClientError(usage);
        if (BOOLEAN.has(key)) { options[key] = true; i++; continue; }
        if (rest[i + 1] === undefined) throw new ClientError(usage);
        options[key] = key === 'limit' ? Number(rest[i + 1]) : rest[i + 1];
        i += 2;
      }
      result = await call(client, options);
    } else throw new ClientError(usage);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof ClientError ? error.message : 'Factory client failed.'}\n`);
  process.exitCode = 1;
}

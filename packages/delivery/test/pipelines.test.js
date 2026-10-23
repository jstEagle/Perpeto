import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePipelineConfig, expandPipeline, describePipelines, jobKey } from '../src/index.js';

const valid = {
  version: 1,
  defaults: { env: { CI: '1' }, timeoutSec: 600 },
  pipelines: {
    default: {
      triggers: [{ on: 'merge-queue' }, { on: 'pull-request' }, { on: 'schedule', cron: '0 3 * * *' }],
      env: { STAGE: 'test' },
      jobs: {
        lint: { steps: [{ name: 'lint', run: 'npm run lint' }] },
        test: {
          needs: ['lint'], matrix: { node: ['22', 24], os: ['darwin', 'linux'] },
          runsOn: { pool: 'ci', os: '{{ matrix.os }}', labels: ['node-{{ matrix.node }}'] },
          env: { NODE_VERSION: '{{ matrix.node }}' }, timeoutSec: 1200, retry: { maxAttempts: 2 },
          cache: [{ key: 'deps-{{ matrix.os }}-{{ hashFiles(\'package-lock.json\') }}', paths: ['node_modules'] }],
          artifacts: [{ name: 'coverage-{{ matrix.node }}', paths: ['coverage/**'], maxBytes: 1024 }],
          steps: [{ name: 'test', run: 'node --test # {{ matrix.node }}' }],
        },
        package: { needs: ['test'], steps: [{ name: 'pack', run: 'npm pack' }], artifacts: [{ name: 'tarball', paths: ['*.tgz'], when: 'on-success' }] },
      },
    },
  },
};

test('a valid configuration normalizes defaults and expands a matrix DAG in dependency order', () => {
  const { config, errors } = parsePipelineConfig(JSON.stringify(valid));
  assert.deepEqual(errors, []);
  const pipeline = expandPipeline(config, 'default');
  assert.deepEqual(pipeline.jobs.map(job => job.key), ['lint', 'test (node=22, os=darwin)', 'test (node=22, os=linux)', 'test (node=24, os=darwin)', 'test (node=24, os=linux)', 'package']);
  const [lint, test, , , , pack] = pipeline.jobs;
  assert.deepEqual(lint.needs, []); assert.deepEqual(test.needs, ['lint']); assert.equal(pack.needs.length, 4, 'a need on a matrix job waits for every combination');
  assert.deepEqual(test.runsOn, { pool: 'ci', os: 'darwin', labels: ['node-22'] });
  assert.equal(lint.runsOn.pool, undefined, 'no pool: any pool'); assert.equal(lint.timeoutSec, 600); assert.equal(test.timeoutSec, 1200);
  assert.deepEqual(test.env, { CI: '1', STAGE: 'test', NODE_VERSION: '22', MATRIX_NODE: '22', MATRIX_OS: 'darwin' });
  assert.equal(test.cache[0].key, "deps-darwin-{{ hashFiles('package-lock.json') }}", 'hashFiles is left for the runner');
  assert.equal(test.artifacts[0].name, 'coverage-22'); assert.equal(test.maxAttempts, 2); assert.equal(lint.maxAttempts, 1);
  assert.equal(pack.artifacts[0].when, 'on-success'); assert.equal(lint.artifacts.length, 0);
  assert.match(test.configHash, /^[a-f0-9]{64}$/); assert.notEqual(test.configHash, pipeline.jobs[2].configHash);
  assert.deepEqual(pipeline.triggers.map(item => item.on), ['merge-queue', 'pull-request', 'schedule']);
  assert.equal(describePipelines(config).length, 1);
  assert.equal(expandPipeline(config, 'missing'), null);
  assert.equal(jobKey('x', { a: '1' }), 'x (a=1)');
});

test('triggers default to manual and the expansion is deterministic', () => {
  const { config } = parsePipelineConfig({ version: 1, pipelines: { quick: { jobs: { a: { steps: [{ name: 's', run: 'true' }] } } } } });
  const first = expandPipeline(config, 'quick'); const second = expandPipeline(structuredClone(config), 'quick');
  assert.deepEqual(first.triggers, [{ on: 'manual' }]); assert.deepEqual(first, second);
});

test('validation reports every problem with a JSON path', () => {
  const broken = {
    version: 2, extra: true,
    pipelines: {
      'bad name!': { jobs: {} },
      main: {
        triggers: [{ on: 'push' }, { on: 'schedule', cron: '61 * * * *' }],
        jobs: {
          a: { needs: ['b'], steps: [{ name: 's', run: 'echo {{ matrix.x }}' }], env: { PATH: '/evil', 'BAD-NAME': 'x' } },
          b: { needs: ['a', 'ghost'], steps: [], cache: [{ key: 'k', paths: ['../outside'] }], artifacts: [{ name: 'a/b', paths: ['x'] }], retry: { maxAttempts: 9 } },
          c: { steps: [{ name: 's', run: 'x' }, { name: 's', run: 'y' }], matrix: { os: ['plan9'] }, runsOn: { os: '{{ matrix.os }}' }, timeoutSec: 0 },
        },
      },
    },
  };
  const { config, errors } = parsePipelineConfig(broken);
  assert.equal(config, null);
  const paths = errors.map(item => item.path);
  for (const expected of ['$.extra', '$.version', '$.pipelines.bad name!', '$.pipelines.main.triggers[0]', '$.pipelines.main.triggers[1].cron',
    '$.pipelines.main.jobs.a.steps[0].run', '$.pipelines.main.jobs.a.env.PATH', '$.pipelines.main.jobs.a.env.BAD-NAME',
    '$.pipelines.main.jobs.b.steps', '$.pipelines.main.jobs.b.cache[0].paths', '$.pipelines.main.jobs.b.artifacts[0]', '$.pipelines.main.jobs.b.retry',
    '$.pipelines.main.jobs.b.needs', '$.pipelines.main.jobs', '$.pipelines.main.jobs.c.steps[1]', '$.pipelines.main.jobs.c.matrix.os', '$.pipelines.main.jobs.c.timeoutSec']) {
    assert.ok(paths.includes(expected), `missing ${expected} in ${JSON.stringify(errors, null, 1)}`);
  }
  assert.ok(errors.some(item => /cycle/.test(item.message)));
  assert.equal(parsePipelineConfig('{nope').errors[0].path, '$');
  assert.match(parsePipelineConfig('x'.repeat(300 * 1024)).errors[0].message, /exceeds/);
  const tooWide = { version: 1, pipelines: { p: { jobs: { a: { steps: [{ name: 's', run: 'x' }], matrix: { a: [1, 2, 3, 4, 5, 6, 7, 8], b: [1, 2, 3, 4, 5, 6, 7, 8, 9] } } } } } };
  assert.match(parsePipelineConfig(tooWide).errors[0].message, /at most 64/);
});

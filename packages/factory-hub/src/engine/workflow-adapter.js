import { fail } from '../errors.js';

/**
 * Hub WorkflowEngine boundary (all methods may return promises).
 * validate(graph) -> { valid: boolean, errors: unknown[] }
 * startRun({ run, workflow, input }) -> { state: JSONValue, effects: Effect[] }
 * applyEvent({ run, workflow, state, event }) -> { state: JSONValue, effects: Effect[] }
 * Effect is { type: 'work-item'|'assignment'|'job'|'merge-entry'|'run', value: object }.
 * Entity effects carry IDs; run effects patch the current run. State is opaque and
 * persisted atomically with effects by the hub. Engines must perform no side effects.
 *
 * INTEGRATION POINT: the workflow worker owns the actual module API. The lead must
 * map its exports/state/effects here. No guessed import is treated as a real engine.
 * The current adapter deliberately fails closed rather than running a test stub.
 * @typedef {{ validate: Function, startRun: Function, applyEvent: Function }} WorkflowEngine
 */
export function createWorkflowAdapter() {
  const unavailable = () => fail(503, 'ENGINE_UNAVAILABLE', 'Workflow engine adapter has not been integrated.');
  return { validate: unavailable, startRun: unavailable, applyEvent: unavailable };
}
// Once integrated, import the deterministic engine from '@perpeto/factory-workflow'.

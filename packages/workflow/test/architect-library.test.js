import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchitectPrompt, evaluateArchitectResult, parseArchitectResult, listTemplates, getTemplate } from '../src/index.js';

test('architect sees the complete library and existing project workflows without replacing them', () => {
  const input = { project:{name:'Factory'}, userPrompt:'Add an improvement loop alongside build', existingWorkflows:[{name:'Build',version:1,graph:getTemplate('build')}] };
  const prompt = buildArchitectPrompt(input);
  for (const entry of listTemplates()) {
    assert.ok(prompt.includes(entry.description), entry.id);
    assert.ok(prompt.includes(JSON.stringify(getTemplate(entry.id))), entry.id);
  }
  assert.match(prompt, /alongside|second workflow/);
  assert.match(prompt, /Existing project workflows/);
  assert.match(prompt, /additionalWorkflows/);
  assert.equal(prompt, buildArchitectPrompt(input));
});

test('architect preserves and validates each additional proposal, including provider errors', () => {
  const proposal = { rationale:'Keep build and add improvements.', templateId:'build', graph:getTemplate('build'), additionalWorkflows:[
    {name:'Improve', rationale:'Work against unfinished goals.', templateId:'improve', graph:getTemplate('improve')},
  ] };
  const parsed = parseArchitectResult(JSON.stringify(proposal));
  assert.deepEqual(parsed.additionalWorkflows,proposal.additionalWorkflows);
  assert.equal(parsed.templateId,'build');
  assert.equal(evaluateArchitectResult(proposal).ok,true);
  const broken = structuredClone(proposal); broken.additionalWorkflows[0].graph.nodes = [];
  const result = evaluateArchitectResult(broken);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e => e.workflowIndex === 1));
  assert.equal(evaluateArchitectResult(proposal,{providers:['codex']}).ok,false);
  for (const additionalWorkflows of [null,{},[{}],Array(5).fill(proposal.additionalWorkflows[0])]) {
    assert.equal(evaluateArchitectResult({...proposal,additionalWorkflows}).ok,false);
  }
});

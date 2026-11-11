import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportedDetails} from '../src/metrics.js';

test('action types use executed counts, aggregate mnemonics, and fold small categories into Other',()=>{
  const details=reportedDetails({actionSummary:{actionsExecuted:'40',actionData:[
    {mnemonic:'CppCompile',actionsExecuted:'10',actionsCreated:100},
    {mnemonic:'CppCompile',actionsExecuted:2},
    {mnemonic:'Javac',actionsExecuted:8},
    {mnemonic:'Link',actionsExecuted:6},
    {mnemonic:'Genrule',actionsExecuted:4},
    {mnemonic:'FileWrite',actionsExecuted:3},
    {mnemonic:'TemplateExpand',actionsExecuted:2},
    {mnemonic:'Symlink',actionsExecuted:1},
  ]}});
  assert.deepEqual(details.actionTypes,[
    {label:'CppCompile',value:12},{label:'Javac',value:8},{label:'Link',value:6},
    {label:'Genrule',value:4},{label:'FileWrite',value:3},{label:'Other',value:7},
  ]);
});

test('missing or inconsistent totals do not invent actions or subtract reported categories',()=>{
  const actionData=[{mnemonic:'Javac',actionsExecuted:8}];
  assert.deepEqual(reportedDetails({actionSummary:{actionData}}).actionTypes,[{label:'Javac',value:8}]);
  assert.deepEqual(reportedDetails({actionSummary:{actionData,actionsExecuted:5}}).actionTypes,[{label:'Javac',value:8}]);
  assert.deepEqual(reportedDetails({actionSummary:{actionsExecuted:10}}).actionTypes,[]);
});

test('overlapping analysis and execution timings remain independent milliseconds',()=>{
  assert.deepEqual(reportedDetails({timingMetrics:{analysisPhaseTimeInMs:'700',executionPhaseTimeInMs:800,wallTimeInMs:1000}}).timings,[
    {label:'Analysis',value:700},{label:'Execution',value:800},
  ]);
});

test('absent, invalid, zero, and negative metrics do not become charts',()=>{
  for(const metrics of [undefined,null,{}, {actionSummary:{actionData:'invalid'}}])assert.deepEqual(reportedDetails(metrics),{actionTypes:[],timings:[]});
  assert.deepEqual(reportedDetails({actionSummary:{actionData:[
    {mnemonic:'Zero',actionsExecuted:0},{mnemonic:'Negative',actionsExecuted:-1},
    {mnemonic:'Infinite',actionsExecuted:Infinity},{mnemonic:'NaN',actionsExecuted:'NaN'},
    {mnemonic:'Boolean',actionsExecuted:true},{mnemonic:'',actionsExecuted:8},null,
  ]},timingMetrics:{analysisPhaseTimeInMs:-1,executionPhaseTimeInMs:'Infinity'}}),{actionTypes:[],timings:[]});
});

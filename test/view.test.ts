import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plain, View} from '@stencil-hq/tern';
import {BuildState} from '../src/core.js';
import {dashboard} from '../src/view.js';
const view=(s:BuildState)=>plain(dashboard(s,{tab:'tests',selected:'',paused:false,expanded:false,confirm:false},()=>{},()=>{}));
test('build UI omits test controls and unavailable statistics',()=>{
  const s=new BuildState('build',['//app:server']);
  s.event({id:{targetConfigured:{label:'//app:test'}},configured:{testSize:'SMALL'}});
  const text=view(s);assert.doesNotMatch(text,/TESTS PASSED|Tests \(|Test results|Waiting for invocation|build events/);
  assert.match(text,/Build log/);
});
test('links use native open actions so retained summaries do not depend on a running program',()=>{
 const s=new BuildState('build',[]);s.buildbuddy='https://bb.example/invocation/123';s.logFile='/tmp/build.log';s.finish(0);
 const root=dashboard(s,{tab:'tests',selected:'',paused:false,expanded:false,confirm:false},()=>{},()=>{}) as any;
 const nodes:any[]=[];const walk=(n:any)=>{nodes.push(n);for(const c of n.children??[])walk(c);};walk(root);
 for(const href of [s.buildbuddy,'file:///tmp/build.log']) {
   const link=nodes.find(n=>n.props?.href===href);assert.ok(link);assert.equal(link.props.actions?.click,'open');
 }
});
test('native execution charts use reported process counts, not internal or total runner rows',()=>{
 const s=new BuildState('build',[]);
 s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'total',count:110},{name:'internal',count:10},{name:'remote cache hit',count:72},{name:'remote',execKind:'Remote',count:24},{name:'local',execKind:'Local',count:4}],actionCacheStatistics:{hits:90,misses:10}}}});
 s.finish(0);
 const root=dashboard(s,{tab:'tests',selected:'',paused:false,expanded:false,confirm:false},()=>{},()=>{}) as any;
 const nodes:any[]=[];const walk=(n:any)=>{nodes.push(n);for(const c of n.children??[])walk(c);};walk(root);
 const charts=nodes.filter(n=>n.kind==='chart'&&n.props.kind==='donut');
 assert.equal(charts.length,2);
 assert.deepEqual(charts[0].props.series.map((p:any)=>p.value),[72,24,4]);
 assert.equal(charts[0].props.total,'100');assert.equal(charts[1].props.total,'90%');
});

const nodesOf=(root:any):any[]=>[root,...(root.children??[]).flatMap(nodesOf)];
const renderAt=(s:BuildState,cols:number,rows:number)=>dashboard(s,{tab:'tests',selected:'',paused:false,expanded:true,confirm:false},()=>{},()=>{},cols,rows);
test('failure replaces performance panels with original diagnostics and shell handoff',()=>{
 const s=new BuildState('test',['//app:test']);s.buildbuddy='https://app.buildbuddy.io/invocation/123';s.logFile='/tmp/build.log';
 s.output('\x1b[31mERROR: src/main.cc:42: undefined symbol\x1b[0m\n  missing_function();\n');
 for(let i=0;i<240;i++)s.output(`[${i} / 300] compiling\n`);
 s.actionSamples=[{at:1000,completed:1},{at:2000,completed:20},{at:3000,completed:21}];
 s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'remote',count:24}],actionCacheStatistics:{hits:90,misses:10}}}});
 s.finish(1);
 const root=renderAt(s,65,24),nodes=nodesOf(root),text=plain(root);
 assert.match(text,/undefined symbol/);assert.match(text,/Shell ready/);
 assert.equal(nodes.filter(n=>n.kind==='chart').length,0);
 assert.ok(nodes.some(n=>n.props?.href===s.buildbuddy));
 assert.equal(nodes.filter(n=>n.kind==='tabs'||n.props?.onSelect).length,0);
});
test('small panes bound the body below viewport height without enclosing header or handoff',()=>{
 const s=new BuildState('build',[]);s.finish(0);
 const nodes=nodesOf(renderAt(s,60,22));
 const body=nodes.find(n=>n.props?.role==='build-body');assert.ok(body);
 assert.ok(parseInt(body.props.max.h)<=12);
 assert.doesNotMatch(plain(body),/Shell ready|BuildBuddy/);
 assert.match(plain(renderAt(s,60,22)),/Shell ready/);
});
test('idle or data-free action samples do not create a throughput chart',()=>{
 const s=new BuildState('build',[]);
 for(const samples of [[],[{at:1000,completed:0},{at:2000,completed:0},{at:3000,completed:0}]]){
   s.actionSamples=samples;
   const nodes=nodesOf(renderAt(s,150,45));
   assert.equal(nodes.filter(n=>n.kind==='chart'&&n.props?.kind==='area').length,0);
 }
});
test('narrow live view uses a sparkline instead of stacking full sized charts',()=>{
 const s=new BuildState('build',[]);s.actionsDone=40;s.actionsTotal=100;
 s.actionSamples=[{at:1000,completed:0},{at:2000,completed:20},{at:3000,completed:40}];
 const nodes=nodesOf(renderAt(s,65,24));
 assert.ok(nodes.some(n=>n.kind==='chart'&&n.props.kind==='spark'));
 assert.ok(!nodes.some(n=>n.kind==='chart'&&n.props.kind==='area'));
});
test('logs and shell handoff remain outside scrollable metrics; extras only appear with reported data',()=>{
 const s=new BuildState('build',[]);s.buildbuddy='https://app.buildbuddy.io/invocation/abc';
 s.event({buildMetrics:{actionSummary:{actionsExecuted:8,actionData:[{mnemonic:'Javac',actionsExecuted:8}]},timingMetrics:{executionPhaseTimeInMs:1200}}});s.finish(0);
 const root=renderAt(s,70,24),nodes=nodesOf(root),body=nodes.find(n=>n.props?.role==='build-body');
 assert.doesNotMatch(plain(body),/Build log|Shell ready/);
 assert.match(plain(root),/Build log/);
 assert.ok(nodes.some(n=>n.kind==='section'&&n.props.collapsible&&n.props.collapsed));
 assert.ok(nodes.some(n=>n.props?.href?.endsWith('#cache')));
 s.finish(1);
 const failureNodes=nodesOf(renderAt(s,70,24));
 assert.ok(!failureNodes.some(n=>n.kind==='chart'||n.kind==='meter'));
 assert.ok(failureNodes.some(n=>n.props?.href?.endsWith('#log')));
});

test('a test that fails to build can also be a failed target without breaking native reconciliation',()=>{
 const s=new BuildState('test',[]);
 s.event({id:{targetCompleted:{label:'//app:test'}},completed:{success:false}});
 s.event({id:{testSummary:{label:'//app:test'}},testSummary:{overallStatus:'FAILED_TO_BUILD'}});
 s.finish(1);
 assert.doesNotThrow(()=>View.from(renderAt(s,80,30)));
});

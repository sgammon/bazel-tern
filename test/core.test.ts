import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInvocation, BuildState, JsonLines } from '../src/core.js';

test('adds a local BEP stream without changing BuildBuddy arguments or startup flags', () => {
  const args = ['--output_base=/tmp/base', 'test', '//...', '--bes_backend=grpcs://bb.example', '--remote_header=x-buildbuddy-api-key=secret', '--', 'build'];
  const plan = planInvocation(args, '/tmp/events');
  assert.deepEqual(plan.args, [args[0], 'test', '--build_event_json_file=/tmp/events', ...args.slice(2)]);
  assert.equal(plan.command, 'test');
});
test('reads the user BEP file instead of overwriting it, and ignores flags after --', () => {
  assert.equal(planInvocation(['test', '--build_event_json_file', 'mine.json', '//...'], '/tmp/e').bep, 'mine.json');
  assert.equal(planInvocation(['test', '//...', '--', '--build_event_json_file=not-a-flag'], '/tmp/e').bep, '/tmp/e');
  assert.deepEqual(planInvocation(['query', '//...'], '/tmp/e').args, ['query', '//...']);
});
test('incremental JSON consumes split UTF-8 chunks, ignores malformed records, flushes last record', () => {
  const events: any[] = [];
  const parser = new JsonLines(e => events.push(e));
  const bytes = Buffer.from('{"progress":{"stdout":"héllo"}}\nnot-json\n{"finished":{}}');
  const split = bytes.indexOf(0xc3) + 1;
  parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split)); parser.finish();
  assert.deepEqual(events, [{progress:{stdout:'héllo'}}, {finished:{}}]);
});
test('deduplicates configured targets and test summaries while preserving failures and durations', () => {
  const s = new BuildState('test', ['//...']);
  s.event({id:{targetConfigured:{label:'//a:test'}}, configured:{targetKind:'sh_test', testSize:'SMALL'}});
  s.event({id:{targetConfigured:{label:'//a:test'}}, configured:{targetKind:'sh_test', testSize:'SMALL'}});
  s.event({id:{testSummary:{label:'//a:test'}}, testSummary:{overallStatus:'FAILED', totalRunDurationMillis:'1240', failed:[{uri:'file:///tmp/test.log'}]}});
  s.event({id:{testSummary:{label:'//a:test'}}, testSummary:{overallStatus:'FAILED', totalRunDurationMillis:'1240'}});
  assert.equal(s.tests.size, 1); assert.equal(s.counts.failed, 1);
  assert.equal(s.tests.get('//a:test')?.duration, 1240);
  assert.equal(s.tests.get('//a:test')?.logs[0], 'file:///tmp/test.log');
});
test('discovers BuildBuddy URLs across chunks, with terminal controls and punctuation removed', () => {
  const s = new BuildState('build', []);
  s.output('\x1b[32mINFO: Streaming build results to: https://bb.example/invoca');
  s.output('tion/abc-123\x1b[0m\n');
  assert.equal(s.buildbuddy, 'https://bb.example/invocation/abc-123');
});
test('bounds log and event memory and distinguishes failed builds from test results', () => {
  const s = new BuildState('test', []);
  for (let i=0;i<5000;i++) s.output(`line ${i}\n`);
  assert.ok(s.log.length <= 200); assert.match(s.log.at(-1)!, /4999/);
  s.event({finished:{exitCode:{code:1}}});
  assert.equal(s.exitCode, 1); assert.equal(s.counts.failed, 0);
});
test('startup option values named like commands are not treated as the command', () => {
  const plan=planInvocation(['--output_base','test','--host_jvm_args','build','build','//...'],'/tmp/events');
  assert.equal(plan.command,'build');
  assert.deepEqual(plan.args,['--output_base','test','--host_jvm_args','build','build','--build_event_json_file=/tmp/events','//...']);
});
test('retains ANSI color across chunks and across the retained log tail',()=>{
  const s=new BuildState('build',[]);
  s.output('\x1b[3');s.output('1mcompiler error\ncontinued\x1b[0m\n');
  assert.match(s.log[0],/\x1b\[31mcompiler error/);
  assert.match(s.log[1],/\x1b\[31mcontinued/);
});
test('execution stats separate internal actions, cache hits, remote and local execution',()=>{
  const s=new BuildState('build',[]);
  assert.equal(s.execution,undefined);
  s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'total',count:110},{name:'internal',count:10},{name:'remote cache hit',count:60},{name:'remote',execKind:'Remote',count:30},{name:'linux-sandbox',execKind:'Local',count:10}],actionCacheStatistics:{hits:20,misses:80}}}});
  assert.equal(s.execution?.remoteHits,60);assert.equal(s.execution?.remote,30);assert.equal(s.execution?.local,10);
  assert.equal(s.execution?.remoteShare,.6);assert.equal(s.execution?.localHitRate,.2);
});
test('native output requests color while preserving explicit user overrides and BuildBuddy settings',()=>{
 const p=planInvocation(['build','//...','--color=no','--bes_backend=grpcs://bb','--','--color=auto'],'/tmp/e',true);
 assert.deepEqual(p.args,['build','--color=yes','--curses=no','--build_event_json_file=/tmp/e','//...','--color=no','--bes_backend=grpcs://bb','--','--color=auto']);
});
test('invocation link is not published while its URL is only partially received',()=>{
 const s=new BuildState('build',[]);
 s.output('INFO: Streaming build results to: https://bb.example/invocation/1234');
 assert.equal(s.buildbuddy,'');
 s.output('-5678\n');assert.equal(s.buildbuddy,'https://bb.example/invocation/1234-5678');
});
test('throughput uses elapsed sample time and never makes counter resets negative',()=>{
 const s=new BuildState('build',[]);s.actionsTotal=1000;s.actionsDone=10;s.sample(1000);s.actionsDone=30;s.sample(3000);
 assert.deepEqual(s.throughput,[10]);
 s.actionsDone=2;s.sample(4000);assert.deepEqual(s.throughput,[10,0]);
});
test('finalizes an invocation URL emitted without a trailing newline',()=>{
 const s=new BuildState('build',[]);s.output('https://bb.example/invocation/no-newline');s.finish(0);
 assert.equal(s.buildbuddy,'https://bb.example/invocation/no-newline');
});
test('failure details retain colored compiler diagnostics and context after a long progress tail',()=>{
 const s=new BuildState('build',[]);
 s.output('\x1b[31mapp/main.cc:42: er');
 s.output('ror: unknown identifier widgets\n  return widgets;\n         ^~~~~~~\x1b[0m\n');
 for(let i=0;i<500;i++)s.output(`[${i} / 500] Compiling unrelated.cc\n`);
 s.output('INFO: Elapsed time: 40.3s\nINFO: Build did NOT complete successfully\n');
 s.finish(1);
 assert.match(s.failureDetails,/\x1b\[31mapp\/main.cc:42: error: unknown identifier widgets/);
 assert.match(s.failureDetails,/return widgets;/);
 assert.match(s.failureDetails,/\^~~~~~~/);
 assert.doesNotMatch(s.failureDetails,/unrelated|Elapsed time/);
});
test('failure details capture test assertion context and finalize unterminated diagnostics',()=>{
 const s=new BuildState('test',[]);
 s.output('FAIL: //cache:eviction_test\n  eviction_test.ts:42: expected size 128, received 129\n');
 s.output('[2 / 3] Testing //other:test\nPASS: //other:test\n');
 s.output('FATAL: remote execution connection lost');s.finish(3);
 assert.match(s.failureDetails,/FAIL: \/\/cache:eviction_test/);
 assert.match(s.failureDetails,/expected size 128, received 129/);
 assert.match(s.failureDetails,/FATAL: remote execution connection lost/);
 assert.doesNotMatch(s.failureDetails,/other:test/);
});
test('failure detail storage is bounded while retaining the first root cause',()=>{
 const s=new BuildState('build',[]);
 s.output('compiler.cc:1: error: original root cause\n');
 for(let i=0;i<5000;i++)s.output(`compiler.cc:${i+2}: error: ${'x'.repeat(1000)}\n`);
 s.finish(1);
 assert.match(s.failureDetails,/original root cause/);
 assert.ok(s.failureDetails.length<65536);
});
test('unrecognized failures fall back to actual recent output without inventing a diagnosis',()=>{
 const s=new BuildState('build',[]);
 s.output('bazelisk: permission denied opening binary\n');s.finish(127);
 assert.match(s.failureDetails,/bazelisk: permission denied opening binary/);
});
test('retains TypeScript, Kotlin and Go diagnostics that do not use a plain error colon',()=>{
 for(const diagnostic of ['app.ts(4,2): error TS2304: Cannot find name widget.', 'e: file:///src/main.kt:4:2 Unresolved reference: widget', 'main.go:4:2: undefined: widget']) {
  const s=new BuildState('build',[]);s.output(diagnostic+'\n');
  for(let i=0;i<300;i++)s.output(`[${i} / 300] Compiling unrelated target\n`);
  s.finish(1);assert.ok(s.failureDetails.includes(diagnostic));
 }
});

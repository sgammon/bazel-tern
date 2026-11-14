import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInvocation, BuildState, JsonLines, testGroups, parseDiagnostic } from '../src/core.js';

test('adds a local BEP stream without changing BuildBuddy arguments or startup flags', () => {
  const args = ['--output_base=/tmp/base', 'test', '//...', '--bes_backend=grpcs://bb.example', '--remote_header=x-buildbuddy-api-key=secret', '--', 'build'];
  const plan = planInvocation(args, '/tmp/events');
  assert.deepEqual(plan.args, [args[0], 'test', '//...', '--bes_backend=grpcs://bb.example', '--remote_header=x-buildbuddy-api-key=secret', '--build_event_json_file=/tmp/events', '--', 'build']);
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
  assert.ok(s.log.length <= 300); assert.match(s.log.at(-1)!, /4999/);
  s.event({finished:{exitCode:{code:1}}});
  assert.equal(s.exitCode, 1); assert.equal(s.counts.failed, 0);
});
test('startup option values named like commands are not treated as the command', () => {
  const plan=planInvocation(['--output_base','test','--host_jvm_args','build','build','//...'],'/tmp/events');
  assert.equal(plan.command,'build');
  assert.deepEqual(plan.args,['--output_base','test','--host_jvm_args','build','build','//...','--build_event_json_file=/tmp/events']);
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
 assert.deepEqual(p.args,['build','--color=yes','--curses=no','//...','--color=no','--bes_backend=grpcs://bb','--build_event_json_file=/tmp/e','--','--color=auto']);
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

test('the retained log grows by appending between trims, so a terminal showing it is not reset every line',()=>{
 const s=new BuildState('build',[]);let resets=0,last:string[]=[];
 for(let i=0;i<1000;i++) {
   s.output(`line ${i}\n`);
   if(s.log[0]!==last[0]&&last.length)resets++;
   last=[...s.log];
 }
 assert.ok(s.log.length>=200&&s.log.length<=300);
 assert.ok(resets<=10,`${resets} resets`);
});
test('run builds through Bazel and asks for a launch script, leaving the program arguments alone',()=>{
 const args=['run','//app:server','--config=dev','--','--port','8080','--script_path=not-ours'];
 const plan=planInvocation(args,'/tmp/e',true,'/tmp/run.sh');
 assert.equal(plan.mode,'run');assert.equal(plan.keepsTerminal,false);
 assert.deepEqual(plan.args,['run','--color=yes','--curses=no','--script_path=/tmp/run.sh','//app:server','--config=dev','--build_event_json_file=/tmp/e','--','--port','8080','--script_path=not-ours']);
 // Without a surface there is no script to hand off to: Bazel runs the program itself.
 assert.deepEqual(planInvocation(args,'/tmp/e').args,['run','//app:server','--config=dev','--build_event_json_file=/tmp/e','--','--port','8080','--script_path=not-ours']);
});
test('a script path or --norun of the user\'s own is respected: Bazel was not going to start the program',()=>{
 for(const flag of [['--script_path=mine.sh'],['--script_path','mine.sh'],['--norun'],['--run=false']]) {
   const plan=planInvocation(['run',...flag,'//app:server'],'/tmp/e',true,'/tmp/run.sh');
   assert.equal(plan.keepsTerminal,true,flag.join(' '));
   assert.ok(!plan.args.includes('--script_path=/tmp/run.sh'));
 }
 assert.equal(planInvocation(['build','--script_path=x','//...'],'/tmp/e').keepsTerminal,false);
});
test('query asks for kinds only when the format is the user\'s default, and only for a surface',()=>{
 const native=planInvocation(['query','deps(//app:server)','--keep_going'],'',true);
 assert.equal(native.mode,'query');assert.equal(native.output,'label_kind');
 assert.deepEqual(native.args,['query','--color=yes','--curses=no','--output=label_kind','deps(//app:server)','--keep_going']);
 const plain=planInvocation(['query','deps(//app:server)'],'');
 assert.equal(plain.mode,'query');assert.equal(plain.output,'label');assert.deepEqual(plain.args,['query','deps(//app:server)']);
 for(const output of [['--output=label'],['--output','label_kind'],['--output=package']]) {
   const plan=planInvocation(['query','//...',...output],'',true);
   assert.equal(plan.mode,'query',output.join(' '));assert.equal(plan.output,output.at(-1)!.replace('--output=',''));
   assert.ok(!plan.args.includes('--output=label_kind')||output.includes('label_kind'));
 }
 assert.equal(planInvocation(['cquery','//app:server'],'',true).output,'label_kind');
 assert.equal(planInvocation(['--output_base=/tmp/b','cquery','//app:server'],'',true).args[1],'cquery');
});
test('query output meant for another program keeps the terminal\'s own behavior',()=>{
 for(const args of [['query','//...','--output=build'],['query','//...','--output','graph'],['query','//...','--output=proto'],['cquery','//...','--output=package'],
   ['cquery','//...','--output=files'],['query','//...','--output_file=out.txt'],['query','//...','--null'],['aquery','//...']]) {
   const plan=planInvocation(args,'',true);
   assert.equal(plan.mode,'passthrough',args.join(' '));assert.deepEqual(plan.args,args);
 }
 // A query after -- is an argument, not a format.
 assert.equal(planInvocation(['query','--','--output=build'],'',true).mode,'query');
});
test('commands that are not builds or queries pass through untouched',()=>{
 for(const args of [['info','output_base'],['clean'],['version'],['mod','graph'],['--version'],['help','query']]) {
   const plan=planInvocation(args,'/tmp/e',true,'/tmp/run.sh');
   assert.equal(plan.mode,'passthrough',args.join(' '));assert.deepEqual(plan.args,args);
 }
});

test('the phase names the furthest stage reached, even when analysis, execution and testing overlap',()=>{
 const s=new BuildState('test',[]);
 s.event({started:{uuid:'x'}});assert.equal(s.phase,'Loading');
 s.event({id:{targetConfigured:{label:'//a:t'}},configured:{testSize:'SMALL'}});assert.equal(s.phase,'Analyzing');
 s.event({id:{testResult:{label:'//a:t'}},testResult:{status:'PASSED',cachedLocally:true}});assert.equal(s.phase,'Testing');
 s.event({id:{targetConfigured:{label:'//b:t'}},configured:{testSize:'SMALL'}});
 s.output('Analyzing: 400 targets (90 packages loaded)\n[3 / 50] Compiling b.cc; 1s remote\n');
 assert.equal(s.phase,'Testing');
 assert.deepEqual(s.testRuns,{remote:0,local:1,executed:0});
});
test('a failed attempt shows at once and a pass waits for the summary; the summary has the last word',()=>{
 const s=new BuildState('test',[]);
 s.event({id:{testResult:{label:'//a:pass'}},testResult:{status:'PASSED'}});
 s.event({id:{testResult:{label:'//a:fail'}},testResult:{status:'FAILED'}});
 assert.equal(s.tests.get('//a:pass')?.status,'RUNNING');assert.equal(s.tests.get('//a:fail')?.status,'FAILED');
 assert.deepEqual([s.counts.finished,s.counts.failed],[1,1]);
 s.event({id:{testSummary:{label:'//a:fail'}},testSummary:{overallStatus:'FLAKY'}});
 assert.equal(s.tests.get('//a:fail')?.status,'FLAKY');assert.equal(s.counts.failed,0);
});

test('an event file named by an rc config is seen, so the wrapper can write it from its own',()=>{
 // `--config` expands where it is written: only a flag after it wins.
 const plan=planInvocation(['test','--config=upstream','//suite'],'/tmp/ours',true);
 assert.equal(plan.args.at(-1),'--build_event_json_file=/tmp/ours');assert.equal(plan.owned,true);
 const s=new BuildState('test',[]);
 s.event({optionsParsed:{cmdLine:['--config=upstream','--build_event_json_file=build/events.json','--build_event_json_file=/tmp/ours'],explicitCmdLine:['--config=upstream','--build_event_json_file=/tmp/ours']}});
 assert.deepEqual(s.eventFiles,['build/events.json','/tmp/ours']);
});

test('tests group at the first level under what they share that gives a handful of areas',()=>{
 const info=(label:string,status='PASSED')=>({label,status,duration:0,cached:false,logs:[]});
 // One generated package, a target per case: the paths are in the target names.
 const generated=[...Array.from({length:9},(_,i)=>info(`//tools/up:substrate/box/area${i}/deep/case.kt`,i===3?'FAILED':'PASSED')),info('//tools/up:substrate/boxInline/x/case.kt'),info('//tools/up:substrate/box/area3/other.kt','FAILED')];
 const groups=testGroups(generated);
 assert.equal(groups[0].name,'box/area3');assert.deepEqual([groups[0].failed,groups[0].tests.length],[2,2]);
 assert.equal(groups.length,10);assert.ok(groups.some(g=>g.name==='boxInline/x'));
 // Ordinary packages group by package.
 assert.deepEqual(testGroups([info('//a/x:t1'),info('//a/y:t2'),info('//a/y:t3')]).map(g=>[g.name,g.tests.length]),[['y',2],['x',1]]);
 assert.deepEqual(testGroups([info('//only:t')]).map(g=>g.name),['only']);
 assert.deepEqual(testGroups([]),[]);
});
test('pass and fail counts are sampled over the run and thinned, never dropped from the front',()=>{
 const s=new BuildState('test',[]);
 for(let i=0;i<300;i++) {
   s.event({id:{testSummary:{label:`//a:t${i}`}},testSummary:{overallStatus:i%3?'PASSED':'FAILED'}});
   s.sample(1000*(i+1));
 }
 assert.ok(s.resultSamples.length<=120);
 assert.ok(s.resultSamples[0].passed+s.resultSamples[0].failed<=4);
 assert.deepEqual([s.resultSamples.at(-1)!.passed,s.resultSamples.at(-1)!.failed].map(n=>n>90),[true,true]);
});

test('tool diagnostics are read as a place, a severity and a message; ordinary output is not',()=>{
 const d=(line:string)=>{const p=parseDiagnostic(line);return p&&[p.severity,p.file,p.line,p.col,p.message];};
 assert.deepEqual(d('app/main.cc:42:7: error: use of undeclared identifier \'widgets\''),['error','app/main.cc',42,7,"use of undeclared identifier 'widgets'"]);
 assert.deepEqual(d('src/Foo.java:12: warning: [deprecation] bar() has been deprecated'),['warning','src/Foo.java',12,0,'[deprecation] bar() has been deprecated']);
 assert.deepEqual(d('app.ts(4,2): error TS2304: Cannot find name widget.'),['error','app.ts',4,2,'TS2304: Cannot find name widget.']);
 assert.deepEqual(d('e: file:///src/main.kt:4:2 Unresolved reference: widget'),['error','/src/main.kt',4,2,'Unresolved reference: widget']);
 assert.deepEqual(d('main.go:4:2: undefined: widget'),['error','main.go',4,2,'undefined: widget']);
 assert.deepEqual(d('ERROR: /ws/app/BUILD.bazel:10:8: Compiling app/main.cc failed: (Exit 1)'),['error','/ws/app/BUILD.bazel',10,8,'Compiling app/main.cc failed: (Exit 1)']);
 for(const line of ['INFO: Elapsed time: 10.812s, Critical Path: 4.87s','[12 / 40] Compiling app/main.cc; 2s remote','app/main.cc:42:7: note: declared here','12:30:01: started','https://app.buildbuddy.io/invocation/abc:1: x','lib/util.py:3: some text without a severity','FAIL: //a:t (see /x/test.log)'])
   assert.equal(d(line),undefined,line);
});
test('problems carry the source around them, once each, and failed tests remember where their log is',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(join(tmpdir(),'tern-diag-'));
 try {
   const file=join(dir,'main.cc');writeFileSync(file,'one\ntwo\nint x = = 3;\nfour\nfive\nsix\n');
   const s=new BuildState('build',[]);
   s.output(`${file}:3:9: error: expected expression\n    int x = = 3;\n${file}:3:9: error: expected expression\nmissing.cc:1:1: error: gone\n  context line\n[2 / 3] Compiling other.cc\nFAIL: //app:t_test (Exit 1) (see ${dir}/test.log)\n`);
   assert.equal(s.issues.length,2);
   assert.deepEqual(s.issues[0].excerpt,{start:1,lines:['one','two','int x = = 3;','four','five']});
   assert.equal(s.issues[1].excerpt,undefined);assert.deepEqual(s.issues[1].detail,['  context line']);
   assert.equal(s.testLog('//app:t_test'),`${dir}/test.log`);assert.equal(s.testLog('//app:other_test'),undefined);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Elide compiler diagnostics are read with the source listing they print, errors and warnings',()=>{
 const s=new BuildState('build',[]);
 s.output(`
\x1b[31merror:\x1b[0m kotlinc: Initializer type mismatch: expected 'Int', actual 'String'.
In file: Bad.kt:3:16

 1 │ fun main() {
 2 │     val unused = 3
→3 │     val x: Int = "hello"
 4 │     println(widget)
 5 │ }

warning: kotlinc: 'fun old(): Int' is deprecated. old.
In file: src/Warn.kt:4:13

 2 │ fun main() {
→4 │     println(old())

  1 errors, 1 warnings.
❌  Compilation failed (323ms)
error: something with no file
INFO: Elapsed time: 1.0s
`);
 assert.deepEqual(s.issues.map(i=>[i.severity,i.file,i.line,i.col,i.message]),[
   ['error','Bad.kt',3,16,"Initializer type mismatch: expected 'Int', actual 'String'."],
   ['warning','src/Warn.kt',4,13,"'fun old(): Int' is deprecated. old."]]);
 assert.deepEqual(s.issues[0].excerpt,{start:1,lines:['fun main() {','    val unused = 3','    val x: Int = "hello"','    println(widget)','}']});
 assert.deepEqual(s.issues[1].excerpt,{start:2,lines:['fun main() {','    println(old())']});
});

test('stock javac and kotlinc output is read too: errors, lint warnings, and the lines under them',()=>{
 const s=new BuildState('build',[]);
 s.output(`/ws/src/Bad.java:4: error: incompatible types: String cannot be converted to int
        int x = "hello";
                ^
/ws/src/Bad.java:5: warning: [rawtypes] found raw type: List
        List raw = new java.util.ArrayList();
        ^
  missing type arguments for generic class List<E>
src/Bad.kt:3:18: error: initializer type mismatch: expected 'Int', actual 'String'.
    val x: Int = "hello"
                 ^^^^^^^
src/Warn.kt:5:14: warning: unnecessary non-null assertion (!!) on a non-null receiver of type 'String'.
w: file:///ws/src/Old.kt:9:5 'fun old(): Int' is deprecated. old.
e: /ws/src/Old.kt:12:1: Unresolved reference: widget
2 errors
`);
 assert.deepEqual(s.issues.map(i=>[i.severity,i.file,i.line,i.col]),[
   ['error','/ws/src/Bad.java',4,0],['warning','/ws/src/Bad.java',5,0],['error','src/Bad.kt',3,18],
   ['warning','src/Warn.kt',5,14],['warning','/ws/src/Old.kt',9,5],['error','/ws/src/Old.kt',12,1]]);
 assert.equal(s.issues[0].message,'incompatible types: String cannot be converted to int');
 assert.equal(s.issues[1].message,'[rawtypes] found raw type: List');
 // Without a readable file, the compiler's own echo of the line and its caret stand in for the excerpt.
 assert.deepEqual(s.issues[0].detail,['        int x = "hello";','                ^']);
 assert.deepEqual(s.issues[2].detail,['    val x: Int = "hello"','                 ^^^^^^^']);
});

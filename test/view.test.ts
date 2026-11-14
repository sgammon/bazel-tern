import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plain, View} from '@stencil-hq/tern';
import {BuildState} from '../src/core.js';
import {QueryState} from '../src/query.js';
import {dashboard, launched, queryView, type ViewState} from '../src/view.js';

const state=(over:Partial<ViewState>={}):ViewState=>({tab:'tests',selected:'',paused:false,expanded:false,...over});
const nodesOf=(root:any):any[]=>[root,...(root.children??[]).flatMap(nodesOf)];
const renderAt=(s:BuildState,cols:number,rows:number,v=state({expanded:true}))=>dashboard(s,v,()=>{},cols,rows);
const view=(s:BuildState)=>plain(dashboard(s,state(),()=>{}));
const metrics={actionSummary:{runnerCount:[{name:'total',count:110},{name:'internal',count:10},{name:'remote cache hit',count:72},{name:'remote',execKind:'Remote',count:24},{name:'local',execKind:'Local',count:4}],actionCacheStatistics:{hits:90,misses:10}}};

test('build UI omits test controls and unavailable statistics',()=>{
  const s=new BuildState('build',['//app:server']);
  s.event({id:{targetConfigured:{label:'//app:test'}},configured:{testSize:'SMALL'}});
  const text=view(s);assert.doesNotMatch(text,/TESTS PASSED|Tests \(|Test results|Waiting for invocation|build events/);
  assert.match(text,/Build log/);
});
test('links use native open actions so retained summaries do not depend on a running program',()=>{
 const s=new BuildState('build',[]);s.buildbuddy='https://bb.example/invocation/123';s.logFile='/tmp/build.log';s.finish(0);
 const nodes=nodesOf(dashboard(s,state(),()=>{}));
 for(const href of [s.buildbuddy,'file:///tmp/build.log']) {
   const link=nodes.find(n=>n.props?.href===href);assert.ok(link);assert.equal(link.props.actions?.click,'open');
 }
});
test('execution mix uses reported process counts, not internal or total runner rows',()=>{
 const s=new BuildState('build',[]);s.event({buildMetrics:metrics});s.finish(0);
 const nodes=nodesOf(dashboard(s,state(),()=>{}));
 const charts=nodes.filter(n=>n.kind==='chart'&&n.props.kind==='donut');
 assert.equal(charts.length,1);
 assert.deepEqual(charts[0].props.series.map((p:any)=>p.value),[72,24,4]);
 assert.equal(charts[0].props.total,'100');
 // The action cache is one number, so it is a tile, not a second ring.
 const tiles=nodes.find(n=>n.kind==='stats').props.items;
 assert.deepEqual(tiles.map((t:any)=>[t.label,t.value]),[['Remote cache','72%'],['Action cache','90%']]);
});
test('the page reads head row, then at most four sentence-case tiles, with color only on what needs attention',()=>{
 const s=new BuildState('test',['//app/...']);s.buildbuddy='https://app.buildbuddy.io/invocation/abc';
 for(const [label,status] of [['//app:a_test','PASSED'],['//app:b_test','FAILED']]) {
   s.event({id:{targetConfigured:{label}},configured:{testSize:'SMALL'}});
   s.event({id:{targetCompleted:{label}},completed:{success:true}});
   s.event({id:{testSummary:{label}},testSummary:{overallStatus:status}});
 }
 s.output('[10 / 20] Testing //app:b_test\n');s.event({buildMetrics:metrics});
 const root=dashboard(s,state(),()=>{}),nodes=nodesOf(root);
 const head=nodes.find(n=>n.props?.key==='head');
 assert.equal(head.children[0].props.spans[0].s,'title');assert.equal(head.children[0].props.spans[0].t,'Tests');
 const tiles=nodes.find(n=>n.kind==='stats').props.items;
 assert.equal(tiles.length,4);
 for(const tile of tiles)assert.doesNotMatch(String(tile.label),/[A-Z]{2}/);
 assert.deepEqual(tiles.map((t:any)=>t.label),['Tests','Pass rate','Failed','Actions']);
 assert.deepEqual(tiles.filter((t:any)=>t.tone).map((t:any)=>[t.label,t.tone]),[['Failed','error']]);
 // Opening results elsewhere is never the page's primary action.
 assert.equal(nodes.filter(n=>n.kind==='button'&&n.props.variant==='primary').length,0);
 assert.equal(nodes.filter(n=>n.kind==='buttons').length,1);
});
test('the log is its last line until it is opened, then a scroll area of whole terminal rows',()=>{
 const s=new BuildState('build',[]);
 for(let i=0;i<30;i++)s.output(`\x1b[32m[${i} / 30]\x1b[0m Compiling unit ${i}\n`);
 const logOf=(root:any)=>{const card=nodesOf(root).find(n=>n.props?.key==='logs');const box=nodesOf(card).find(n=>n.kind==='scroll');return {card,box,ansi:nodesOf(box).find(n=>n.kind==='ansi')};};
 const rowsOf=(box:any,cell:number)=>parseFloat(box.props.max.h)*18/cell;
 // Folded, the head carries the newest line as plain text, so results keep the page.
 const folded=logOf(dashboard(s,state(),()=>{},120,40,16));
 assert.equal(folded.card.props.collapsible,true);assert.equal(folded.card.props.collapsed,true);
 assert.equal(folded.card.props.head.map((sp:any)=>sp.t).join('').trim(),'Build log · [29 / 30] Compiling unit 29');
 // Only a scroll area takes scrolling. Its lines are 18px and terminal rows are not, so the height is fractional lines.
 for(const cell of [15.5,16,20]) {
   const {card,box,ansi}=logOf(dashboard(s,state({expanded:true}),()=>{},120,40,cell));
   assert.equal(card.props.collapsed,false);
   assert.equal(ansi.props.max,undefined);assert.equal(ansi.props.text.split('\r\n').length,30);
   assert.ok(Math.abs(rowsOf(box,cell)-Math.round(rowsOf(box,cell)))<0.01,`cell ${cell}: ${box.props.max.h}`);
   assert.equal(box.props.pinned,true);
 }
 const at=(rows:number)=>rowsOf(logOf(dashboard(s,state({expanded:true}),()=>{},120,rows,16)).box,16);
 assert.ok(at(40)>=20,`${at(40)} rows at 40`);assert.ok(at(60)>at(40)+15);
 assert.equal(logOf(dashboard(s,state({expanded:true,paused:true}),()=>{},120,40,16)).box.props.pinned,false);
 // The summary left behind is folded, with a window ready for Tern to unfold without the program.
 s.finish(0);
 const kept=logOf(dashboard(s,state({expanded:true}),()=>{},120,40,16));
 assert.equal(kept.card.props.collapsed,true);assert.ok(rowsOf(kept.box,16)>=6&&rowsOf(kept.box,16)<=16);
});
test('keys are shown while the program takes them and leave the retained summary',()=>{
 const s=new BuildState('build',[]);s.output('[1 / 2] Compiling\n');
 // A key is on the button it presses, or in the legend when it has none.
 const keys=(root:any)=>nodesOf(root).flatMap(n=>[...(n.props?.keys??[]),...(n.props?.spans??[]).filter((sp:any)=>sp.s==='key').map((sp:any)=>sp.t)]);
 assert.deepEqual(keys(renderAt(s,120,40,state())).sort(),['ctrl+c','l']);
 assert.deepEqual(keys(renderAt(s,120,40)).sort(),['ctrl+c','l','p']);
 const toggles=nodesOf(renderAt(s,120,40,state({expanded:true,paused:true}))).filter(n=>n.kind==='button'&&n.props.keys);
 assert.deepEqual(toggles.map(n=>[n.props.text,n.props.on]),[['Follow',false],['Contract',true]]);
 s.finish(0);
 assert.deepEqual(keys(renderAt(s,120,40)),[]);
});
test('failure replaces performance panels with original diagnostics in one error card',()=>{
 const s=new BuildState('test',['//app:test']);s.buildbuddy='https://app.buildbuddy.io/invocation/123';s.logFile='/tmp/build.log';
 s.output('\x1b[31mERROR: src/main.cc:42: undefined symbol\x1b[0m\n  missing_function();\n');
 for(let i=0;i<240;i++)s.output(`[${i} / 300] compiling\n`);
 s.actionSamples=[{at:1000,completed:1},{at:2000,completed:20},{at:3000,completed:21}];
 s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'remote',count:24}],actionCacheStatistics:{hits:90,misses:10}}}});
 s.finish(1);
 const root=renderAt(s,65,24),nodes=nodesOf(root),text=plain(root);
 assert.match(text,/undefined symbol/);
 const card=nodes.find(n=>n.kind==='card');
 assert.equal(card.props.tone,'error');assert.match(String(card.props.meta),/exit 1/);
 assert.equal(nodes.filter(n=>n.kind==='chart'||n.kind==='stats'||n.kind==='meter').length,0);
 assert.ok(nodes.some(n=>n.props?.href===s.buildbuddy));
 assert.ok(nodes.some(n=>n.props?.href==='file:///tmp/build.log'));
 assert.equal(nodes.filter(n=>n.kind==='tabs'||n.props?.onSelect).length,0);
});
test('a broken build reads as problems: where, what, and the source, with the tool\'s own words folded underneath',()=>{
 const s=new BuildState('build',['//app:server']);
 s.output('ERROR: /ws/app/BUILD.bazel:10:8: Compiling app/main.cc failed: (Exit 1)\napp/main.cc:42:7: error: use of undeclared identifier widgets\n   return widgets;\napp/util.h:3:1: warning: unused\n');
 s.finish(1);
 const nodes=nodesOf(dashboard(s,state(),()=>{},130,44)),card=nodes.find(n=>n.kind==='card');
 // What the compiler said about source comes before Bazel's note of the target, errors before warnings.
 const places=nodesOf(card).filter(n=>n.kind==='text'&&n.props.href).map(n=>n.props.href);
 assert.deepEqual(places,['app/main.cc:42:7','app/util.h:3:1','/ws/app/BUILD.bazel:10:8']);
 assert.deepEqual(nodesOf(card).filter(n=>n.kind==='badge').map(n=>[n.props.text,n.props.tone]),[['error','error'],['warning','warning'],['error','error']]);
 assert.ok(nodesOf(card).some(n=>n.kind==='code'&&/return widgets/.test(n.props.text)));
 const raw=nodesOf(card).find(n=>n.kind==='section');
 assert.equal(raw.props.collapsed,true);assert.ok(nodesOf(raw).some(n=>n.kind==='ansi'&&/undeclared identifier/.test(n.props.text)));
 assert.doesNotThrow(()=>View.from(dashboard(s,state(),()=>{},130,44)));
});
test('small panes bound the body below viewport height without enclosing header or log',()=>{
 const s=new BuildState('build',[]);s.buildbuddy='https://app.buildbuddy.io/invocation/abc';s.finish(0);
 const nodes=nodesOf(renderAt(s,60,22));
 const body=nodes.find(n=>n.props?.role==='build-body');assert.ok(body);
 assert.ok(parseInt(body.props.max.h)<=12);
 assert.doesNotMatch(plain(body),/Build log|BuildBuddy/);
 assert.match(plain(renderAt(s,60,22)),/BuildBuddy/);
});
test('idle or data-free action samples do not create a throughput chart',()=>{
 const s=new BuildState('build',[]);
 for(const samples of [[],[{at:1000,completed:0},{at:2000,completed:0},{at:3000,completed:0}]]){
   s.actionSamples=samples;
   const nodes=nodesOf(renderAt(s,150,45));
   assert.equal(nodes.filter(n=>n.kind==='chart').length,0);
   assert.ok(!nodes.flatMap(n=>n.props?.items??[]).some((t:any)=>t.label==='Throughput'));
 }
});
test('narrow live view uses a sparkline instead of stacking full sized charts',()=>{
 const s=new BuildState('build',[]);s.actionsDone=40;s.actionsTotal=100;
 s.actionSamples=[{at:1000,completed:0},{at:2000,completed:20},{at:3000,completed:40}];
 const nodes=nodesOf(renderAt(s,65,24));
 assert.ok(nodes.some(n=>n.kind==='chart'&&n.props.kind==='spark'));
 assert.ok(!nodes.some(n=>n.kind==='chart'&&n.props.kind==='area'));
 assert.ok(nodesOf(renderAt(s,120,40,state())).some(n=>n.kind==='chart'&&n.props.kind==='area'));
});
const testRun=()=>{
 const s=new BuildState('test',[]);
 s.actionSamples=[{at:1000,completed:0},{at:2000,completed:20},{at:3000,completed:40}];
 s.output('[40 / 100] Testing //app:a_test; 2s remote-cache\n[41 / 100] Compiling app/b.cc; 1s darwin-sandbox\n');
 for(const [label,status,remote] of [['//app:a_test','PASSED',true],['//app:b_test','FAILED',false]] as const) {
   s.event({id:{targetConfigured:{label}},configured:{testSize:'SMALL'}});
   s.event({id:{testResult:{label}},testResult:{status,executionInfo:{cachedRemotely:remote}}});
 }
 // Discovery goes on after tests have started reporting.
 s.event({id:{targetConfigured:{label:'//app:c_test'}},configured:{testSize:'SMALL'}});
 return s;
};
test('tests that have run show while Bazel is still discovering more: phase, table, outcomes and cache',()=>{
 const s=testRun();
 assert.equal(s.phase,'Testing');
 assert.deepEqual([s.counts.total,s.counts.failed],[3,1]);
 const nodes=nodesOf(renderAt(s,120,44,state()));
 const table=nodes.find(n=>n.kind==='table');
 assert.equal(table.props.rows[0].id,'//app:b_test');assert.equal(table.props.rows[0].cells.status.badge.text,'failed');
 // The suite as a grid of its hundredths, and where each result came from.
 const suite=nodes.find(n=>n.kind==='meter'&&n.props.style==='blocks');
 assert.deepEqual(suite.props.parts.map((p:any)=>[p.label,p.token,Math.round(p.value*3)]),[['Failed','error',1],['Pending','muted',2]]);
 const rings=nodes.filter(n=>n.kind==='chart'&&n.props.kind==='donut').map(n=>[n.props.key,n.props.series.map((p:any)=>`${p.label} ${p.value}`)]);
 assert.deepEqual(rings,[['test-cache-ring',['Remote cache 1','Executed 1']]]);
 assert.deepEqual(nodes.find(n=>n.kind==='stats').props.items.slice(0,4).map((t:any)=>[t.label,t.value]),[['Tests','1 / 3'],['Pass rate','0%'],['Failed','1'],['Cached','50%']]);
 // The rate chart says what it measures.
 const rate=nodes.find(n=>n.props?.key==='rate');
 assert.equal(rate.children[0].props.spans[0].t,'Throughput');assert.match(rate.children[0].props.spans[1].t,/actions per second/);
 assert.equal(rate.children[1].props.kind,'area');
});
test('expanded, the log takes the room of the tiles and the test table and the chart row stays',()=>{
 const s=testRun();
 const nodes=nodesOf(renderAt(s,120,44,state({expanded:true})));
 assert.ok(!nodes.some(n=>n.kind==='table'||n.kind==='stats'||n.kind==='tabs'));
 assert.deepEqual(nodes.filter(n=>n.kind==='chart').map(n=>n.props.key),['rate','test-ring','test-cache-ring']);
 assert.ok(nodes.some(n=>n.kind==='progress'));
 // Expanded, throughput is the bar chart, with its latest reading in the label.
 const rate=nodes.find(n=>n.props?.key==='rate');
 assert.equal(rate.children[1].props.kind,'bars');assert.match(rate.children[0].props.spans[1].t,/20\.0 actions per second/);
});
const bigSuite=(finish?:number)=>{
 const s=new BuildState('test',['//...']);
 const areas:[string,number,number][]=[['//svc/api',6,0],['//svc/auth',5,3],['//svc/web',4,0],['//lib/cache',6,4],['//lib/codec',3,0],['//lib/net',3,1],['//lib/graph',2,0],['//lib/store',2,0]];
 let at=1000;
 for(const [pkg,size,failing] of areas)for(let i=0;i<size;i++) {
   const label=`${pkg}:case${i}_test`;
   s.event({id:{targetConfigured:{label}},configured:{testSize:'SMALL'}});
   s.event({id:{testSummary:{label}},testSummary:{overallStatus:i<failing?'FAILED':'PASSED',totalRunDurationMillis:900+i,failed:i<failing?[{uri:i%2?'file:///tmp/test.log':'bytestream://cache/blobs/abc/1'}]:[]}});
   s.sample(at+=1000);
 }
 if(finish!==undefined)s.finish(finish);
 return s;
};
test('a large suite reads by area, worst first, with the selected area\'s tests beside it',()=>{
 const s=bigSuite();
 const nodes=nodesOf(dashboard(s,state(),()=>{},140,50));
 const table=nodes.find(n=>n.kind==='table');
 assert.deepEqual(table.props.rows.slice(0,3).map((r:any)=>[r.id,r.cells.failed[0].t,r.cells.rate[0].t]),[['lib/cache','4','33%'],['svc/auth','3','40%'],['lib/net','1','67%']]);
 assert.equal(table.props.cols.filter((c:any)=>c.grow).length,1);
 assert.deepEqual(table.props.rows[0].cells.share.meter.parts.map((p:any)=>[p.token,Math.round(p.value*6)]),[['success',2],['error',4]]);
 // The table is on the page; the card holds one area: the worst until another is selected.
 const card=nodes.find(n=>n.kind==='card');
 assert.equal(card.props.head,'lib/cache');assert.match(String(card.props.meta),/4 failed · 2 passed/);
 assert.ok(!nodesOf(card).some(n=>n.kind==='table'));
 assert.equal(nodesOf(dashboard(s,state({selected:'svc/auth'}),()=>{},140,50)).find(n=>n.kind==='card').props.head,'svc/auth');
 // Only logs Tern can open become buttons: a remote blob address is not one.
 assert.deepEqual(nodesOf(card).filter(n=>n.kind==='button').map(n=>n.props.href),['file:///tmp/test.log','file:///tmp/test.log']);
 const line=nodes.find(n=>n.kind==='chart'&&n.props.kind==='line');
 assert.deepEqual(line.props.series.map((p:any)=>[p.label,p.token,p.values.at(-1)]),[['Passed','success',23],['Failed','error',8]]);
});
test('failing tests are a result, not a crash: the page stays, with its log; a broken build is still an error card',()=>{
 const tests=bigSuite(3), root=dashboard(tests,state(),()=>{},140,50), nodes=nodesOf(root);
 assert.ok(!nodes.some(n=>n.kind==='card'&&n.props.tone==='error'));
 assert.ok(nodes.some(n=>n.kind==='table')&&nodes.some(n=>n.kind==='ansi')&&nodes.some(n=>n.kind==='stats'));
 assert.equal(nodes.find(n=>n.props?.key==='phase').props.tone,'error');
 assert.match(plain(root),/Pass rate/);
 assert.doesNotThrow(()=>View.from(root));
 const broken=bigSuite(1), card=nodesOf(dashboard(broken,state(),()=>{},140,50)).find(n=>n.kind==='card');
 assert.equal(card.props.tone,'error');
 for(const size of [[60,20],[100,30]] as const)assert.doesNotThrow(()=>View.from(dashboard(bigSuite(3),state(),()=>{},...size)));
});
test('a build shows where work is running from its progress lines until Bazel reports totals, and says it is a sample',()=>{
 const s=new BuildState('build',[]);
 s.output('[1 / 9] Compiling a.cc; 1s remote-cache\n[2 / 9] Compiling b.cc; 3s remote\n[3 / 9] Linking c; 2s linux-sandbox\n[4 / 9] Compiling d.cc; 0s remote-cache\n[5 / 9] 4 actions running\n');
 assert.deepEqual(s.running,{remoteCache:2,remote:1,local:1,disk:0,other:0,total:4});
 const live=nodesOf(renderAt(s,120,44,state()));
 const panel=live.find(n=>n.props?.key==='strategies');
 assert.match(panel.children[0].props.spans.map((sp:any)=>sp.t).join(''),/Running on.*sampled from progress/);
 assert.deepEqual(panel.children[1].props.series.map((p:any)=>[p.label,p.value]),[['Remote cache',2],['Remote execution',1],['Local execution',1]]);
 s.event({buildMetrics:metrics});s.finish(0);
 assert.ok(!nodesOf(renderAt(s,120,44,state())).some(n=>n.props?.key==='strategies'));
});
test('log stays outside scrollable metrics; extras only appear with reported data',()=>{
 const s=new BuildState('build',[]);s.buildbuddy='https://app.buildbuddy.io/invocation/abc';
 s.event({buildMetrics:{actionSummary:{actionsExecuted:8,actionData:[{mnemonic:'Javac',actionsExecuted:8}]},timingMetrics:{executionPhaseTimeInMs:1200,criticalPathTime:'0.900s'}}});s.finish(0);
 const root=renderAt(s,70,24),nodes=nodesOf(root),body=nodes.find(n=>n.props?.role==='build-body');
 assert.doesNotMatch(plain(body),/Build log/);
 assert.match(plain(root),/Build log/);
 // A small pane folds the detail away; a wide one shows it.
 assert.ok(nodes.some(n=>n.kind==='section'&&n.props.collapsible&&n.props.collapsed));
 const wide=nodesOf(renderAt(s,130,44));
 assert.ok(!wide.some(n=>n.kind==='section'));
 assert.match(plain(renderAt(s,130,44)),/Critical path/);
 // Small panes keep the most relevant BuildBuddy tab; wide ones list them all.
 assert.ok(nodes.some(n=>n.props?.href?.endsWith('#cache')));assert.ok(!nodes.some(n=>n.props?.href?.endsWith('#timing')));
 assert.ok(wide.some(n=>n.props?.href?.endsWith('#timing')));
 s.finish(1);
 const failureNodes=nodesOf(renderAt(s,130,44));
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
test('every state of every page reconciles',()=>{
 const s=new BuildState('test',['//...']);
 for(const size of [[60,20],[80,30],[130,44]] as const) {
   assert.doesNotThrow(()=>View.from(renderAt(s,...size)));
 }
 s.event({id:{targetConfigured:{label:'//a:t'}},configured:{testSize:'SMALL'}});s.output('[1 / 4] Testing //a:t\n');
 s.actionSamples=[{at:1000,completed:0},{at:2000,completed:1},{at:3000,completed:3}];
 s.event({id:{testSummary:{label:'//a:t'}},testSummary:{overallStatus:'PASSED'}});
 for(const size of [[60,20],[130,44]] as const)assert.doesNotThrow(()=>View.from(renderAt(s,...size)));
 s.event({buildMetrics:metrics});s.finish(0);
 for(const size of [[60,20],[130,44]] as const)assert.doesNotThrow(()=>View.from(renderAt(s,...size)));
});

test('run leaves one line of facts behind, with nothing that would compete with the program',()=>{
 const s=new BuildState('run',['run','//app:server','--','--port','8080']);s.buildbuddy='https://app.buildbuddy.io/invocation/abc';
 s.event({id:{targetConfigured:{label:'//app:server'}},configured:{targetKind:'go_binary'}});
 s.output('[40 / 40] Linking app/server\n');s.event({buildMetrics:metrics});s.finish(0);
 const root=launched(s),nodes=nodesOf(root),text=plain(root);
 assert.match(text,/Run/);assert.match(text,/\/\/app:server/);assert.match(text,/Built/);
 assert.doesNotMatch(text,/8080/);
 assert.equal(nodes.filter(n=>['ansi','chart','stats','scroll','table'].includes(n.kind)).length,0);
 assert.ok(nodes.some(n=>n.props?.href===s.buildbuddy&&n.props.actions?.click==='open'));
 assert.doesNotThrow(()=>View.from(root));
 // While it builds, and when the build fails, `run` is the build page under its own name.
 const failed=new BuildState('run',['run','//app:server']);failed.output('ERROR: no such target\n');failed.finish(1);
 assert.match(plain(dashboard(failed,state(),()=>{})),/Build failed/);
});

const queryOf=(lines:string[],output='label_kind',args=['query','deps(//app:server)'])=>{
 const q=new QueryState(args[0],args,output);q.stdout(Buffer.from(lines.map(l=>l+'\n').join('')));return q;
};
test('query results are a table with kinds, counted in tiles, beside a breakdown when there is room',()=>{
 const q=queryOf(['go_binary rule //app:server','go_library rule //app:lib','source file //app:main.go','generated file //proto:api.pb.go']);
 q.resultsFile='/tmp/results.txt';q.finish(0);
 const root=queryView(q,130,44),nodes=nodesOf(root),text=plain(root);
 assert.match(text,/deps\(\/\/app:server\)/);
 const table=nodes.find(n=>n.kind==='table');
 assert.deepEqual(table.props.cols.map((c:any)=>c.id),['label','kind']);
 assert.equal(table.props.cols.filter((c:any)=>c.grow).length,1);
 assert.equal(table.props.rows.length,4);
 assert.deepEqual(nodes.find(n=>n.kind==='stats').props.items.map((t:any)=>[t.label,t.value]),[['Targets','4'],['Packages','2'],['Rules','2'],['Files','2']]);
 // The table sits on the page; only the breakdown is a card.
 const cards=nodes.filter(n=>n.kind==='card');
 assert.equal(cards.length,1);assert.ok(!nodesOf(cards[0]).some(n=>n.kind==='table'));
 assert.ok(nodes.some(n=>n.props?.href==='file:///tmp/results.txt'&&n.props.actions?.click==='open'));
 assert.ok(!nodesOf(queryView(q,80,30)).some(n=>n.kind==='card'));
 assert.doesNotThrow(()=>View.from(root));
});
test('query shows its work while running, then an empty state or the tool\'s own error',()=>{
 const running=new QueryState('query',['query','//...'],'label_kind');running.stderr('Loading: 12 packages loaded\n');
 const live=nodesOf(queryView(running,120,40));
 assert.ok(live.some(n=>n.kind==='spinner'&&/12 packages loaded/.test(String(n.props.label))));
 assert.ok(live.some(n=>n.kind==='skeleton'));
 assert.ok(live.flatMap(n=>n.props?.spans??[]).some((sp:any)=>sp.s==='key'&&sp.t==='ctrl+c'));

 const none=queryOf([]);none.finish(0);
 const empty=nodesOf(queryView(none,120,40));
 assert.ok(empty.some(n=>n.kind==='empty'));assert.ok(!empty.some(n=>n.kind==='table'||n.kind==='stats'));
 assert.ok(!empty.flatMap(n=>n.props?.spans??[]).some((sp:any)=>sp.s==='key'));

 const bad=new QueryState('query',['query','deps(//nope)'],'label_kind');
 bad.stderr('Loading: 0 packages loaded\n\x1b[31mERROR: \x1b[0mno such package \'nope\': BUILD file not found\n');bad.finish(7);
 const failed=queryView(bad,120,40),failedNodes=nodesOf(failed);
 assert.equal(failedNodes.find(n=>n.kind==='card').props.tone,'error');
 assert.match(plain(failed),/no such package/);assert.doesNotMatch(plain(failed),/packages loaded/);
 assert.ok(!failedNodes.some(n=>n.kind==='table'||n.kind==='empty'));
});
test('query keeps partial results visible when Bazel reports a problem, and says when the table is cut',()=>{
 const partial=queryOf(['go_library rule //app:lib']);partial.stderr('ERROR: errors were encountered; results may be incomplete\n');partial.finish(3);
 const nodes=nodesOf(queryView(partial,120,40));
 assert.equal(nodes.find(n=>n.kind==='card').props.tone,'warning');
 assert.equal(nodes.find(n=>n.kind==='table').props.rows.length,1);

 const big=queryOf(Array.from({length:1500},(_,i)=>`cc_library rule //pkg${i%40}:t${i}`));big.finish(0);
 const view=nodesOf(queryView(big,120,40));
 assert.equal(view.find(n=>n.kind==='table').props.rows.length,1000);
 const targets=view.find(n=>n.kind==='stats').props.items[0];
 assert.equal(targets.value,'1,500');assert.match(String(targets.sub),/first 1,000/);
});

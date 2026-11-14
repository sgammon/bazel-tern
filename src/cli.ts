#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readSync, fstatSync, statSync, createWriteStream, unlinkSync, existsSync, copyFileSync, mkdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect, type Session, type Surface } from '@stencil-hq/tern';
import { BuildState, JsonLines, planInvocation, testGroups } from './core.js';
import { QueryState } from './query.js';
import { dashboard, launched, queryView, type ViewState } from './view.js';
import { responsiveLayout } from './layout.js';

const VERSION='0.5.0';
const HELP=`tern-bazel — native Bazel builds, runs and queries in Tern, alongside BuildBuddy

Usage: tern-bazel [wrapper options] [--] <bazel arguments...>
  --bazel PATH     Bazel, Bazelisk, or BuildBuddy CLI executable (default: bazel)
  --plain          Forward ordinary output without a native surface
  --demo [KIND]    Preview a simulated test run, or KIND: build, run, query; runs no Bazel commands
  --replay FILE    Play back a saved --build_event_json_file as if the command were running
  --help           Show this help (use -- help for Bazel's help)

Examples:
  tern-bazel test //...
  tern-bazel run //app:server -- --port 8080
  tern-bazel query 'deps(//app:server)'
  tern-bazel --bazel bb -- test //app:tests --config=remote
  tern-bazel -- --output_base=/tmp/bazel build //...

Environment: TERN_BAZEL_BIN, TERN_BAZEL_LOG (full raw log path), TERN_TSP=0
All Bazel arguments, rc files, BES, authentication, and cache settings pass through.
`;
type Options={bin:string;noUI:boolean;demo:boolean;replay:string;args:string[]};
function options(argv:string[]):Options {
  let bin=process.env.TERN_BAZEL_BIN||'bazel', noUI=false, demo=false, replay='';
  while (argv.length) {
    if (argv[0]==='--') {argv.shift();break;}
    if (argv[0]==='--help') {console.log(HELP);process.exit(0);}
    if (argv[0]==='--plain') {noUI=true;argv.shift();continue;}
    if (argv[0]==='--demo') {demo=true;argv.shift();continue;}
    if (argv[0]==='--replay') {argv.shift();replay=argv.shift()||'';if(!replay) throw new Error('--replay requires an event file');continue;}
    if (argv[0]==='--bazel') {argv.shift();bin=argv.shift()||'';if(!bin) throw new Error('--bazel requires an executable');continue;}
    break;
  }
  return {bin,noUI,demo,replay,args:argv};
}
const status=(code:number|null,signal:NodeJS.Signals|null)=>code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:signal==='SIGHUP'?129:1);
const SIGNALS=['SIGINT','SIGTERM','SIGHUP'] as const;

/** Commands that execute programs or emit machine output retain their original terminal behavior. */
function passthrough(bin:string,args:string[]) {
  return new Promise<number>(resolve=>{
    const child=spawn(bin,args,{stdio:'inherit'});
    child.on('error',e=>{console.error(`tern-bazel: ${e.message}`);resolve(127);});
    child.on('close',(code,signal)=>resolve(status(code,signal)));
  });
}
async function open(o:Options):Promise<Session|null> {
  if(o.noUI)return null;
  try {return await connect({app:'tern-bazel',version:VERSION,exitHooks:false});} catch {return null;}
}
/** The pane's row height in CSS px. Tern reports cells in device px on dense displays; a cell 12px wide or more is one of those. */
const rowHeight=(session:Session|null)=>{
  const cell=session?.caps.cell;
  return cell&&cell.h>0?cell.h/(cell.w>=12?2:1):undefined;
};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const demoStep=()=>Number(process.env.TERN_BAZEL_DEMO_STEP_MS||450);

/** Poll a growing local BEP file without ever rereading the whole build. */
class EventFile {
  offset=0; private baseline:number|undefined; private waiting=false;
  constructor(private path:string, private parser:JsonLines, existing:boolean) {
    if(existing) {try {this.baseline=statSync(path).mtimeMs;this.waiting=true;} catch {}}
  }
  read(final=false) {
    let fd:number;
    try {if(!statSync(this.path).isFile())return;fd=openSync(this.path,'r');} catch {return;}
    try {
      const stat=fstatSync(fd);
      if(this.waiting) {if(stat.mtimeMs===this.baseline)return;this.waiting=false;}
      if(stat.size<this.offset) this.offset=0;
      const buffer=Buffer.allocUnsafe(65536); let budget=final?Infinity:16;
      while(this.offset<stat.size && budget-->0) {
        const n=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-this.offset),this.offset);
        if(!n)break; this.offset+=n;this.parser.push(buffer.subarray(0,n));
      }
    } catch { /* A disappearing or unreadable event file must not interrupt Bazel. */ } finally {closeSync(fd);}
  }
}

async function main() {
  const o=options(process.argv.slice(2));
  if(!o.demo && !o.args.length) {console.log(HELP);return 0;}
  const demo=o.demo?(['build','run','query'].includes(o.args[0])?o.args[0]:'test'):'';
  if(demo==='query')o.args=['query','deps(//services/api:server)'];
  else if(demo)o.args=demo==='run'?['run','//services/api:server']:[demo,'//services/...','//lib/...'];
  if(o.replay && !o.args.length)o.args=['test','//...'];
  const mode=planInvocation(o.args,'').mode;
  if(o.replay) {
    if(mode!=='build')throw new Error('--replay plays back build, test and coverage invocations');
    return (await build(o,await open(o),true)).code;
  }
  if(mode==='passthrough')return passthrough(o.bin,o.args);
  const session=await open(o);
  // Without a surface, a query's lines and a program's terminal are already what the user asked for.
  // Launch scripts are shell scripts: where they cannot be run, Bazel starts the program as it always has.
  if(!demo && mode!=='build' && (!session || (mode==='run'&&process.platform==='win32'))) {await session?.close();return passthrough(o.bin,o.args);}
  if(mode==='query')return query(o,session,!!demo);
  const built=await build(o,session,!!demo);
  return built.launch?built.launch():built.code;
}

/** `build`, `test`, `coverage`, and the build half of `run`. */
async function build(o:Options, session:Session|null, demo:boolean):Promise<{code:number;launch?:()=>Promise<number>}> {
  const dir=mkdtempSync(join(tmpdir(),'tern-bazel-'));
  const plan=planInvocation(o.args,join(dir,'events.jsonl'));
  // Bazel writes the launch script instead of running the target, so the program starts on the real terminal.
  const script=plan.mode==='run'&&session&&!plan.keepsTerminal&&process.platform!=='win32'?join(dir,'run.sh'):'';
  const s=new BuildState(plan.command,o.args);
  s.logFile=resolve(process.env.TERN_BAZEL_LOG||join(dir,'build.log'));
  const log=createWriteStream(s.logFile,{flags:'w',mode:0o600});
  log.on('error',e=>{s.note=`Could not write full log: ${e.message}`;child?.stdout?.resume();child?.stderr?.resume();});
  const v:ViewState={tab:'tests',selected:'',paused:false,expanded:false};
  let surface:Surface|undefined, child:ChildProcess|undefined, received:NodeJS.Signals|undefined;
  let nativeFailed=false, interruptCount=0, renderTimer:NodeJS.Timeout|undefined, launching=false;
  const interrupt=(signal:NodeJS.Signals='SIGINT')=>{
    received=signal; interruptCount++;
    s.activity='Interrupting Bazel · waiting for result publishing';
    if(child?.pid) {
      const deliver=interruptCount>1?'SIGKILL':signal;
      try {if(process.platform!=='win32')process.kill(-child.pid,deliver);else child.kill(deliver);}catch{}
    }
  };
  const onInt=()=>interrupt('SIGINT'), onTerm=()=>interrupt('SIGTERM'), onHup=()=>interrupt('SIGHUP');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);process.on('SIGHUP',onHup);
  let frozen:string[]|undefined;
  const render=()=>{
    if(!surface || nativeFailed)return;
    try {
      // Freeze the displayed log while the event model and full on-disk log continue.
      const current=s.log;
      if(v.paused)s.log=frozen??=[...current]; else frozen=undefined;
      try {surface.render(launching?launched(s):dashboard(s,v,render,session?.caps.cols,process.stdout.rows,rowHeight(session)));}
      finally {s.log=current;}
    } catch(e) {
      nativeFailed=true;
      console.error(`tern-bazel: native rendering failed; continuing with plain output (${String(e)})`);
      void session?.close();
    }
  };
  const emit=(text:string, stream:'stdout'|'stderr'='stderr')=>{
    log.write(text);s.output(text);
    if(!session || nativeFailed) process[stream].write(text);
  };
  let watch:Promise<void>|undefined, code=1;
  try {
    if(session) {
      surface=session.open({mode:'flow',font:'sans',title:`Bazel ${s.command}`,role:'bazel.build'});
      surface.stylesheet('responsive-layout',responsiveLayout);
      render();
      const live=session;
      watch=(async()=>{
        for await(const input of live) {
          if(input.type!=='key') {if(input.event.ev==='resize')render();continue;}
          const k=input.key;
          if(k.ctrl && k.name==='c') interrupt();
          else if(k.name==='p')v.paused=!v.paused;
          else if(k.name==='l')v.expanded=!v.expanded;
          else if(k.name==='up'||k.name==='down'||k.name==='k'||k.name==='j') {
            // The areas table keeps its own order; the selection walks it.
            const names=testGroups(s.tests.values()).map(g=>g.name), at=Math.max(0,names.indexOf(v.selected));
            if(names.length)v.selected=names[Math.max(0,Math.min(names.length-1,at+(k.name==='up'||k.name==='k'?-1:1)))];
          }
          else if(k.name==='tab') {const tabs=s.testing?['tests','failures']:[];if(tabs.length)v.tab=tabs[(tabs.indexOf(v.tab)+(k.shift?tabs.length-1:1))%tabs.length];}
          render();
        }
      })().catch(e=>{s.note=`Native input stopped: ${String(e)}`;});
    }
    renderTimer=setInterval(()=>{s.sample();render();},250);
    if(o.replay) {
      code=await replay(o.replay,s,emit,()=>!!received);
    } else if(demo) {
      code=await demoBuild(s,emit,()=>!!received);
    } else {
      const parser=new JsonLines(e=>s.event(e));
      const file=new EventFile(resolve(plan.bep),parser,!plan.owned);
      const poll=setInterval(()=>{file.read();},100);
      try {
        code=await new Promise<number>(resolve=>{
          child=spawn(o.bin,session?planInvocation(o.args,plan.bep,true,script).args:plan.args,{stdio:[session?'ignore':'inherit','pipe','pipe'],detached:process.platform!=='win32',env:process.env});
          for(const stream of ['stdout','stderr'] as const) {
            child[stream]!.setEncoding('utf8');
            child[stream]!.on('data',(text:string)=>{
              emit(text,stream);
              // Bound disk-write buffering even for noisy compiler output.
              if(log.writableNeedDrain) {child?.[stream]?.pause();log.once('drain',()=>child?.[stream]?.resume());}
            });
          }
          child.on('error',e=>{emit(`tern-bazel: ${e.message}\n`);resolve(127);});
          child.on('close',(code,signal)=>resolve(status(code,signal)));
          if(received) interrupt(received);
        });
      } finally {clearInterval(poll);file.read(true);parser.finish();}
      if(parser.malformed)s.note=`${parser.malformed} unreadable build event(s); see BuildBuddy for complete results.`;
      if(!s.events)s.note='No local build events received. The log and exit status are still available.';
      if(plan.owned) {
        // An rc file asked for its own event file; ours had to win to be read, so theirs is written from it.
        const theirs=s.eventFiles.map(p=>resolve(p)).filter(p=>p!==resolve(plan.bep)).at(-1);
        if(theirs) {try {mkdirSync(dirname(theirs),{recursive:true});copyFileSync(plan.bep,theirs);}catch(e) {s.note=`Could not write ${theirs}: ${(e as Error).message}`;}}
        try {unlinkSync(plan.bep);}catch{}
      }
    }
    s.finish(code); v.paused=false; if(s.counts.failed)v.tab='failures';
    // A built target leaves one line behind and the pane to the program.
    launching=code===0&&s.command==='run'&&!nativeFailed&&(demo?!!session:!!script);
    render();
    if(!session) {
      process.stderr.write(`\nBazel ${s.phase.toLowerCase()} · ${((s.ended!-s.started)/1000).toFixed(1)}s · full log: ${s.logFile}\n`);
    }
  } finally {
    if(renderTimer)clearInterval(renderTimer);
    await session?.close();await watch;
    await new Promise<void>(resolve=>{if(log.destroyed)resolve();else log.end(resolve);});
    process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);process.off('SIGHUP',onHup);
    // Do not keep Node's stdin alive after restoring terminal modes.
    process.stdin.pause();
  }
  if(!launching)return {code};
  if(demo)return {code,launch:demoProgram};
  // A Bazel front end that built the target without writing the script still gets its program run, by Bazel.
  return {code,launch:existsSync(script)?()=>launch(script):()=>passthrough(o.bin,o.args)};
}

/** Runs what `bazel run` built, on the terminal itself: its input, its colors, its exit status. */
function launch(script:string) {
  return new Promise<number>(resolve=>{
    const child=spawn(script,[],{stdio:'inherit'});
    // The terminal delivers Ctrl+C to the program directly; other signals are passed on.
    const forward=Object.fromEntries(SIGNALS.map(signal=>[signal,()=>{if(signal!=='SIGINT')child.kill(signal);}]));
    for(const signal of SIGNALS)process.on(signal,forward[signal]);
    const done=(code:number)=>{for(const signal of SIGNALS)process.off(signal,forward[signal]);try {unlinkSync(script);}catch{}resolve(code);};
    child.on('error',e=>{console.error(`tern-bazel: could not start the built target: ${e.message}`);done(126);});
    child.on('close',(code,signal)=>done(status(code,signal)));
  });
}

/** `query` and `cquery` in a one-target-per-line format: results as a table, progress out of the way. */
async function query(o:Options, session:Session|null, demo:boolean) {
  const plan=planInvocation(o.args,'',!!session);
  const q=new QueryState(plan.command,o.args,plan.output);
  // The text file holds the lines the command would have printed, kinds only if they were asked for.
  const asked=planInvocation(o.args,'').output;
  let out:ReturnType<typeof createWriteStream>|undefined;
  if(session) {
    q.resultsFile=join(mkdtempSync(join(tmpdir(),'tern-bazel-')),'results.txt');
    out=createWriteStream(q.resultsFile,{flags:'w',mode:0o600});
    out.on('error',e=>{q.note=`Could not write results: ${e.message}`;q.resultsFile='';});
  }
  q.onResult=(row,line)=>{
    const text=row&&asked==='label'?row.label+(row.config?` (${row.config})`:''):line;
    if(out)out.write(text+'\n'); else process.stdout.write(text+'\n');
  };
  let surface:Surface|undefined, child:ChildProcess|undefined, received:NodeJS.Signals|undefined;
  let nativeFailed=false, interruptCount=0, renderTimer:NodeJS.Timeout|undefined, watch:Promise<void>|undefined, code=1;
  const interrupt=(signal:NodeJS.Signals='SIGINT')=>{
    received=signal; interruptCount++; q.activity='Interrupting Bazel';
    if(child?.pid) {
      const deliver=interruptCount>1?'SIGKILL':signal;
      try {if(process.platform!=='win32')process.kill(-child.pid,deliver);else child.kill(deliver);}catch{}
    }
  };
  const handlers=Object.fromEntries(SIGNALS.map(signal=>[signal,()=>interrupt(signal)]));
  for(const signal of SIGNALS)process.on(signal,handlers[signal]);
  const render=()=>{
    if(!surface || nativeFailed)return;
    try {surface.render(queryView(q,session?.caps.cols,process.stdout.rows,rowHeight(session)));}
    catch(e) {
      nativeFailed=true;
      console.error(`tern-bazel: native rendering failed (${String(e)}); results: ${q.resultsFile}`);
      void session?.close();
    }
  };
  try {
    if(session) {
      surface=session.open({mode:'flow',font:'sans',title:`Bazel ${q.command}`,role:'bazel.query'});
      render();
      const live=session;
      watch=(async()=>{
        for await(const input of live) {
          if(input.type==='key' && input.key.ctrl && input.key.name==='c')interrupt();
          render();
        }
      })().catch(e=>{q.note=`Native input stopped: ${String(e)}`;});
      renderTimer=setInterval(render,250);
    }
    if(demo) code=await demoQuery(q,()=>!!received);
    else code=await new Promise<number>(resolve=>{
      child=spawn(o.bin,plan.args,{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',env:process.env});
      child.stdout!.on('data',(bytes:Buffer)=>{
        q.stdout(bytes);
        if(out?.writableNeedDrain) {child?.stdout?.pause();out.once('drain',()=>child?.stdout?.resume());}
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data',(text:string)=>{q.stderr(text);if(!session || nativeFailed)process.stderr.write(text);});
      child.on('error',e=>{q.stderr(`tern-bazel: ${e.message}\n`);resolve(127);});
      child.on('close',(code,signal)=>resolve(status(code,signal)));
      if(received) interrupt(received);
    });
    q.finish(code);render();
    return code;
  } finally {
    if(renderTimer)clearInterval(renderTimer);
    await session?.close();await watch;
    await new Promise<void>(resolve=>{if(!out || out.destroyed)resolve();else out.end(resolve);});
    for(const signal of SIGNALS)process.off(signal,handlers[signal]);
    process.stdin.pause();
  }
}

const DEMO_TARGETS=['//services/api:integration_test','//services/auth:token_test','//lib/cache:eviction_test','//lib/graph:walk_test','//services/web:render_test','//lib/net:retry_test','//services/worker:queue_test','//lib/codec:roundtrip_test'];
/** A suite big enough to read by area: nine packages, a couple of them in trouble. */
const DEMO_SUITE=([['//services/api',26,1],['//services/auth',22,6],['//services/web',18,0],['//services/worker',14,1],['//lib/cache',24,9],['//lib/codec',20,0],['//lib/graph',16,2],['//lib/net',18,0],['//lib/store',12,3]] as const)
  .flatMap(([pkg,size,failing])=>Array.from({length:size},(_,i)=>({label:`${pkg}:${['parse','roundtrip','eviction','retry','session','render','queue','walk','merge','limits'][i%10]}_${Math.floor(i/10)+1}_test`,fails:i<failing})));
const INFO='\x1b[32mINFO: \x1b[0m';
async function demoBuild(s:BuildState, emit:(text:string)=>void, stopped:()=>boolean) {
  const step=()=>sleep(demoStep());
  const building=!s.testing, names=s.command==='run'?['//services/api:server','//services/api:handlers','//lib/net:retry','//lib/codec:codec']:building?DEMO_TARGETS:DEMO_SUITE.map(t=>t.label);
  const strategies=['remote-cache','remote-cache','remote','remote-cache','darwin-sandbox','remote-cache','remote'];
  s.event({started:{uuid:'demo-invocation'}});
  emit(`${INFO}Demo — simulated events, no build submitted\n`);
  emit(`${INFO}Streaming build results to: https://app.buildbuddy.io/invocation/demo-invocation\n`);
  // Tests start reporting while later packages are still being discovered.
  const early=building?names.length:Math.ceil(names.length*.6);
  for(const label of names.slice(0,early))s.event({id:{targetConfigured:{label}},configured:building?{targetKind:'cc_library'}:{testSize:'SMALL'}});
  emit(`${INFO}Analyzed ${names.length} targets (214 packages loaded, 3912 targets configured).\n`);
  let reported=0;
  for(let i=0;i<24;i++) {
    if(stopped())return 130;
    emit(`\x1b[32m[${(i+1)*37} / 888]\x1b[0m ${i<8?'Compiling':i<16?'Linking':building?'Packaging':'Testing'} ${names[(i*7)%names.length]}; ${1+i%3}s ${strategies[i%7]}\n`);
    if(building) {
      if(i>=12 && i<20 && i-12<names.length)s.event({id:{targetCompleted:{label:names[i-12]}},completed:{success:true}});
    } else if(i>=5) {
      if(i===9)for(const label of names.slice(early))s.event({id:{targetConfigured:{label}},configured:{testSize:'SMALL'}});
      const until=i===23?names.length:Math.min(i<9?early:names.length,Math.round(names.length*(i-4)/19));
      for(;reported<until;reported++) {
        const {label,fails}=DEMO_SUITE[(reported*37)%DEMO_SUITE.length], ms=400+((reported*713)%4200);
        s.event({id:{targetCompleted:{label}},completed:{success:true}});
        s.event({id:{testResult:{label}},testResult:{status:fails?'FAILED':'PASSED',testAttemptDurationMillis:ms,cachedLocally:!fails&&reported%5===1,executionInfo:{cachedRemotely:!fails&&reported%5!==1&&reported%3!==0}}});
        s.event({id:{testSummary:{label}},testSummary:{overallStatus:fails?'FAILED':'PASSED',totalRunDurationMillis:ms}});
        if(fails&&reported%4===0)emit(`\x1b[31m\x1b[1mFAIL: \x1b[0m${label} (Exit 1)\n  expected cache size 128, received 129\n`);
      }
    }
    await step();
  }
  s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'remote cache hit',count:684},{name:'remote',execKind:'Remote',count:182},{name:'darwin-sandbox',execKind:'Local',count:22}],actionCacheStatistics:{hits:2140,misses:888},actionsExecuted:888,actionData:[{mnemonic:'CppCompile',actionsExecuted:612},{mnemonic:'CppLink',actionsExecuted:148},{mnemonic:'GoCompilePkg',actionsExecuted:94},{mnemonic:'Genrule',actionsExecuted:34}]},timingMetrics:{analysisPhaseTimeInMs:1200,executionPhaseTimeInMs:9400,cpuTimeInMs:41300,criticalPathTime:'4.870s'}}});
  const failures=DEMO_SUITE.filter(t=>t.fails).length, code=building?0:3;
  emit(`${INFO}Found ${names.length} ${building?'targets':'test targets'}...\n`);
  emit(`${INFO}Elapsed time: 10.812s, Critical Path: 4.87s\n`);
  emit(`${INFO}888 processes: 684 remote cache hit, 182 remote, 22 darwin-sandbox.\n`);
  emit(building?`${INFO}Build completed successfully, 888 total actions\n`:`\x1b[31m\x1b[1mERROR: \x1b[0mBuild completed, ${failures} tests FAILED, 888 total actions\n`);
  s.event({finished:{exitCode:{code}}});return code;
}
/** Plays a saved event file back over about twelve seconds: real results, for looking at the page they make. */
async function replay(path:string, s:BuildState, emit:(text:string)=>void, stopped:()=>boolean) {
  const lines:string[]=[];
  for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity}))if(line.trim())lines.push(line);
  const step=Math.max(1,Math.ceil(lines.length/Math.max(1,Number(process.env.TERN_BAZEL_REPLAY_STEPS||48))));
  for(let i=0;i<lines.length;i+=step) {
    if(stopped())return 130;
    for(const line of lines.slice(i,i+step)) {
      let event:any; try {event=JSON.parse(line);} catch {continue;}
      if(event.progress)emit(String(event.progress.stderr??'')+String(event.progress.stdout??''));
      s.event(event);
    }
    await sleep(Math.min(demoStep(),250));
  }
  return s.exitCode ?? (s.counts.failed?3:0);
}
/** Stands in for the target a `run` would start. */
async function demoProgram() {
  for(const line of ['api: loaded 14 routes','api: listening on http://localhost:8080','GET /healthz 200 1ms']) {console.log(line);await sleep(demoStep());}
  return 0;
}
async function demoQuery(q:QueryState, stopped:()=>boolean) {
  const kinds:[string,string[]][]=[
    ['go_binary rule',['//services/api:server']],
    ['go_library rule',['//services/api:handlers','//services/api:routes','//services/auth:token','//services/auth:session','//lib/net:retry','//lib/net:backoff','//lib/cache:eviction','//lib/graph:walk']],
    ['cc_library rule',['//lib/codec:codec','//lib/codec:varint','//lib/cache:arena']],
    ['proto_library rule',['//services/api/proto:api_proto','//services/auth/proto:auth_proto']],
    ['source file',['//services/api:main.go','//services/api:handlers.go','//services/api:routes.go','//services/auth:token.go','//services/auth:session.go','//lib/net:retry.go','//lib/net:backoff.go','//lib/cache:eviction.go','//lib/cache:arena.cc','//lib/cache:arena.h','//lib/codec:codec.cc','//lib/codec:codec.h','//lib/codec:varint.cc','//lib/graph:walk.go','//services/api/proto:api.proto','//services/auth/proto:auth.proto']],
    ['generated file',['//services/api/proto:api.pb.go','//services/auth/proto:auth.pb.go']],
  ];
  q.stderr('Loading: 0 packages loaded\n');
  for(const [i,[kind,labels]] of kinds.entries()) {
    if(stopped())return 130;
    q.stderr(`Loading: ${(i+1)*2} packages loaded\n`);
    q.stdout(Buffer.from(labels.map(label=>`${kind} ${label}\n`).join('')));
    await sleep(demoStep());
  }
  q.stderr('INFO: Found 33 targets...\n');
  return 0;
}
main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(`tern-bazel: ${e.message}`);process.exitCode=1;});

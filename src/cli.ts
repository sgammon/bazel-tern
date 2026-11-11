#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readSync, fstatSync, statSync, createWriteStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, type Session, type Surface } from '@stencil-hq/tern';
import { BuildState, JsonLines, planInvocation } from './core.js';
import { dashboard, type ViewState } from './view.js';
import { responsiveLayout } from './layout.js';

const HELP=`tern-bazel — native Bazel builds in Tern, alongside BuildBuddy

Usage: tern-bazel [wrapper options] [--] <bazel arguments...>
  --bazel PATH     Bazel, Bazelisk, or BuildBuddy CLI executable (default: bazel)
  --plain          Forward ordinary output without a native surface
  --demo [build]   Preview a simulated test run or build; runs no Bazel commands
  --help           Show this help (use -- help for Bazel's help)

Examples:
  tern-bazel test //...
  tern-bazel --bazel bb -- test //app:tests --config=remote
  tern-bazel -- --output_base=/tmp/bazel build //...

Environment: TERN_BAZEL_BIN, TERN_BAZEL_LOG (full raw log path), TERN_TSP=0
All Bazel arguments, rc files, BES, authentication, and cache settings pass through.
`;
function options(argv:string[]) {
  let bin=process.env.TERN_BAZEL_BIN||'bazel', noUI=false, demo=false;
  while (argv.length) {
    if (argv[0]==='--') {argv.shift();break;}
    if (argv[0]==='--help') {console.log(HELP);process.exit(0);}
    if (argv[0]==='--plain') {noUI=true;argv.shift();continue;}
    if (argv[0]==='--demo') {demo=true;argv.shift();continue;}
    if (argv[0]==='--bazel') {argv.shift();bin=argv.shift()||'';if(!bin) throw new Error('--bazel requires an executable');continue;}
    break;
  }
  return {bin,noUI,demo,args:argv};
}

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
  // Commands that execute programs or emit machine output retain their original terminal behavior.
  const initial=planInvocation(o.args,'');
  if(!o.demo && !initial.supported) {
    return await new Promise<number>(resolve=>{
      const child=spawn(o.bin,o.args,{stdio:'inherit'});
      child.on('error',e=>{console.error(`tern-bazel: ${e.message}`);resolve(127);});
      child.on('close',(code,signal)=>resolve(code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1)));
    });
  }
  const dir=mkdtempSync(join(tmpdir(),'tern-bazel-'));
  const plan=planInvocation(o.args,join(dir,'events.jsonl'));
  const s=new BuildState(o.demo?(o.args[0]==='build'?'build':'test'):plan.command,o.demo?['//services/...','//lib/...']:o.args);
  s.logFile=resolve(process.env.TERN_BAZEL_LOG||join(dir,'build.log'));
  const log=createWriteStream(s.logFile,{flags:'w',mode:0o600});
  log.on('error',e=>{s.note=`Could not write full log: ${e.message}`;child?.stdout?.resume();child?.stderr?.resume();});
  const v:ViewState={tab:'tests',selected:'',paused:false,expanded:false,confirm:false};
  let session:Session|null=null, surface:Surface|undefined, child:ChildProcess|undefined, received:NodeJS.Signals|undefined;
  let nativeFailed=false, interruptCount=0, renderTimer:NodeJS.Timeout|undefined;
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
  let frozen:string|undefined;
  const render=()=>{
    if(!surface || nativeFailed)return;
    try {
      // Freeze the displayed log while the event model and full on-disk log continue.
      const current=s.log, partial=s.partial;
      if(v.paused) {frozen??=[...current,...(partial?[partial]:[])].join('\n');s.log=frozen.split('\n');s.partial='';}
      else frozen=undefined;
      try {surface.render(dashboard(s,v,render,()=>interrupt(),session?.caps.cols,process.stdout.rows));}
      finally {s.log=current;s.partial=partial;}
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
  let watch:Promise<void>|undefined;
  try {
    if(!o.noUI) {try {session=await connect({app:'tern-bazel',version:'0.4.0',exitHooks:false});} catch {session=null;}}
    if(session) {
      surface=session.open({mode:'flow',font:'sans',title:`Bazel ${s.command}`,role:'bazel.build'});
      surface.stylesheet('responsive-layout',responsiveLayout);
      render();
      watch=(async()=>{
        for await(const input of session!) {
          if(input.type!=='key') {if(input.event.ev==='resize')render();continue;}
          const k=input.key;
          if(k.ctrl && k.name==='c') interrupt();
          else if(k.name==='p')v.paused=!v.paused;
          else if(k.name==='l')v.expanded=!v.expanded;
          else if(k.name==='escape')v.confirm=false;
          else if(k.name==='tab') {const tabs=s.command==='build'?[]:['tests','failures'];if(tabs.length)v.tab=tabs[(tabs.indexOf(v.tab)+(k.shift?tabs.length-1:1))%tabs.length];}
          render();
        }
      })().catch(e=>{s.note=`Native input stopped: ${String(e)}`;});
    }
    renderTimer=setInterval(()=>{s.sample();render();},250);
    let code:number;
    if(o.demo) {
      code=await demo(s,emit,()=>!!received);
    } else {
      const parser=new JsonLines(e=>s.event(e));
      const file=new EventFile(resolve(plan.bep),parser,!plan.owned);
      const poll=setInterval(()=>{file.read();},100);
      try {
        code=await new Promise<number>(resolve=>{
          child=spawn(o.bin,session?planInvocation(o.args,plan.bep,true).args:plan.args,{stdio:[session?'ignore':'inherit','pipe','pipe'],detached:process.platform!=='win32',env:process.env});
          for(const stream of ['stdout','stderr'] as const) {
            child[stream]!.setEncoding('utf8');
            child[stream]!.on('data',(text:string)=>{
              emit(text,stream);
              // Bound disk-write buffering even for noisy compiler output.
              if(log.writableNeedDrain) {child?.[stream]?.pause();log.once('drain',()=>child?.[stream]?.resume());}
            });
          }
          child.on('error',e=>{emit(`tern-bazel: ${e.message}\n`);resolve(127);});
          child.on('close',(status,signal)=>resolve(status??(signal==='SIGINT'?130:signal==='SIGTERM'?143:signal==='SIGHUP'?129:1)));
          if(received) interrupt(received);
        });
      } finally {clearInterval(poll);file.read(true);parser.finish();}
      if(parser.malformed)s.note=`${parser.malformed} unreadable build event(s); see BuildBuddy for complete results.`;
      if(!s.events)s.note='No local build events received. The log and exit status are still available.';
      if(plan.owned) {try {unlinkSync(plan.bep);}catch{}}
    }
    s.finish(code); v.paused=false; if(s.counts.failed)v.tab='failures';render();
    if(!session) {
      process.stderr.write(`\nBazel ${s.phase.toLowerCase()} · ${((s.ended!-s.started)/1000).toFixed(1)}s · full log: ${s.logFile}\n`);
    }
    return code;
  } finally {
    if(renderTimer)clearInterval(renderTimer);
    await session?.close();await watch;
    await new Promise<void>(resolve=>{if(log.destroyed)resolve();else log.end(resolve);});
    process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);process.off('SIGHUP',onHup);
    // Do not keep Node's stdin alive after restoring terminal modes.
    process.stdin.pause();
  }
}

async function demo(s:BuildState, emit:(text:string)=>void, stopped:()=>boolean) {
  const delay=Number(process.env.TERN_BAZEL_DEMO_STEP_MS||450);
  const sleep=()=>new Promise(r=>setTimeout(r,delay));
  s.event({started:{uuid:'demo-invocation'}});
  emit('INFO: Demo build — simulated events, no remote build submitted\n');
  emit('INFO: Streaming build results to: https://app.buildbuddy.io/invocation/demo-invocation\n');
  const names=['//services/api:integration_test','//services/auth:token_test','//lib/cache:eviction_test','//lib/graph:walk_test','//services/web:render_test','//lib/net:retry_test','//services/worker:queue_test','//lib/codec:roundtrip_test'];
  for(const label of names)s.event({id:{targetConfigured:{label}},configured:s.command==='build'?{targetKind:'cc_library'}:{testSize:'SMALL'}});
  for(let i=0;i<24;i++) {
    if(stopped())return 130;
    emit(`[${(i+1)*37} / 888] ${i<8?'Compiling':i<16?'Linking':s.command==='build'?'Packaging':'Testing'} ${names[i%names.length]}; remote-cache\n`);
    if(i>=12 && i<20) {
      const label=names[i-12], failed=i===14;
      s.event({id:{targetCompleted:{label}},completed:{success:true}});
      if(s.command!=='build')s.event({id:{testSummary:{label}},testSummary:{overallStatus:failed?'FAILED':'PASSED',totalRunDurationMillis:1240+(i*713),totalNumCached:i%3===0?1:0}});
      if(s.command==='build')emit(`\x1b[32mBuilt ${label}\x1b[0m\n`);
      else if(failed)emit(`FAIL: ${label}\n  eviction_test.ts:42: expected cache size 128, received 129\n`);
      else emit(`PASS: ${label}\n`);
    }
    await sleep();
  }
  s.event({buildMetrics:{actionSummary:{runnerCount:[{name:'remote cache hit',count:684},{name:'remote',execKind:'Remote',count:182},{name:'darwin-sandbox',execKind:'Local',count:22}],actionCacheStatistics:{hits:2140,misses:888},actionsExecuted:888,actionData:[{mnemonic:'Compile',actionsExecuted:684},{mnemonic:'Link',actionsExecuted:182},{mnemonic:'Package',actionsExecuted:22}]},timingMetrics:{analysisPhaseTimeInMs:1200,executionPhaseTimeInMs:9400}}});
  const code=s.command==='build'?0:3;
  emit(s.command==='build'?'\x1b[32mBuild completed successfully.\x1b[0m\n':'Executed 8 tests: 7 passed and 1 failed.\n');
  s.event({finished:{exitCode:{code}}});return code;
}
main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(`tern-bazel: ${e.message}`);process.exitCode=1;});

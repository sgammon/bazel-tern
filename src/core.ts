import { StringDecoder } from 'node:string_decoder';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const COMMANDS = new Set(['build','test','coverage','run','query','cquery','aquery','info','clean','shutdown','version','help','fetch','sync','mod','license','canonicalize-flags','dump','analyze-profile','mobile-install','print_action','vendor']);
export type Mode = 'build'|'run'|'query'|'passthrough';
/** Query formats with one target per line; every other format keeps the terminal's own output. */
const QUERY_OUTPUTS: Record<string,string[]> = {query:['label','label_kind','package'], cquery:['label','label_kind']};
const flagValue = (args:string[], name:string) => {
  let value:string|undefined;
  for (let i=0;i<args.length;i++) {
    if (args[i].startsWith(name+'=')) value=args[i].slice(name.length+1);
    else if (args[i]===name) value=args[++i] ?? '';
  }
  return value;
};
/**
 * How to run one invocation. `native` adds what a Tern surface needs: colors
 * without cursor redraws, one-target-per-line query output, and for `run` a
 * launch script (`script`) so the program can own the terminal after the build.
 */
export function planInvocation(args: string[], localBep: string, native = false, script = '') {
  const end = args.indexOf('--');
  const before = end < 0 ? args : args.slice(0,end);
  const startupValues = new Set(['--output_base','--output_user_root','--install_base','--server_javabase','--host_jvm_args','--bazelrc','--io_nice_level','--max_idle_secs','--connect_timeout_secs','--command_port','--digest_function','--failure_detail_out','--invocation_policy','--local_startup_timeout_secs','--macos_qos_class','--unix_digest_hash_attribute_name']);
  let at=-1;
  for(let i=0;i<before.length;i++) {
    if(startupValues.has(before[i])) { i++; continue; }
    if(!before[i].startsWith('-')) { if(COMMANDS.has(before[i]))at=i; break; }
  }
  const command = before[at] ?? '';
  const options = at<0 ? [] : before.slice(at+1);
  const display = native ? ['--color=yes','--curses=no'] : [];
  const insert = (extra:string[], last:string[]=[]) => [...args.slice(0,at+1), ...extra, ...args.slice(at+1,end<0?undefined:end), ...last, ...(end<0?[]:args.slice(end))];
  if (command==='query' || command==='cquery') {
    const output = flagValue(options,'--output');
    // Results written elsewhere, or separated by NUL, are for another program to read.
    const redirected = options.some(a=>a==='--output_file'||a.startsWith('--output_file=')||a==='--null'||a==='--line_terminator_null'||a.startsWith('--line_terminator_null=')||a.startsWith('--null='));
    const tabular = !redirected && QUERY_OUTPUTS[command].includes(output ?? 'label');
    return { command, mode:(tabular?'query':'passthrough') as Mode, supported:false, bep:'', owned:false, keepsTerminal:false,
      // Kinds cost nothing extra to print and let the table say what each target is.
      output: tabular ? (output ?? (native?'label_kind':'label')) : (output ?? ''),
      args: tabular&&native ? insert([...display, ...(output===undefined?['--output=label_kind']:[])]) : [...args] };
  }
  const supported = ['build','test','coverage','run'].includes(command);
  let bep = localBep;
  let existing = false;
  for (let i=0;i<options.length;i++) {
    if (options[i].startsWith('--build_event_json_file=')) { bep = options[i].slice(24); existing=true; }
    if (options[i] === '--build_event_json_file') { bep=options[++i] ?? ''; existing=true; }
  }
  // A script of the user's own, or `--norun`, means Bazel was never going to start the program here.
  const keepsTerminal = command==='run' && (flagValue(options,'--script_path')!==undefined || options.some(a=>a==='--norun'||a==='--run=false'||a==='--run=0'));
  const mode:Mode = !supported ? 'passthrough' : command==='run' ? 'run' : 'build';
  return { command, mode, supported, bep, owned: !existing, keepsTerminal, output:'', args: supported
    // The event file goes last: a `--config` from an rc file expands where it is written and would otherwise win.
    ? insert([...display, ...(command==='run'&&script&&!keepsTerminal ? [`--script_path=${script}`] : [])], !existing ? [`--build_event_json_file=${localBep}`] : []) : [...args] };
}

/** JSON BEP is newline delimited; both UTF-8 and JSON may cross reads. */
export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  malformed = 0;
  constructor(private emit: (event:any)=>void) {}
  push(bytes:Buffer) { this.consume(this.decoder.write(bytes)); }
  private consume(text:string) {
    this.pending += text;
    let end:number;
    while ((end=this.pending.indexOf('\n')) >= 0) {
      const line=this.pending.slice(0,end); this.pending=this.pending.slice(end+1);
      if (!this.discarding) this.parse(line);
      this.discarding=false;
    }
    // One pathological event must not exhaust memory during a long invocation.
    if (this.pending.length > 16*1024*1024) { this.pending=''; this.discarding=true; this.malformed++; }
  }
  private parse(line:string) {
    if (!line.trim()) return;
    try { const e=JSON.parse(line); if (e && typeof e==='object') this.emit(e); }
    catch { this.malformed++; }
  }
  finish() { this.consume(this.decoder.end()); if (!this.discarding) this.parse(this.pending); this.pending=''; }
}
export function clean(text:string) {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
/** The retained log tail, and how far it may overshoot before a block is dropped. */
export const LOG_LINES=200, LOG_SLACK=100;
export type TestInfo = {label:string; status:string; duration:number; cached:boolean; logs:string[]};
export const failure = (status:string) => !['PASSED','FLAKY','PENDING','RUNNING','NO_STATUS'].includes(status);
/** One problem a tool reported at a place in a file, with the lines that explain it and the source around it. */
export type Diagnostic = {severity:'error'|'warning'; file:string; line:number; col:number; message:string; detail:string[]; excerpt?:{start:number;lines:string[]}};
/** `file:line[:col]: [error|warning:] message` as compilers, Bazel, tsc and kotlinc write it; undefined for anything else. */
export function parseDiagnostic(text:string):Omit<Diagnostic,'detail'|'excerpt'>|undefined {
  const line=text.trim();
  let m=line.match(/^(e|w): (?:file:\/\/)?(\S+?):(\d+):(\d+):? (.+)$/);
  if(m)return {severity:m[1]==='e'?'error':'warning',file:m[2],line:Number(m[3]),col:Number(m[4]),message:m[5]};
  m=line.match(/^(\S+?)\((\d+),(\d+)\): (error|warning) (.+)$/);
  if(m)return {severity:m[4] as 'error'|'warning',file:m[1],line:Number(m[2]),col:Number(m[3]),message:m[5]};
  m=line.match(/^(ERROR: |WARNING: )?((?:[\w.@+~-]*\/)*[\w.@+~-]+):(\d+)(?::(\d+))?:? (?:(fatal error|error|warning|note)\b[^:]*: )?(\S.*)$/);
  if(!m || m[5]==='note' || !/[A-Za-z]/.test(m[2]) || !(/\.[A-Za-z][\w+]*$/.test(m[2])||/(?:^|\/)BUILD$/.test(m[2])))return undefined;
  // A bare `file:line: text` is a diagnostic only where the tool is known to write errors that way.
  if(!m[1] && !m[5] && !/\.go$/.test(m[2]))return undefined;
  return {severity:m[5]==='warning'||m[1]==='WARNING: '?'warning':'error',file:m[2],line:Number(m[3]),col:Number(m[4]??0),message:m[6]};
}
const fileCache=new Map<string,string[]|null>();
/** The lines of a readable, modest text file; cached, so a page drawn four times a second reads it once. */
export function fileLines(path:string):string[]|null {
  if(fileCache.has(path))return fileCache.get(path)!;
  let lines:string[]|null=null;
  try {if(statSync(path).size<=2*1024*1024)lines=readFileSync(path,'utf8').split(/\r?\n/);} catch {}
  if(fileCache.size>200)fileCache.clear();
  fileCache.set(path,lines);
  return lines;
}
export type TestGroup = {name:string; tests:TestInfo[]; passed:number; failed:number; finished:number};
const pathOf = (label:string) => {
  const [pkg,name='']=label.replace(/^@*[^/]*\/\//,'').split(':');
  return [...pkg.split('/').filter(Boolean),...name.split('/').slice(0,-1)];
};
/**
 * Tests by area: the directory level under what they all share that first gives a handful of groups.
 * A suite generated into one package (one target per case) groups by the paths in its target names.
 */
export function testGroups(tests:Iterable<TestInfo>):TestGroup[] {
  const items=[...tests].map(test=>({test,path:pathOf(test.label)}));
  if(!items.length)return [];
  let shared=0;
  while(items.every(i=>i.path.length>shared&&i.path[shared]===items[0].path[shared]))shared++;
  const keyAt=(path:string[],depth:number)=>path.slice(shared,shared+depth).join('/');
  let depth=1;
  for(;depth<3&&new Set(items.map(i=>keyAt(i.path,depth))).size<8;depth++);
  const groups=new Map<string,TestGroup>();
  for(const {test,path} of items) {
    const name=keyAt(path,depth)||path.at(-1)||test.label;
    let group=groups.get(name);
    if(!group)groups.set(name,group={name,tests:[],passed:0,failed:0,finished:0});
    group.tests.push(test);
    if(test.status==='PASSED')group.passed++;
    if(failure(test.status))group.failed++;
    if(!['PENDING','RUNNING','NO_STATUS'].includes(test.status))group.finished++;
  }
  return [...groups.values()].sort((a,b)=>b.failed-a.failed||b.tests.length-a.tests.length||a.name.localeCompare(b.name));
}
export class BuildState {
  started = Date.now(); ended?:number; exitCode:number|null = null;
  phase='Starting'; activity='Waiting for Bazel'; buildbuddy=''; invocation='';
  tests=new Map<string,TestInfo>(); targets=new Map<string,boolean|null>();
  log:string[]=[]; partial=''; events=0; lastActivity=Date.now();
  actionsDone=0; actionsTotal=0; history:number[]=[]; actionSamples:{at:number;completed:number}[]=[]; metrics:any=null; logFile=''; note='';
  /** Test attempts as they report in: where each result came from. */
  testRuns={remote:0,local:0,executed:0};
  /** How often each strategy was named by a progress line: a sample of what is running, not a total. */
  strategies=new Map<string,number>();
  /** Problems with a place in a file, first reported first. */
  issues:Diagnostic[]=[];
  private openIssue:Diagnostic|undefined;
  /** Elide's form: a headline, then `In file:`, then the source it printed with the line pointed at. */
  private headline:{severity:'error'|'warning';message:string}|undefined;
  private listing:Diagnostic|undefined;
  /** Where Bazel said a failed test's log is on this machine. */
  testLogs=new Map<string,string>();
  /** Passed and failed counts over time, for the run's shape. */
  resultSamples:{at:number;passed:number;failed:number}[]=[];
  /** Every JSON event file the invocation named, rc files included, in the order Bazel read them. */
  eventFiles:string[]=[];
  private outputBuffer='';
  private sgr='';
  private diagnostics:string[][]=[];
  private activeDiagnostic:string[]|undefined;
  constructor(public command:string, public args:string[]) {}
  get execution() {
    const summary=this.metrics?.actionSummary;
    if(!summary)return undefined;
    const runners=summary.runnerCount ?? [];
    let remoteHits=0,remote=0,local=0,diskHits=0,other=0;
    for(const r of runners) {
      const name=String(r.name).toLowerCase(), kind=String(r.execKind??'').toLowerCase(), n=Number(r.count)||0;
      if(name==='total'||name==='internal')continue;
      if(name.includes('remote cache'))remoteHits+=n;
      else if(name.includes('disk cache'))diskHits+=n;
      else if(kind==='remote'||name==='remote')remote+=n;
      else if(kind==='local'||/sandbox|worker|standalone|local/.test(name))local+=n;
      else other+=n;
    }
    const total=remoteHits+remote+local+diskHits+other;
    const cache=summary.actionCacheStatistics;
    const lookups=Number(cache?.hits??0)+Number(cache?.misses??0);
    return {remoteHits,remote,local,diskHits,other,total,remoteShare:total?remoteHits/total:undefined,
      localHitRate:lookups?Number(cache.hits??0)/lookups:undefined, runnersAvailable:runners.length>0};
  }
  get counts() {
    const items=[...this.tests.values()];
    return {passed:items.filter(t=>t.status==='PASSED').length, failed:items.filter(t=>failure(t.status)).length,
      flaky:items.filter(t=>t.status==='FLAKY').length, cached:items.filter(t=>t.cached).length,
      finished:items.filter(t=>!['PENDING','RUNNING','NO_STATUS'].includes(t.status)).length, total:items.length};
  }
  /** Keep early diagnostics when a long build's normal log tail has moved past them. */
  get failureDetails() {
    if(this.diagnostics.length)return this.diagnostics.map(block=>block.join('\r\n')).join('\r\n\r\n');
    const recent=[...this.log,...(this.partial.trim()?[this.sgr+this.partial+'\x1b[0m']:[])];
    return recent.filter(line=>!/^\s*\[\s*[\d,]+\s*\/\s*[\d,]+\]/.test(clean(line)))
      .slice(-6).map(line=>line.slice(0,2048)+'\x1b[0m').join('\r\n');
  }
  private captureIssue(value:string) {
    const failed=value.match(/^FAIL: (\S+) .*\(see (\/\S+)\)/);
    if(failed)this.testLogs.set(failed[1],failed[2]);
    // error: kotlinc: Unresolved reference 'widget'.  /  In file: Bad.kt:4:13  /  →4 │     println(widget)
    const head=value.match(/^(error|warning): (?:[\w.-]+: )?(\S.*)$/);
    if(head) {this.headline={severity:head[1] as 'error'|'warning',message:head[2]};this.listing=this.openIssue=undefined;return;}
    const where=this.headline&&value.match(/^\s*In file: (.+?):(\d+)(?::(\d+))?\s*$/);
    if(where) {
      const {severity,message}=this.headline!;this.headline=undefined;
      const file=where[1],line=Number(where[2]);
      if(this.issues.length<8 && !this.issues.some(i=>i.file===file&&i.line===line&&i.message===message))
        this.issues.push(this.listing={severity,file,line,col:Number(where[3]??0),message,detail:[]});
      return;
    }
    const row=this.listing&&value.match(/^\s*(?:→|->|>)?\s*(\d+) [│|] ?(.*)$/);
    if(row) {
      // The tool's own listing is the excerpt: it is there even when the file is not readable from here.
      const excerpt=this.listing!.excerpt??=({start:Number(row[1]),lines:[]});
      if(excerpt.lines.length<7)excerpt.lines.push(row[2].slice(0,400));
      return;
    }
    this.listing=undefined;
    if(!/^\s*In file:/.test(value))this.headline=undefined;
    const found=parseDiagnostic(value);
    if(found) {
      this.openIssue=undefined;
      if(this.issues.length>=8 || this.issues.some(i=>i.file===found.file&&i.line===found.line&&i.message===found.message))return;
      const issue:Diagnostic={...found,detail:[]};
      // Compilers name files from the workspace root, which is where Bazel is run.
      const source=fileLines(isAbsolute(found.file)?found.file:resolve(found.file));
      if(source && found.line>=1 && found.line<=source.length) {
        const start=Math.max(1,found.line-2);
        issue.excerpt={start,lines:source.slice(start-1,found.line+2).map(l=>l.slice(0,400))};
      }
      this.issues.push(this.openIssue=issue);
    } else if(/^(?:INFO:|DEBUG:|ERROR:|FAIL|PASS|\s*\[\s*[\d,]+\s*\/)/.test(value)) this.openIssue=undefined;
    else if(this.openIssue && this.openIssue.detail.length<4 && !this.openIssue.excerpt) this.openIssue.detail.push(value.slice(0,400));
  }
  /** A failed test's log on this machine: the path Bazel printed, else the conventional one under bazel-testlogs. */
  testLog(label:string):string|undefined {
    const named=this.testLogs.get(label);
    if(named)return named;
    const [pkg,name]=label.replace(/^@*[^/]*\/\//,'').split(':');
    const guess=join(process.cwd(),'bazel-testlogs',pkg,name??'','test.log');
    return fileLines(guess)?guess:undefined;
  }
  private captureDiagnostic(value:string, colored:string) {
    const marker=/(?:^|\s)(?:ERROR|FATAL|FAIL(?:ED)?)(?::|\s)|\b(?:fatal\s+)?error(?:\[[^\]]+\]|\s+[A-Z]+\d+)?:|(?:^|\s)(?:[\w.]*Exception|AssertionError)(?::|\s|$)|^Traceback \(most recent call last\):|^e: |^\S+\.go:\d+:\d+: /.test(value);
    if(marker) {
      this.activeDiagnostic=[];
      // Preserve the first three causes and the most recent diagnostic, all bounded.
      if(this.diagnostics.length===4)this.diagnostics.pop();
      this.diagnostics.push(this.activeDiagnostic);
    } else if(/^(?:INFO:|DEBUG:|\s*\[\s*[\d,]+\s*\/|PASS(?:ED)?:)/.test(value)) {
      this.activeDiagnostic=undefined;
    }
    if(this.activeDiagnostic && this.activeDiagnostic.length<6)
      this.activeDiagnostic.push(colored.slice(0,2048)+'\x1b[0m');
  }
  output(text:string) {
    this.outputBuffer=(this.outputBuffer+text).slice(-32768);
    const normalized=clean(this.outputBuffer);
    const urls=[...normalized.matchAll(/https?:\/\/[^\s<>"'\x1b]+\/invocation\/[a-zA-Z0-9_-]+(?=[\s<>\"'])/g)];
    if (urls.length) this.buildbuddy=urls.at(-1)![0];
    const combined=this.partial+text;
    const lines=combined.split(/\r\n|\n|\r/);
    this.partial=lines.pop()!.slice(-8192);
    for (const line of lines) {
      const value=clean(line).slice(-8192); if (!value.trim()) continue;
      const colored=line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, seq=>seq.endsWith('m')?seq:'');
      this.log.push(this.sgr+colored+'\x1b[0m');
      this.captureDiagnostic(value,this.sgr+colored);
      this.captureIssue(value);
      for(const match of colored.matchAll(/\x1b\[([0-9;:]*)m/g)) {
        if(match[1]==='' || match[1]==='0') this.sgr='';
        else this.sgr=(this.sgr+match[0]).slice(-512);
      }
      this.observe(value,true);
    }
    this.observe(clean(this.partial));
    // Trim in blocks: a log that only grows reaches the native terminal as appends.
    if (this.log.length>LOG_LINES+LOG_SLACK) this.log.splice(0,this.log.length-LOG_LINES);
  }
  /** Large builds analyze, execute and test at once: the phase names the furthest stage reached. */
  private advance(phase:string) {
    const order=['Starting','Loading','Analyzing','Executing','Testing'];
    if(order.indexOf(phase)>order.indexOf(this.phase))this.phase=phase;
  }
  private observe(line:string, sample=false) {
    if (!line.trim()) return;
    this.lastActivity=Date.now();
    const progress=line.match(/\[\s*([\d,]+)\s*\/\s*([\d,]+)\]/);
    if (progress) {
      this.actionsDone=Number(progress[1].replaceAll(',','')); this.actionsTotal=Number(progress[2].replaceAll(',',''));
      this.activity=line.replace(/^.*?\]\s*/,''); this.advance('Executing');
      // `…; 12s remote-cache`: the strategy of the action the line names.
      const strategy=sample&&line.match(/;\s*\d+s\s+([a-z][a-z0-9-]*)/);
      if(strategy)this.strategies.set(strategy[1],(this.strategies.get(strategy[1])??0)+1);
    } else if (/^(INFO: )?(Analyzing|Loading|Computing|Fetching|Building|Testing)/.test(line)) {
      this.activity=line.replace(/^INFO: /,'');
      if (/Analyzing/.test(line)) this.advance('Analyzing');
      else if (/Loading|Computing|Fetching/.test(line)) this.advance('Loading');
    }
  }
  /** Sampled strategies grouped the way the finished build reports them. */
  get running() {
    let remoteCache=0,remote=0,local=0,disk=0,other=0;
    for(const [name,n] of this.strategies) {
      if(name==='remote-cache')remoteCache+=n; else if(name==='disk-cache')disk+=n; else if(name==='remote')remote+=n;
      else if(/sandbox|worker|local|standalone|processwrapper/.test(name))local+=n; else other+=n;
    }
    return {remoteCache,remote,local,disk,other,total:remoteCache+remote+local+disk+other};
  }
  event(e:any) {
    this.events++;
    if (e.started) { this.invocation=e.started.uuid ?? ''; this.advance('Loading'); }
    if (e.optionsParsed) this.eventFiles=(e.optionsParsed.cmdLine ?? []).filter((o:unknown)=>typeof o==='string'&&o.startsWith('--build_event_json_file=')).map((o:string)=>o.slice(24));
    if (e.progress) {
      const text=clean((e.progress.stderr ?? '')+(e.progress.stdout ?? ''));
      for (const line of text.split(/[\r\n]/)) this.observe(line);
      const match=text.match(/https?:\/\/[^\s<>"']+\/invocation\/[a-zA-Z0-9_-]+(?=[\s<>\"'])/);
      if (match) this.buildbuddy=match[0];
    }
    const id=e.id ?? {};
    if (e.configured && id.targetConfigured?.label) {
      const label=id.targetConfigured.label;
      if (!this.targets.has(label)) this.targets.set(label,null);
      if (e.configured.testSize && !this.tests.has(label)) this.tests.set(label,{label,status:'PENDING',duration:0,cached:false,logs:[]});
      this.advance('Analyzing');
    }
    if (e.completed && id.targetCompleted?.label && !id.targetCompleted.aspect) {
      this.targets.set(id.targetCompleted.label,!!e.completed.success); this.advance('Executing');
    }
    if (e.testResult && id.testResult?.label) {
      const label=id.testResult.label, old=this.tests.get(label);
      const remote=!!e.testResult.executionInfo?.cachedRemotely, local=!!e.testResult.cachedLocally;
      this.testRuns[remote?'remote':local?'local':'executed']++;
      // A failed attempt is news at once; a pass waits for the summary, which knows about other shards and retries.
      const attempt=String(e.testResult.status ?? '');
      if (!old || old.status==='PENDING' || old.status==='RUNNING') this.tests.set(label,{
        label,status:attempt&&attempt!=='PASSED'&&failure(attempt)?attempt:'RUNNING',duration:Number(e.testResult.testAttemptDurationMillis ?? 0),
        cached:remote||local,
        logs:(e.testResult.testActionOutput ?? []).map((o:any)=>o.uri).filter(Boolean),
      });
      this.advance('Testing');
    }
    if (e.testSummary && id.testSummary?.label) {
      const label=id.testSummary.label, sum=e.testSummary, old=this.tests.get(label);
      const logs=[...(sum.failed ?? []),...(sum.passed ?? [])].map((o:any)=>o.uri).filter(Boolean);
      this.tests.set(label,{label,status:sum.overallStatus ?? 'NO_STATUS',
        duration:Number(sum.totalRunDurationMillis ?? (Number(sum.totalRunDuration?.seconds ?? 0)*1000)) || 0,
        cached:Number(sum.totalNumCached ?? 0)>0 || old?.cached || false, logs: logs.length ? logs : old?.logs ?? []});
      this.advance('Testing');
    }
    if (e.buildMetrics) this.metrics=e.buildMetrics;
    if (e.finished) { this.exitCode=Number(e.finished.exitCode?.code ?? (e.finished.overallSuccess ? 0:1)); this.phase='Finishing'; }
  }
  get throughput() {
    return this.actionSamples.slice(1).map((p,i)=>Math.max(0,p.completed-this.actionSamples[i].completed)*1000/(p.at-this.actionSamples[i].at));
  }
  private sampleResults(now:number, force=false) {
    if(!this.tests.size || (!force && this.resultSamples.length && now-this.resultSamples.at(-1)!.at<1000))return;
    const counts=this.counts;
    this.resultSamples.push({at:now,passed:counts.passed,failed:counts.failed});
    // A long run keeps its whole shape at half the resolution rather than only its tail.
    if(this.resultSamples.length>120)this.resultSamples=this.resultSamples.filter((_,i)=>i%2===0);
  }
  sample(now=Date.now()) {
    this.sampleResults(now);
    if(!this.actionsTotal || (this.actionSamples.length && now-this.actionSamples.at(-1)!.at<1000))return;
    this.actionSamples.push({at:now,completed:this.actionsDone});
    if(this.actionSamples.length>61)this.actionSamples.shift();
  }
  finish(code:number) { this.output('\n'); this.exitCode=code; this.ended=Date.now(); this.sampleResults(this.ended,true); this.phase=code===0?'Complete':code===130?'Cancelled':'Failed'; }
  /** Tests are only part of the page for commands that run them. */
  get testing() { return this.command==='test'||this.command==='coverage'; }
}

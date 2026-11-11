import { StringDecoder } from 'node:string_decoder';

const COMMANDS = new Set(['build','test','coverage','run','query','cquery','aquery','info','clean','shutdown','version','help','fetch','sync','mod','license','canonicalize-flags','dump','analyze-profile','mobile-install','print_action','vendor']);
export function planInvocation(args: string[], localBep: string, native = false) {
  const end = args.indexOf('--');
  const before = end < 0 ? args : args.slice(0,end);
  const startupValues = new Set(['--output_base','--output_user_root','--install_base','--server_javabase','--host_jvm_args','--bazelrc','--io_nice_level','--max_idle_secs','--connect_timeout_secs','--command_port','--digest_function','--failure_detail_out','--invocation_policy','--local_startup_timeout_secs','--macos_qos_class','--unix_digest_hash_attribute_name']);
  let at=-1;
  for(let i=0;i<before.length;i++) {
    if(startupValues.has(before[i])) { i++; continue; }
    if(!before[i].startsWith('-')) { if(COMMANDS.has(before[i]))at=i; break; }
  }
  const command = before[at] ?? '';
  const supported = ['build','test','coverage'].includes(command);
  let bep = localBep;
  let existing = false;
  for (let i=at+1;i<before.length;i++) {
    if (before[i].startsWith('--build_event_json_file=')) { bep = before[i].slice(24); existing=true; }
    if (before[i] === '--build_event_json_file') { bep=before[++i] ?? ''; existing=true; }
  }
  return { command, supported, bep, owned: !existing, args: supported
    ? [...args.slice(0,at+1), ...(native ? ['--color=yes','--curses=no'] : []), ...(!existing ? [`--build_event_json_file=${localBep}`] : []), ...args.slice(at+1)] : [...args] };
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
export type TestInfo = {label:string; status:string; duration:number; cached:boolean; logs:string[]};
export const failure = (status:string) => !['PASSED','FLAKY','PENDING','RUNNING','NO_STATUS'].includes(status);
export class BuildState {
  started = Date.now(); ended?:number; exitCode:number|null = null;
  phase='Starting'; activity='Waiting for Bazel'; buildbuddy=''; invocation='';
  tests=new Map<string,TestInfo>(); targets=new Map<string,boolean|null>();
  log:string[]=[]; partial=''; events=0; lastActivity=Date.now();
  actionsDone=0; actionsTotal=0; history:number[]=[]; actionSamples:{at:number;completed:number}[]=[]; metrics:any=null; logFile=''; note='';
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
      for(const match of colored.matchAll(/\x1b\[([0-9;:]*)m/g)) {
        if(match[1]==='' || match[1]==='0') this.sgr='';
        else this.sgr=(this.sgr+match[0]).slice(-512);
      }
      this.observe(value);
    }
    this.observe(clean(this.partial));
    if (this.log.length>200) this.log.splice(0,this.log.length-200);
  }
  private observe(line:string) {
    if (!line.trim()) return;
    this.lastActivity=Date.now();
    const progress=line.match(/\[\s*([\d,]+)\s*\/\s*([\d,]+)\]/);
    if (progress) {
      this.actionsDone=Number(progress[1].replaceAll(',','')); this.actionsTotal=Number(progress[2].replaceAll(',',''));
      this.activity=line.replace(/^.*?\]\s*/,''); this.phase='Executing';
    } else if (/^(INFO: )?(Analyzing|Loading|Computing|Fetching|Building|Testing)/.test(line)) {
      this.activity=line.replace(/^INFO: /,'');
      if (/Analyzing/.test(line)) this.phase='Analyzing';
      else if (/Loading|Computing|Fetching/.test(line)) this.phase='Loading';
    }
  }
  event(e:any) {
    this.events++;
    if (e.started) { this.invocation=e.started.uuid ?? ''; this.phase='Loading'; }
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
      this.phase='Analyzing';
    }
    if (e.completed && id.targetCompleted?.label && !id.targetCompleted.aspect) {
      this.targets.set(id.targetCompleted.label,!!e.completed.success); this.phase='Executing';
    }
    if (e.testResult && id.testResult?.label) {
      const label=id.testResult.label, old=this.tests.get(label);
      if (!old || old.status==='PENDING' || old.status==='RUNNING') this.tests.set(label,{
        label,status:'RUNNING',duration:Number(e.testResult.testAttemptDurationMillis ?? 0),
        cached:!!(e.testResult.cachedLocally || e.testResult.executionInfo?.cachedRemotely),
        logs:(e.testResult.testActionOutput ?? []).map((o:any)=>o.uri).filter(Boolean),
      });
      this.phase='Testing';
    }
    if (e.testSummary && id.testSummary?.label) {
      const label=id.testSummary.label, sum=e.testSummary, old=this.tests.get(label);
      const logs=[...(sum.failed ?? []),...(sum.passed ?? [])].map((o:any)=>o.uri).filter(Boolean);
      this.tests.set(label,{label,status:sum.overallStatus ?? 'NO_STATUS',
        duration:Number(sum.totalRunDurationMillis ?? (Number(sum.totalRunDuration?.seconds ?? 0)*1000)) || 0,
        cached:Number(sum.totalNumCached ?? 0)>0 || old?.cached || false, logs: logs.length ? logs : old?.logs ?? []});
      this.phase='Testing';
    }
    if (e.buildMetrics) this.metrics=e.buildMetrics;
    if (e.finished) { this.exitCode=Number(e.finished.exitCode?.code ?? (e.finished.overallSuccess ? 0:1)); this.phase='Finishing'; }
  }
  get throughput() {
    return this.actionSamples.slice(1).map((p,i)=>Math.max(0,p.completed-this.actionSamples[i].completed)*1000/(p.at-this.actionSamples[i].at));
  }
  sample(now=Date.now()) {
    if(!this.actionsTotal || (this.actionSamples.length && now-this.actionSamples.at(-1)!.at<1000))return;
    this.actionSamples.push({at:now,completed:this.actionsDone});
    if(this.actionSamples.length>61)this.actionSamples.shift();
  }
  finish(code:number) { this.output('\n'); this.exitCode=code; this.ended=Date.now(); this.phase=code===0?'Complete':code===130?'Cancelled':'Failed'; }
}

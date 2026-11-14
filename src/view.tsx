import { span, type JSX, type KvItem, type StatItem, type Tone } from '@stencil-hq/tern';
type Node = JSX.Element;
import { pathToFileURL } from 'node:url';
import { relative } from 'node:path';
import { BuildState, clean, failure, fileLines, testGroups, type Diagnostic, type TestInfo } from './core.js';
import { invocationLinks, type InvocationLink } from './buildbuddy.js';
import { reportedDetails, reportedTotals } from './metrics.js';
import { QueryState } from './query.js';

export type ViewState = {tab:string; selected:string; paused:boolean; expanded:boolean};
export const duration = (ms:number) => ms<1000 ? `${Math.round(ms)} ms` : ms<60000 ? `${(ms/1000).toFixed(1)} s` : `${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`;
const count = (n:number) => n.toLocaleString('en-US');
const percent = (n:number) => `${Math.round(n*100)}%`;
const plural = (n:number, one:string, many=one+'s') => `${count(n)} ${n===1?one:many}`;
const tone = (status:string):Tone => status==='PASSED'?'success':status==='FLAKY'?'warning':failure(status)?'error':'muted';
const TITLES:Record<string,string> = {build:'Build',test:'Tests',coverage:'Coverage',run:'Run',query:'Query',cquery:'Configured query'};
/** Sans lines are 18px; the pane's own rows (`cell`) set the terminal's. */
const LINE=18;

/** The keys the program takes, shown while it can still take them. */
const legend = (keys:[string,string][]) => <text key="keys" spans={keys.flatMap(([key,label])=>[span(key,'key'),span(` ${label}    `,'muted')])} />;

/** Page name, what it ran on, then state and the links out: the same row on every page. */
function head(title:string, subject:string, clock:Node, state:{text:string;tone:Tone}, actions:Node|false) {
  return <row key="head" justify="between" align="center" gap="md">
    <text grow={1} min={{w:'0ch'}} truncate="middle" title={subject} spans={[span(title,'title'),span('   '),span(subject,'mono muted')]} />
    <row gap="sm" align="center" shrink={0}>
      {clock}
      <badge key="phase" text={state.text} tone={state.tone} />
      {actions}
    </row>
  </row>;
}
const clock = (started:number, ended?:number) => <elapsed key="clock" tone="muted" age={Date.now()-started} stopped={ended===undefined?undefined:ended-started} format="clock" />;
const open = (link:InvocationLink, icon?:'open') => <button key={link.label} icon={icon} href={link.href} actions={{click:'open'}}>{link.label}</button>;
/** Links work from the retained summary: Tern opens them without the program. */
const results = (links:InvocationLink[]) => links.length>1
  ? <buttons key="links" size="sm" label="Build results">{links.map((link,i)=>open(link,i===0?'open':undefined))}</buttons>
  : links.length===1 && <button key="links" size="sm" icon="open" href={links[0].href} actions={{click:'open'}}>{links[0].label}</button>;

function summary(s:BuildState) {
  const done=s.ended!==undefined, failed=done&&s.exitCode!==0;
  const execution=s.execution;
  const subject=s.args.slice(0,s.args.includes('--')?s.args.indexOf('--'):undefined).filter(a=>a.startsWith('//')||a.startsWith('@')||a==='...').slice(0,3).join(' ')||'workspace';
  const links=invocationLinks(s.buildbuddy,{failed,remoteExecution:!!execution?.remote,buildbuddy:process.env.TERN_BAZEL_BUILDBUDDY==='1'});
  const state:Tone=done?(s.exitCode===0?'success':s.exitCode===130?'warning':'error'):'accent';
  return {done,failed,execution,subject,links,state};
}

export function dashboard(s:BuildState, v:ViewState, update:()=>void, cols=110, rows=40, cell=16) {
  const {done,failed,execution,subject,links,state}=summary(s);
  const testing=s.testing, counts=s.counts, interrupted=s.exitCode===130;
  const compact=cols<100 || rows<28;
  // Expanded, the log takes the room of the tiles and the test table; the chart row stays.
  const focus=v.expanded&&!done;
  // A test run is a page of results whether or not every test passed. Only a build that broke is an error card.
  const page=testing&&counts.total>0;
  const crash=failed&&!(page&&s.exitCode===3);
  const openable=(uri?:string)=>uri&&/^(?:file|https?):/.test(uri)?uri:undefined;
  // A log Tern can open: the one the event named, else the copy Bazel left on this machine.
  const logOf=(t?:TestInfo)=>{if(!t)return undefined;const local=openable(t.logs[0])?undefined:s.testLog(t.label);return openable(t.logs[0])??(local?pathToFileURL(local).href:undefined);};
  /** A problem as a place to go, what the tool said, and the source it is about. */
  // What a tool said about source comes before Bazel's note of which target that broke.
  const rank=(d:Diagnostic)=>(/(?:^|\/)BUILD(?:\.bazel)?$/.test(d.file)?2:0)+(d.severity==='warning'?1:0);
  const issues=[...s.issues].sort((a,b)=>rank(a)-rank(b));
  const short=(file:string)=>{const rel=relative(process.cwd(),file);return file.startsWith('/')&&!rel.startsWith('..')?rel:file;};
  const issue=(d:Diagnostic,i:number)=><col key={`issue-${i}`} gap="xs">
    <row gap="sm" align="center">
      <badge text={d.severity} tone={d.severity==='error'?'error':'warning'} />
      <text grow={1} min={{w:'0ch'}} truncate="middle" href={`${d.file}:${d.line}${d.col?`:${d.col}`:''}`} title={`Open ${d.file} at line ${d.line}`} spans={[span(short(d.file),'path'),span(`:${d.line}${d.col?`:${d.col}`:''}`,'mono muted')]} />
    </row>
    <text spans={[span(d.message,'strong')]} />
    {d.excerpt
      ?<code key="source" path={short(d.file)} numbers start={d.excerpt.start} text={d.excerpt.lines.join('\n')} marks={[{line:d.line,tone:d.severity==='error'?'error':'warning'}]} />
      :d.detail.length>0&&<code key="detail" text={d.detail.join('\n')} />}
  </col>;
  const completed=[...s.targets.values()].filter(t=>t!==null).length;
  const failedTargets=[...s.targets].filter(([,ok])=>ok===false);
  const all=[...s.tests.values()].sort((a,b)=>Number(failure(b.status))-Number(failure(a.status)) || b.duration-a.duration || a.label.localeCompare(b.label));
  const filtered=all.filter(t=>v.tab!=='failures'||failure(t.status));
  const selected=filtered.find(t=>t.label===v.selected);
  const progress=s.actionsTotal?Math.min(s.actionsDone/s.actionsTotal,1):undefined;
  const rates=s.throughput;
  const usefulRates=rates.length>1&&rates.some(n=>n>0);
  const details=reportedDetails(s.metrics), timings=[...details.timings,...reportedTotals(s.metrics)];
  const cache=s.metrics?.actionSummary?.actionCacheStatistics;

  // At most four tiles. A tone marks a value that needs attention, nothing else.
  const runs=s.testRuns, ran=runs.remote+runs.local+runs.executed;
  const stats:StatItem[]=[];
  if(page) {
    const waiting=counts.total-counts.finished;
    stats.push({label:'Tests',value:`${count(counts.finished)} / ${count(counts.total)}`,sub:waiting?`${count(waiting)} ${done?'not run':'to go'}`:'all finished'});
    stats.push({label:'Pass rate',value:counts.finished?percent(counts.passed/counts.finished):'—',sub:`${count(counts.passed)} passed`});
    stats.push({label:'Failed',value:count(counts.failed),tone:counts.failed?'error':undefined,sub:counts.flaky?`${count(counts.flaky)} flaky`:counts.failed?'need attention':'none'});
    if(ran)stats.push({label:'Cached',value:percent((runs.remote+runs.local)/ran),sub:[runs.remote&&`${count(runs.remote)} remote`,runs.local&&`${count(runs.local)} local`,runs.executed&&`${count(runs.executed)} ran`].filter(Boolean).join(' · ')});
  }
  if(s.actionsTotal)stats.push({label:'Actions',value:count(s.actionsDone),sub:done?'completed':`of ${count(s.actionsTotal)} discovered`});
  if(s.targets.size)stats.push({label:'Targets',value:`${count(completed)} / ${count(s.targets.size)}`,sub:failedTargets.length?`${failedTargets.length} failed`:done?'built':'completed',tone:failedTargets.length?'error':undefined});
  if(execution?.remoteHits)stats.push({label:'Remote cache',value:percent(execution.remoteShare??0),sub:`${count(execution.remoteHits)} of ${count(execution.total)} processes`,title:'Share of non-internal processes served from remote cache, not lookup hit rate'});
  if(execution?.localHitRate!==undefined)stats.push({label:'Action cache',value:percent(execution.localHitRate),sub:`${count(Number(cache?.hits??0))} hits · ${count(Number(cache?.misses??0))} misses`,title:'Local action cache lookups: hits / (hits + misses)'});

  const distribution=execution ? [
    {value:execution.remoteHits,token:'success',label:'Remote cache'},
    {value:execution.remote,token:'accent',label:'Remote execution'},
    {value:execution.local,token:'warning',label:'Local execution'},
    {value:execution.diskHits,token:'info',label:'Disk cache'},
    {value:execution.other,token:'muted',label:'Other'},
  ].filter(p=>p.value>0):[];
  const testMix=[{value:counts.passed,label:'Passed',token:'success'},{value:counts.failed,label:'Failed',token:'error'},{value:counts.flaky,label:'Flaky',token:'warning'},{value:counts.total-counts.finished,label:'Pending',token:'muted'}].filter(p=>p.value>0);
  // Each panel names one split of a whole; they wrap rather than squeeze.
  const panel=(key:string,label:string,child:Node,note='')=><col key={key} gap="sm" grow={1} basis={0} min={{w:'30ch'}} max={{w:'42ch'}}><text title={note||undefined} spans={[span(label,'muted'),...(note?[span(`  ${note}`,'dim')]:[])]} />{child}</col>;
  // Tests report while Bazel is still finding more of them, so their charts are live.
  const outcomes=testing&&counts.total>0&&panel('outcomes','Test outcomes',<chart key="test-ring" kind="donut" size="sm" series={testMix} total={count(counts.finished)} caption={`of ${count(counts.total)} finished`} />);
  const testCache=testing&&ran>0&&panel('test-cache','Test cache',<chart key="test-cache-ring" kind="donut" size="sm" total={percent((runs.remote+runs.local)/ran)} caption="results cached"
    series={[{value:runs.remote,label:'Remote cache',token:'success'},{value:runs.local,label:'Local cache',token:'accent'},{value:runs.executed,label:'Executed',token:'muted'}].filter(p=>p.value>0)} />);
  const samples=s.resultSamples;
  const overTime=page&&samples.length>1&&panel('over-time','Results over time',<chart key="results-line" kind="line" size="sm" aria="Passed and failed tests over time"
    labels={samples.map((p,i)=>i===0||i===samples.length-1?duration(p.at-s.started):'')}
    series={[{label:'Passed',token:'success',values:samples.map(p=>p.passed)},{label:'Failed',token:'error',values:samples.map(p=>p.failed)}]} />);
  // One square per hundredth of the suite: how much is green, how much is red, how much is still to come.
  const suite=page&&panel('suite','Suite',<row key="waffle" gap="md" align="start">
    <meter key="blocks" style="blocks" size="lg" title={testMix.map(p=>`${p.label} ${count(p.value)}`).join(' · ')} parts={testMix.map(p=>({value:p.value/counts.total,token:p.token,label:p.label}))} />
    <kv key="legend" items={testMix.map(p=>({k:[span('■ ',p.token),span(p.label,'muted')],v:[span(count(p.value),'mono')]}))} />
  </row>);
  const mix=distribution.length>0&&panel('distribution','Execution mix',<chart key="execution-ring" kind="donut" size="sm" series={distribution} total={count(execution!.total)} caption="processes" />);
  // Until Bazel reports totals, the strategies its progress lines name are the only live view of where work runs.
  const sampled=s.running, seen=[
    {value:sampled.remoteCache,token:'success',label:'Remote cache'},
    {value:sampled.remote,token:'accent',label:'Remote execution'},
    {value:sampled.local,token:'warning',label:'Local execution'},
    {value:sampled.disk,token:'info',label:'Disk cache'},
    {value:sampled.other,token:'muted',label:'Other'},
  ].filter(p=>p.value>0);
  const strategies=!done&&!mix&&seen.length>0&&panel('strategies','Running on',<chart key="strategy-ring" kind="donut" size="sm" series={seen} total={count(sampled.total)} caption="actions seen" />,'sampled from progress');
  const rate=!done&&usefulRates&&panel('rate','Throughput',<chart key="rate" aria="Action throughput" kind={focus?'bars':'area'} size={focus?'md':'sm'} token="accent" min={0} unit="actions/s"
    series={rates.map((value,i)=>({value,title:`${value.toFixed(1)} actions/s · ${Math.round((s.actionSamples[i+1].at-s.started)/1000)}s into build`}))} />,focus?`${rates.at(-1)!.toFixed(1)} actions per second`:'actions per second');
  const types=done&&details.actionTypes.length>0&&panel('types','Action types',<chart key="types-ring" kind="donut" size="sm" series={details.actionTypes.map(p=>({...p,title:`${p.label}: ${count(p.value)} executed actions`}))} caption="executed" />);
  const timing=done&&timings.length>0&&panel('timing','Timing',<kv key="phases" title="Phases can overlap" items={timings.map(p=>({k:p.label,v:[span(duration(p.value),'mono')]}))} />);
  const panels=(focus?[rate,outcomes,testCache,strategies]:page?[overTime,suite,testCache,done?mix:rate]:done?[mix,types,timing]:[rate,strategies,mix]).filter((p):p is Node=>!!p).slice(0,3);
  const table=page&&!focus&&!crash;
  // A big suite reads by area first: where the failures are, then which tests.
  const groups=table?testGroups(all):[];
  const grouped=groups.length>1&&counts.total>12;
  const group=groups.find(g=>g.name===v.selected)??groups[0];

  // Budget the pane in px: command line, head, body, log header, keys and the prompt; the log gets what is left.
  const legendRows=page?Math.max(testMix.length,3):Math.max(0,done?Math.max(distribution.length,details.actionTypes.length,timings.length):Math.max(3,seen.length));
  const parts=crash?[]:[
    stats.length&&!focus?(compact?20:66):0,
    done?0:40,
    !panels.length?0:compact?(page?44:done?(mix?44:0)+(types||timing?24:0):rate?20:0):30+Math.max(98,legendRows*24),
    s.note?24:0,
  ].filter(h=>h>0);
  const room=rows*cell-(cell+32+(crash?0:36)+(done?0:30)+2*cell+16);
  const minLog=compact?4:6;
  // The test list takes what the rest leaves, between two and eight whole rows under its header.
  const tableExtra=grouped?0:(counts.failed&&!done?38:0)+(logOf(selected)?28:0);
  const fixed=parts.reduce((sum,h)=>sum+h,0)+10*parts.length;
  // Folded to its last line, the log leaves the page to the results.
  const testRows=table?Math.max(grouped?4:2,Math.min(grouped?18:14,(grouped?groups.length:filtered.length)||1,Math.floor((room-10-fixed-tableExtra-24-20)/24))):0;
  if(table)parts.push(tableExtra+(testRows+1)*24+20);
  // The detail card is as tall as the table beside it: its rows are 30px under a 40px head.
  // Why the area's first failure failed: the end of its log, when Bazel left one on this machine.
  const culprit=grouped&&!compact?group?.tests.filter(t=>failure(t.status)).slice(0,5).find(t=>s.testLog(t.label)):undefined;
  const tailLines=culprit?(fileLines(s.testLog(culprit.label)!)??[]).map(l=>clean(l)).filter(l=>l.trim()).slice(-6).map(l=>l.slice(0,300)):[];
  const tail=culprit&&tailLines.length?{name:culprit.label.split(/[:/]/).at(-1)??culprit.label,text:tailLines.join('\n')}:undefined;
  const shown=Math.max(2,Math.floor(((testRows+1)*24-40-24-(tail?28+tailLines.length*16:0))/30));
  const need=parts.reduce((sum,h)=>sum+h,0)+10*Math.max(0,parts.length-1);
  // Open, the log has what the chart row leaves while running; opened from the summary, a fixed window.
  const logRows=crash?0:done?Math.max(minLog,Math.min(16,Math.floor(rows*.4))):Math.max(minLog,Math.floor((room-need-10)/cell));
  const bodyLines=Math.max(3,Math.min(60,Math.floor((room-(focus?logRows*cell+10:0))/LINE)));
  const lastLine=clean(s.log.at(-1)??'').trim().slice(0,Math.max(20,cols-44));

  const failureHead=interrupted?'Interrupted':s.command==='run'||s.command==='build'?'Build failed':counts.failed?`${plural(counts.failed,'test')} failed`:`${TITLES[s.command]??'Bazel'} failed`;
  const body=crash ? <card key="diagnostics" tone={interrupted?'warning':'error'} icon={interrupted?'slash-circle':'x-circle'} head={failureHead}
      meta={[`exit ${s.exitCode}`,failedTargets.length&&plural(failedTargets.length,'failed target')].filter(Boolean).join(' · ')}
      end={s.logFile?<button key="full" size="sm" variant="quiet" icon="file" href={pathToFileURL(s.logFile).href} actions={{click:'open'}}>Full log</button>:undefined}>
      {issues.slice(0,4).map(issue)}
      {issues.length>4&&<text spans={[span(`and ${plural(issues.length-4,'more problem')} in the log`,'dim')]} />}
      {/* With problems read out above, the tool's own words fold away but stay one click from here. */}
      {s.issues.length>0
        ?<section key="raw" head="Bazel's output" collapsible collapsed><ansi key="errors" text={s.failureDetails||'No other output was captured.'} /></section>
        :<ansi key="errors" text={s.failureDetails || (interrupted?'Build interrupted.':`Bazel exited with status ${s.exitCode}. No diagnostic output was captured.`)} />}
      {all.filter(t=>failure(t.status)).slice(0,8).map(t=><row key={t.label} gap="sm" align="center">
        <text grow={1} min={{w:'0ch'}} truncate="middle" title={t.label} spans={[span(t.label,'mono')]} />
        <badge text={t.status.replaceAll('_',' ').toLowerCase()} tone={tone(t.status)} />
        {logOf(t)&&<button size="sm" variant="quiet" icon="file" href={logOf(t)} actions={{click:'open'}}>Test log</button>}
      </row>)}
      {failedTargets.filter(([label])=>!s.tests.has(label)||!failure(s.tests.get(label)!.status)).slice(0,4).map(([label])=><text key={label} truncate="middle" title={label} spans={[span(label,'mono')]} />)}
    </card> : <col key="healthy" gap="md">
      {stats.length>0&&!focus&&(compact
        ?<kv key="stats" layout="inline" items={stats.slice(0,3).map(item=>({k:item.label,v:[span(String(item.value),'strong '+(item.tone??''))]}))} />
        :<stats key="stats" items={stats.slice(0,4)} />)}
      {!done&&<col key="activity" gap="xs">
        <spinner style="dots" label={s.activity.slice(0,compact?85:160)} />
        <progress key="progress" value={progress} label={progress===undefined?undefined:percent(progress)} />
      </col>}
      {panels.length>0&&(compact
        ?(page
          ?<col key="suite" gap="xs"><meter style="bar" parts={testMix.map(p=>({value:p.value/counts.total,token:p.token,label:p.label}))} />
            <row gap="sm" wrap>{testMix.map(p=><text key={p.label} spans={[span(`${count(p.value)} `,'strong '+(p.token==='error'?'error':'')),span(p.label.toLowerCase(),'muted')]} />)}</row></col>
          :done
          ?mix&&<col key="distribution" gap="xs"><meter style="bar" parts={distribution.map(p=>({...p,value:p.value/execution!.total}))} />
            <row gap="sm" wrap>{distribution.map(p=><text key={p.label} spans={[span(`${count(p.value)} `,'strong'),span(p.label,'muted')]} />)}</row></col>
          :rate&&<row key="rate-line" gap="sm" align="center">
            <text spans={[span('Throughput','muted')]} />
            <chart key="rate" grow={1} aria="Action throughput" kind="spark" size="sm" token="accent" min={0} series={rates} />
            <text spans={[span(`${rates.at(-1)!.toFixed(1)} actions/s`,'mono')]} />
          </row>)
        :<row key="visuals" gap="lg" align="start" wrap>{panels}</row>)}
      {/* Small panes keep the rest one click away; folding is Tern's, so it works after exit. */}
      {compact&&(types||timing)&&<section key="more-metrics" head="Action types and timing" collapsible collapsed>
        <col gap="md">{types}{timing}</col>
      </section>}
      {table&&(grouped ? <row key="areas" gap="lg" align="start">
        <col grow={1} basis={0} min={{w:'0ch'}}>
          {/* Table rows are 24px, four thirds of a line, so the header and whole rows fit exactly. */}
          <scroll key="groups" variant="fade" noun="area" max={{h:`${Math.round((testRows+1)*24/LINE*1000)/1000}lines`}}>
            <table key="group-table" selectable={!done} selected={group?.name}
              cols={[{id:'name',head:'Area',grow:1,mono:true,truncate:'middle',priority:9},{id:'failed',head:'Failed',align:'end',mono:true,priority:8},{id:'passed',head:'Passed',align:'end',mono:true,priority:6},
                {id:'total',head:'Tests',align:'end',mono:true,priority:4},{id:'share',head:'Passing',priority:7},{id:'rate',head:'',align:'end',mono:true,priority:5}]}
              rows={groups.slice(0,60).map(g=>({id:g.name,title:`${g.name}: ${count(g.passed)} passed · ${count(g.failed)} failed · ${count(g.tests.length-g.finished)} to go`,cells:{
                name:g.failed?{text:g.name,dot:'error' as Tone}:g.name,
                failed:[span(count(g.failed),g.failed?'error':'dim')],passed:[span(count(g.passed),'muted')],total:[span(count(g.tests.length),'muted')],
                share:{meter:{parts:[{value:g.passed/g.tests.length,token:'success',label:'passed'},{value:g.failed/g.tests.length,token:'error',label:'failed'}]}},
                rate:[span(g.finished?percent(g.passed/g.finished):'—','muted')]}}))}
              onSelect={e=>{v.selected=String(e.item);update();}} />
          </scroll>
        </col>
        {!compact&&group&&<card key="area" icon={group.failed?'x-circle':'check'} tone={group.failed?undefined:'success'} head={group.name} min={{w:'44ch'}} max={{w:'56ch'}}
          meta={[group.failed&&`${count(group.failed)} failed`,`${count(group.passed)} passed`,group.tests.length-group.finished&&`${count(group.tests.length-group.finished)} to go`].filter(Boolean).join(' · ')}>
          {group.tests.slice(0,shown).map(t=><row key={t.label} gap="sm" align="center">
            <text grow={1} min={{w:'0ch'}} truncate="start" title={t.label} spans={[span(t.label.split(/[:/]/).at(-1)??t.label,'mono')]} />
            {t.duration>0&&<text shrink={0} wrap="none" spans={[span(duration(t.duration),'mono dim')]} />}
            <badge text={t.status.replaceAll('_',' ').toLowerCase()} tone={tone(t.status)} />
            {logOf(t)&&<button size="sm" variant="quiet" icon="file" title="Test log" aria="Test log" href={logOf(t)} actions={{click:'open'}} />}
          </row>)}
          {group.tests.length>shown&&<text spans={[span(`and ${count(group.tests.length-shown)} more`,'dim')]} />}
          {tail&&<col key="why" gap="xs">
            <text spans={[span(tail.name,'mono'),span('  test.log','dim')]} />
            <code key="tail" text={tail.text} />
          </col>}
        </card>}
      </row> : <col key="test-results" gap="sm">
        {counts.failed>0&&!done&&<tabs key="filter" variant="segmented" active={v.tab==='failures'?'failures':'tests'} items={[{id:'tests',label:'All tests'},{id:'failures',label:[span('Failures '),span(String(counts.failed),'muted')]}]} onSelect={e=>{v.tab=String(e.item);update();}} onChange={e=>{v.tab=String(e.value);update();}} />}
        {/* Table rows are 24px, four thirds of a line, so the header and whole rows fit exactly. */}
        <scroll key="tests" variant="fade" noun="test" max={{h:`${Math.round((testRows+1)*24/LINE*1000)/1000}lines`}}>
          <table key="table" selectable={!done} selected={selected?.label} empty="No tests yet"
            cols={[{id:'label',head:'Test',grow:1,mono:true,truncate:'middle',priority:3},{id:'status',head:'Result',priority:2},{id:'time',head:'Time',align:'end',mono:true,priority:1}]}
            rows={filtered.slice(0,50).map(t=>({id:t.label,cells:{label:t.label,status:{badge:{text:t.status.replaceAll('_',' ').toLowerCase(),tone:tone(t.status)}},time:t.duration?duration(t.duration):'—'}}))}
            onSelect={e=>{v.selected=String(e.item);update();}} />
        </scroll>
        {logOf(selected)&&<button size="sm" variant="quiet" icon="file" href={logOf(selected)} actions={{click:'open'}}>Selected test log</button>}
      </col>)}
    </col>;

  const stalled=!done&&Date.now()-s.lastActivity>15000;
  // Log toggles carry their own keycaps; the legend names the keys that have no button.
  const keys:[string,string][]=[['ctrl+c','interrupt'],...(table&&grouped?[['up','previous area'],['down','next area']] as [string,string][]:table&&counts.failed?[['tab','filter tests'] as [string,string]]:[])];
  return <col key="page"><col key="layout" role="build-layout" gap="md">
    {head(TITLES[s.command]??'Bazel',subject,clock(s.started,s.ended),{text:s.phase,tone:state},results(compact?links.slice(0,2):links))}
    <scroll key={crash?'failed-body':'body'} role="build-body" max={{h:`${bodyLines}lines`}}>
      <col gap="md">
        {body}
        {s.note&&<text key="note" spans={[span(s.note,'warning')]} />}
      </col>
    </scroll>
    {/* The log is one line until it is wanted: `l` or a click opens it, and Tern keeps that fold working after exit. */}
    {!crash&&<card key="logs" variant="bare" icon="terminal" collapsible collapsed={done?true:!v.expanded}
      head={[span('Build log','muted'),span(' · ','dim'),span(lastLine||'Waiting for output…','mono dim')]}
      onToggle={e=>{v.expanded=!e.collapsed;update();}}
      end={<row key="log-actions" gap="xs" align="center">
        {focus&&<button key="follow" size="sm" variant="quiet" on={!v.paused} keys={['p']} title={v.paused?'Follow new output':'Hold the log still'} onClick={()=>{v.paused=!v.paused;update();}}>Follow</button>}
        {!done&&<button key="expand" size="sm" variant="quiet" on={v.expanded} keys={['l']} title={v.expanded?'Fold the log back to its last line':'Open the log in place of the tiles and tests'} onClick={()=>{v.expanded=!v.expanded;update();}}>{v.expanded?'Contract':'Expand'}</button>}
        {s.logFile&&<button key="full" size="sm" variant="quiet" icon="file" href={pathToFileURL(s.logFile).href} actions={{click:'open'}}>Full log</button>}
      </row>}>
      {/* A scroll area takes the wheel; its height is whole terminal rows, written in the surface's taller lines. */}
      <scroll key="log" stick="end" pinned={!v.paused} max={{h:`${Math.round(logRows*cell/LINE*1000)/1000}lines`}}>
        <ansi key="tail" text={s.log.join('\r\n')||'Waiting for output…'} />
      </scroll>
    </card>}
    {!done&&<row key="foot" justify="between" align="center" gap="sm">
      {legend(keys)}
      {stalled&&<text spans={[span(`No output for ${duration(Date.now()-s.lastActivity)} · still running`,'muted')]} />}
    </row>}
  </col></col>;
}

/** What `run` leaves behind once the build is done: one line of facts, then the program's own output. */
export function launched(s:BuildState) {
  const {execution,subject,links}=summary(s);
  const facts:KvItem[]=[];
  if(s.actionsTotal)facts.push({k:'Actions',v:[span(count(s.actionsDone),'mono')]});
  if(s.targets.size)facts.push({k:'Targets',v:[span(String(s.targets.size),'mono')]});
  if(execution?.remoteHits)facts.push({k:'Remote cache',v:[span(percent(execution.remoteShare??0),'mono')]});
  return <col key="page" gap="sm">
    {head(TITLES.run,subject,clock(s.started,s.ended),{text:'Built',tone:'success'},results(links.slice(0,1)))}
    {facts.length>0&&<kv key="facts" layout="inline" items={facts} />}
  </col>;
}

export function queryView(q:QueryState, cols=110, rows=40, cell=16) {
  const title=TITLES[q.command]??'Query', compact=cols<100;
  const packages=q.output==='package';
  const noun:[string,string]=packages?['package','packages']:['target','targets'];
  const state:{text:string;tone:Tone}=!q.done?{text:'Running',tone:'accent'}:q.exitCode===130?{text:'Cancelled',tone:'warning'}:q.failed?{text:'Failed',tone:q.total?'warning':'error'}:{text:'Complete',tone:'success'};
  const file=q.done&&q.total>0&&!!q.resultsFile&&<button key="file" size="sm" icon="file" href={pathToFileURL(q.resultsFile).href} actions={{click:'open'}}>Open as text</button>;
  const stats:StatItem[]=[{label:packages?'Packages':'Targets',value:count(q.total),sub:q.total>q.rows.length?`first ${count(q.rows.length)} listed`:undefined}];
  if(!packages)stats.push({label:'Packages',value:count(q.packages.size)});
  if(q.rules)stats.push({label:'Rules',value:count(q.rules),sub:plural([...q.kinds.keys()].filter(k=>k!=='source file'&&k!=='generated file').length,'kind')});
  if(q.files)stats.push({label:'Files',value:count(q.files),sub:[q.kinds.get('source file')&&`${count(q.kinds.get('source file')!)} source`,q.kinds.get('generated file')&&`${count(q.kinds.get('generated file')!)} generated`].filter(Boolean).join(' · ')});
  if(q.configs.size>1)stats.push({label:'Configurations',value:count(q.configs.size)});
  const kinds=q.kinds.size>0&&!packages, configs=q.configs.size>0;
  // Leave the command line, head, stats and the prompt in view; the table scrolls inside the rest.
  // Table rows are four thirds of a line, so a multiple of four lines ends on a whole row.
  const tableLines=Math.max(8,Math.min(28,Math.floor((rows*cell-(3*cell+40+(compact?28:86)+48))/LINE/4)*4));
  const table=<scroll key="results" variant="fade" noun={noun} max={{h:`${tableLines}lines`}}>
    <table key="table" empty={`No ${noun[1]}`}
      cols={[{id:'label',head:packages?'Package':'Target',grow:1,mono:true,truncate:'middle',priority:9},
        ...(kinds?[{id:'kind',head:'Kind',priority:5}]:[]),...(configs?[{id:'config',head:'Configuration',mono:true,priority:1}]:[])]}
      rows={q.rows.map((r,i)=>({id:String(i),title:r.label,cells:{label:r.label,kind:[span(r.kind,'muted')],config:[span(r.config,'muted')]}}))} />
  </scroll>;
  const breakdown=!compact&&q.kinds.size>1&&!packages&&<card key="kinds" head="By kind" meta={plural(q.kinds.size,'kind')} min={{w:'40ch'}} max={{w:'48ch'}}>
    <chart key="kind-ring" kind="donut" size="sm" series={q.topKinds} caption={noun[1]} />
  </card>;
  const problem=q.failed&&<card key="error" tone={q.exitCode===130?'warning':q.total?'warning':'error'} icon={q.exitCode===130?'slash-circle':'x-circle'}
      head={q.exitCode===130?'Interrupted':q.total?'Results may be incomplete':'Query failed'} meta={`exit ${q.exitCode}`}>
    <ansi key="errors" text={q.errors||(q.exitCode===130?'Query interrupted.':`Bazel exited with status ${q.exitCode}. No diagnostic output was captured.`)} />
  </card>;
  return <col key="page" gap="md">
    {head(title,q.expression||'workspace',clock(q.started,q.ended),state,file)}
    {!q.done ? <col key="view" gap="md">
        <spinner style="dots" label={q.total?`${plural(q.total,noun[0],noun[1])} so far · ${q.activity}`:q.activity.slice(0,160)} />
        <skeleton shape="rows" rows={4} />
      </col>
      : <col key="view" gap="md">
        {problem}
        {q.total>0&&(compact
          ?<kv key="stats" layout="inline" items={stats.slice(0,3).map(item=>({k:item.label,v:[span(String(item.value),'strong')]}))} />
          :<stats key="stats" items={stats.slice(0,4)} />)}
        {q.total>0 ? <row key="split" gap="lg" align="start"><col grow={1} basis={0} min={{w:'0ch'}}>{table}</col>{breakdown}</row>
          : !q.failed&&<empty key="none" variant="inline" frame icon="search" title={`No ${noun[1]} match`} text={q.expression||'The query returned nothing.'} />}
        {q.unparsed>0&&<text key="unparsed" spans={[span(`${plural(q.unparsed,'line')} of other output ${q.unparsed===1?'is':'are'} in the text results.`,'muted')]} />}
        {q.note&&<text key="note" spans={[span(q.note,'warning')]} />}
      </col>}
    {!q.done&&<row key="foot" justify="between" align="center">{legend([['ctrl+c','interrupt']])}</row>}
  </col>;
}

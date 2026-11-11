import { span, type StatItem, type Tone } from '@stencil-hq/tern';
import { pathToFileURL } from 'node:url';
import { BuildState, failure } from './core.js';
import { invocationLinks } from './buildbuddy.js';
import { reportedDetails } from './metrics.js';
export type ViewState = {tab:string; selected:string; paused:boolean; expanded:boolean; confirm:boolean};
export const duration = (ms:number) => ms<1000 ? `${Math.round(ms)} ms` : ms<60000 ? `${(ms/1000).toFixed(1)} s` : `${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`;
const tone = (status:string):Tone => status==='PASSED'?'success':status==='FLAKY'?'warning':failure(status)?'error':'muted';

export function dashboard(s:BuildState, v:ViewState, update:()=>void, cancel:()=>void, cols=110, rows=40) {
  const done=s.ended!==undefined, failed=done&&s.exitCode!==0, testing=s.command!=='build', counts=s.counts;
  const compact=cols<100 || rows<32;
  // Reserve space for chrome, controls, and the real shell prompt. The body alone scrolls.
  const logLines=done?2:Math.min(v.expanded?12:compact?3:5,Math.max(2,rows-20));
  const bodyLines=Math.max(3,Math.min(done?22:28,Math.floor(rows)-13-(failed?0:logLines+2)));
  const resultTone:Tone=done?(s.exitCode===0?'success':s.exitCode===130?'warning':'error'):'accent';
  const completed=[...s.targets.values()].filter(t=>t!==null).length;
  const failedTargets=[...s.targets].filter(([,ok])=>ok===false);
  const all=[...s.tests.values()].sort((a,b)=>Number(failure(b.status))-Number(failure(a.status)) || b.duration-a.duration || a.label.localeCompare(b.label));
  const filtered=all.filter(t=>v.tab!=='failures'||failure(t.status));
  const selected=filtered.find(t=>t.label===v.selected);
  const labels=s.args.filter(a=>a.startsWith('//')||a.startsWith('@')||a==='...').slice(0,3).join(' ')||'workspace';
  const progress=s.actionsTotal?Math.min(s.actionsDone/s.actionsTotal,1):undefined;
  const execution=s.execution;
  const links=invocationLinks(s.buildbuddy,{failed,remoteExecution:!!execution?.remote,buildbuddy:process.env.TERN_BAZEL_BUILDBUDDY==='1'});
  const distribution=execution ? [
    {value:execution.remoteHits,token:'success',label:'Remote cache'},
    {value:execution.remote,token:'accent',label:'Remote execution'},
    {value:execution.local,token:'warning',label:'Local execution'},
    {value:execution.diskHits,token:'info',label:'Disk cache'},
    {value:execution.other,token:'muted',label:'Other'},
  ].filter(p=>p.value>0):[];
  const details=reportedDetails(s.metrics);
  const rates=s.throughput;
  const usefulRates=rates.length>1&&rates.some(n=>n>0);
  const stats:StatItem[]=[];
  if(testing&&counts.total)stats.push({label:'TESTS',value:`${counts.finished} / ${counts.total}`,sub:`${counts.passed} passed${counts.failed?` · ${counts.failed} failed`:''}`,tone:counts.failed?'error':'success'});
  else if(s.actionsTotal)stats.push({label:'ACTIONS',value:s.actionsDone.toLocaleString(),sub:`of ${s.actionsTotal.toLocaleString()} discovered`,tone:resultTone});
  if(s.targets.size)stats.push({label:'TARGETS',value:`${completed} / ${s.targets.size}`,sub:failedTargets.length?`${failedTargets.length} failed`:'completed',tone:failedTargets.length?'error':undefined});
  if(execution?.remoteHits)stats.push({label:'REMOTE CACHE SHARE',value:`${Math.round((execution.remoteShare??0)*100)}%`,sub:`${execution.remoteHits.toLocaleString()} processes reused`,tone:'success',title:'Share of non-internal processes served from remote cache, not lookup hit rate'});
  if(execution?.remote)stats.push({label:'REMOTE EXECUTION',value:execution.remote.toLocaleString(),sub:'processes executed',tone:'accent'});
  const testMix=[{value:counts.passed,label:'Passed',token:'success'},{value:counts.failed,label:'Failed',token:'error'},{value:counts.flaky,label:'Flaky',token:'warning'},{value:counts.total-counts.finished,label:'Pending',token:'muted'}].filter(p=>p.value>0);
  const logText=[...s.log.slice(v.expanded?-40:-8),...(s.partial.trim()?[s.partial]:[])].join('\r\n')||'Waiting for output…';
  const cache=execution?.localHitRate!==undefined && <col key="cache" grow={1} basis={0} min={{w:'0ch'}} gap="sm">
    <text spans={[span('Local action cache','strong')]} />
    <chart key="cache-ring" kind="donut" size="sm" total={`${Math.round(execution.localHitRate*100)}%`} caption="hit rate" series={[{value:Number(s.metrics.actionSummary.actionCacheStatistics.hits??0),label:'Hits',token:'success'},{value:Number(s.metrics.actionSummary.actionCacheStatistics.misses??0),label:'Misses',token:'warning'}]} />
  </col>;
  const outcome=testing&&counts.total>0 && <col key="outcomes" grow={1} basis={0} min={{w:'0ch'}} gap="sm">
    <text spans={[span('Test outcomes','strong')]} />
    <chart key="test-ring" kind="donut" size="sm" series={testMix} total={`${counts.finished}/${counts.total}`} caption="tests finished" />
  </col>;
  const mix=distribution.length>0 && <col key="distribution" grow={1} basis={0} min={{w:'0ch'}} gap="sm">
    <text spans={[span('Execution mix','strong')]} />
    {compact?<col gap="xs"><meter style="bar" parts={distribution.map(p=>({...p,value:p.value/execution!.total}))} />
      <row gap="sm" wrap>{distribution.map(p=><text key={p.label} spans={[span(`${p.value.toLocaleString()} `,'strong '+p.token),span(p.label,'muted')]} />)}</row>
    </col>:<chart key="execution-ring" kind="donut" size="sm" series={distribution} total={execution!.total.toLocaleString()} caption="reported processes" />}
  </col>;
  return <col key="page"><col key="layout" role="build-layout" gap="sm">
    <row key="head" justify="between" align="center" gap="sm">
      <row gap="sm" align="center" min={{w:'0ch'}}>
        <text spans={[span(s.command==='build'?'Build':s.command==='coverage'?'Coverage':'Tests','strong')]} />
        <badge key="phase" text={failed?`${s.phase} · ${s.exitCode}`:s.phase} tone={resultTone} />
        <elapsed key="clock" age={Date.now()-s.started} stopped={done?s.ended!-s.started:undefined} format="clock" />
      </row>
      {links[0] && <button key="buddy" size="sm" variant="primary" icon="open" href={links[0].href} actions={{click:'open'}}>{links[0].label}</button>}
    </row>
    <text key="target" truncate="middle" title={labels} spans={[span(labels,'mono muted')]} />
    <scroll key={failed?'failed-body':'body'} role="build-body" max={{h:`${bodyLines}lines`}}>
      <col gap="md">
        {failed ? <col key="diagnostics" gap="sm">
          <text spans={[span(s.exitCode===130?'Interrupted':'Error details','strong'),span(counts.failed?` · ${counts.failed} failed test${counts.failed===1?'':'s'}`:failedTargets.length?` · ${failedTargets.length} failed target${failedTargets.length===1?'':'s'}`:'','error')]} />
          <ansi key="errors" text={s.failureDetails || (s.exitCode===130?'Build interrupted.':`Bazel exited with status ${s.exitCode}. No diagnostic output was captured.`)} />
          {all.filter(t=>failure(t.status)).slice(0,8).map(t=><row key={t.label} gap="sm" align="center">
            <text grow={1} min={{w:'0ch'}} truncate="middle" title={t.label} spans={[span(t.label,'mono error')]} />
            <badge text={t.status.replaceAll('_',' ')} tone={tone(t.status)} />
            {t.logs[0]&&<button size="sm" variant="quiet" href={t.logs[0]} actions={{click:'open'}}>Test log</button>}
          </row>)}
          {failedTargets.filter(([label])=>!s.tests.has(label)||!failure(s.tests.get(label)!.status)).slice(0,4).map(([label])=><text key={label} truncate="middle" title={label} spans={[span(label,'mono error')]} />)}
        </col> : <col key="healthy" gap="md">
          {stats.length>0&&(compact?<row key="stats" gap="md" wrap>{stats.slice(0,3).map(item=><text key={String(item.label)} title={String(item.sub??'')} spans={[span(String(item.value),'strong '+(item.tone??'')),span(` ${String(item.label).toLowerCase()}`,'muted')]} />)}</row>:<stats key="stats" items={stats.slice(0,4)} />)}
          {!done&&<col key="activity" gap="xs">
            <spinner style="dots" label={s.activity.slice(0,compact?85:160)} />
            <progress key="progress" value={progress} tone={resultTone} />
            {Date.now()-s.lastActivity>15000&&<text tone="muted">No output for {duration(Date.now()-s.lastActivity)} · still running</text>}
          </col>}
          {!done&&usefulRates&&<col key="throughput" gap="xs">
            <row justify="between"><text spans={[span('Action throughput','strong')]} /><badge tone="info" text={`${rates.at(-1)!.toFixed(1)} / sec`} /></row>
            <chart key="rate" kind={compact?'spark':'area'} size="sm" token="accent" min={0} unit="actions/s" last={false}
              series={rates.map((value,i)=>({value,title:`${value.toFixed(1)} actions/s · ${Math.round((s.actionSamples[i+1].at-s.started)/1000)}s into build`}))} />
          </col>}
          {(mix||outcome||cache)&&<row key="visuals" gap="md" align="start">
            {mix||outcome||cache}
            {!compact&&(mix?(outcome||cache):outcome?cache:null)}
          </row>}
          {compact&&(mix?outcome||cache:outcome&&cache)&&<section key="more-metrics" head="More metrics" collapsible collapsed>{mix?(outcome||cache):cache}</section>}
          {!compact&&mix&&outcome&&cache&&<section key="cache-detail" head="Local cache details" collapsible collapsed>{cache}</section>}
          {done&&(details.actionTypes.length>0||details.timings.length>0)&&<section key="build-details" head="Action types & timing" collapsible collapsed>
            <col gap="md">
              {details.actionTypes.length>0&&<col gap="sm"><text spans={[span('Action types','strong')]} /><chart kind="donut" size="sm" series={details.actionTypes.map(p=>({...p,title:`${p.label}: ${p.value} executed actions`}))} /></col>}
              {details.timings.length>0&&<col gap="sm"><text spans={[span('Phase timings','strong')]} />{details.timings.map(p=><col key={p.label} gap="xs"><row justify="between"><text>{p.label}</text><text>{duration(p.value)}</text></row><meter style="bar" value={p.value/Math.max(...details.timings.map(t=>t.value))} /></col>)}<text tone="muted">Phases can overlap.</text></col>}
            </col>
          </section>}
          {testing&&counts.total>0&&!done&&<col key="test-results" gap="sm">
            {counts.failed>0&&<tabs key="filter" variant="segmented" active={v.tab==='failures'?'failures':'tests'} items={[{id:'tests',label:'All tests'},{id:'failures',label:'Failures'}]} onSelect={e=>{v.tab=String(e.item);update();}} onChange={e=>{v.tab=String(e.value);update();}} />}
            <table key="table" selectable selected={selected?.label} max={{h:compact?'4lines':'6lines'}}
              cols={[{id:'label',head:'Test',grow:1,mono:true,truncate:'middle',priority:3},{id:'status',head:'Result',priority:2},{id:'time',head:'Time',align:'end',mono:true,priority:1}]}
              rows={filtered.slice(0,50).map(t=>({id:t.label,cells:{label:t.label,status:{badge:{text:t.status.replaceAll('_',' '),tone:tone(t.status)}},time:t.duration?duration(t.duration):'—'}}))}
              onSelect={e=>{v.selected=String(e.item);update();}} />
            {selected?.logs[0]&&<button size="sm" variant="quiet" href={selected.logs[0]} actions={{click:'open'}}>Selected test log</button>}
          </col>}
          {done&&testing&&counts.total>0&&<text tone="success">{counts.passed} passed{counts.flaky?` · ${counts.flaky} flaky`:''}{counts.cached?` · ${counts.cached} cached`:''}</text>}

        </col>}
        {s.note&&<text key="note" tone="warning">{s.note}</text>}
        {v.confirm&&!done&&<card key="confirm" head="Cancel this build?" tone="error"><row><button variant="quiet" onClick={()=>{v.confirm=false;update();}}>Keep building</button><button variant="danger" onClick={cancel}>Cancel build</button></row></card>}
      </col>
    </scroll>
    {!failed&&<col key="logs" gap="xs">
            <row justify="between" align="center">
              <text spans={[span('Build log','strong'),...(v.paused?[span(' · paused','muted')]:[])]} />
              {!done&&<row gap="sm"><button size="sm" variant="quiet" onClick={()=>{v.paused=!v.paused;update();}}>{v.paused?'Resume':'Pause'}</button><button size="sm" variant="quiet" onClick={()=>{v.expanded=!v.expanded;update();}}>{v.expanded?'Less':'More'}</button></row>}
            </row>
            <scroll key="log-scroll" stick="end" pinned={!v.paused} max={{h:`${logLines}lines`}}><ansi key="tail" text={logText} follow={!v.paused} /></scroll>
          </col>}
    <row key="handoff" justify="between" align="center" gap="sm">
      <text tone="muted">{done?(cols<75?'Shell ready · type below':'Shell ready · enter your next command below'):'Running · Ctrl+C to interrupt'}</text>
      <row gap="sm">{links.slice(1,compact?2:undefined).map(link=><button key={link.label} size="sm" variant="quiet" href={link.href} actions={{click:'open'}}>{link.label}</button>)}{s.logFile&&<button key="full" size="sm" variant="quiet" icon="file" href={pathToFileURL(s.logFile).href} actions={{click:'open'}}>Full log</button>}</row>
    </row>
  </col></col>;
}

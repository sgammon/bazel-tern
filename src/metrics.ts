export type MetricPoint = {label:string;value:number};

const positive=(value:unknown)=>{
  if(typeof value!=='number' && typeof value!=='string')return 0;
  const n=Number(value);
  return Number.isFinite(n)&&n>0?n:0;
};

/** BEP BuildMetrics only: no server-side cache rates inferred from runner counts.
 * actionData contains the top N executed mnemonics; the total includes remote cache hits.
 * Phase timings are independent elapsed durations in ms and may overlap under Skymeld.
 */
export function reportedDetails(metrics:any):{actionTypes:MetricPoint[];timings:MetricPoint[]} {
  const summary=metrics?.actionSummary;
  const groups=new Map<string,number>();
  for(const action of Array.isArray(summary?.actionData)?summary.actionData:[]) {
    const label=typeof action?.mnemonic==='string'?action.mnemonic.trim():'';
    const value=positive(action?.actionsExecuted);
    if(label&&value)groups.set(label,(groups.get(label)??0)+value);
  }
  const all=[...groups].map(([label,value])=>({label,value})).filter(p=>Number.isFinite(p.value))
    .sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));
  const actionTypes=all.slice(0,5);
  if(all.length) {
    const reported=all.reduce((sum,p)=>sum+p.value,0);
    const remainder=Math.max(0,positive(summary.actionsExecuted)-reported);
    const other=all.slice(5).reduce((sum,p)=>sum+p.value,0)+remainder;
    if(Number.isFinite(other)&&other>0)actionTypes.push({label:'Other',value:other});
  }
  const timing=metrics?.timingMetrics;
  const timings=[
    {label:'Analysis',value:positive(timing?.analysisPhaseTimeInMs)},
    {label:'Execution',value:positive(timing?.executionPhaseTimeInMs)},
  ].filter(p=>p.value>0);
  return {actionTypes,timings};
}

/** Whole-build durations in ms, beside the phases: what the machines spent and the longest dependent chain. */
export function reportedTotals(metrics:any):MetricPoint[] {
  const timing=metrics?.timingMetrics;
  // Durations arrive as proto JSON (`"4.870s"`) or as `{seconds, nanos}`.
  const seconds=(value:unknown)=>typeof value==='string'&&/^\d+(\.\d+)?s$/.test(value)?Number(value.slice(0,-1))*1000
    :value&&typeof value==='object'?positive((value as any).seconds)*1000+positive((value as any).nanos)/1e6:0;
  return [
    {label:'Critical path',value:seconds(timing?.criticalPathTime)},
    {label:'CPU time',value:positive(timing?.cpuTimeInMs)},
  ].filter(p=>Number.isFinite(p.value)&&p.value>0);
}

import { StringDecoder } from 'node:string_decoder';
import { clean } from './core.js';

export type QueryRow = {label:string; kind:string; config:string};
/** Rows kept for the table. Counts cover every result; the results file has them all. */
export const QUERY_ROWS=1000;

const packageOf = (label:string) => label.replace(/:[^:]*$/,'');
const isFile = (kind:string) => kind==='source file'||kind==='generated file';

/** One `query`/`cquery` result line in a one-target-per-line format, or undefined for anything else. */
export function parseQueryLine(line:string, output:string):QueryRow|undefined {
  const text=line.trim();
  if(!text)return undefined;
  if(output==='package')return /\s/.test(text)?undefined:{label:text.startsWith('//')||text.startsWith('@')?text:`//${text}`,kind:'package',config:''};
  // `label`: `//a:b`, and from cquery `//a:b (config)`. `label_kind` puts the kind first.
  const match=text.match(/^(?:(.+?) )?((?:\/\/|@)\S*)(?: \(([^()\s]+)\))?$/);
  if(!match)return undefined;
  const kind=(match[1]??'').replace(/ rule$/,'');
  if(output==='label'&&kind)return undefined;
  return {label:match[2],kind,config:match[3]??''};
}

/** What a running query has printed: results from stdout, progress and errors from stderr. */
export class QueryState {
  started=Date.now(); ended?:number; exitCode:number|null=null;
  rows:QueryRow[]=[]; total=0; unparsed=0;
  packages=new Set<string>(); kinds=new Map<string,number>(); rules=0; files=0; configs=new Set<string>();
  activity='Starting Bazel'; messages:string[]=[]; resultsFile=''; note='';
  /** Every result line as it arrives, parsed when it is a target. */
  onResult?:(row:QueryRow|undefined,line:string)=>void;
  private decoder=new StringDecoder('utf8'); private pending=''; private errPending='';
  constructor(public command:string, public args:string[], public output:string) {}
  /** The expression as typed: what follows the command, without options and their values. */
  get expression() {
    const end=this.args.indexOf('--');
    const before=this.args.slice(0,end<0?undefined:end), words:string[]=[];
    const valued=new Set(['--output','--query_file','--universe_scope','--config','--aspects','--starlark:expr','--starlark:file']);
    for(let i=before.indexOf(this.command)+1;i<before.length;i++) {
      if(valued.has(before[i])) {i++;continue;}
      if(!before[i].startsWith('-'))words.push(before[i]);
    }
    return [...words,...(end<0?[]:this.args.slice(end+1))].join(' ');
  }
  get done() { return this.ended!==undefined; }
  get failed() { return this.done&&this.exitCode!==0; }
  get topKinds() {
    const all=[...this.kinds].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));
    // "Other" has to stand for several kinds to be worth a segment.
    if(all.length<=6)return all;
    return [...all.slice(0,5),{label:'Other',value:all.slice(5).reduce((sum,p)=>sum+p.value,0)}];
  }
  stdout(bytes:Buffer) { this.consume(this.decoder.write(bytes)); }
  private consume(text:string) {
    const lines=(this.pending+text).split('\n');
    this.pending=lines.pop()!;
    for(const line of lines)this.result(line);
  }
  private result(line:string) {
    if(!line.trim())return;
    const row=parseQueryLine(line,this.output);
    this.onResult?.(row,line);
    if(!row) {this.unparsed++;return;}
    this.total++;
    if(this.rows.length<QUERY_ROWS)this.rows.push(row);
    if(row.kind!=='package')this.packages.add(packageOf(row.label));
    if(row.kind) {
      this.kinds.set(row.kind,(this.kinds.get(row.kind)??0)+1);
      if(isFile(row.kind))this.files++;else if(row.kind!=='package')this.rules++;
    }
    if(row.config)this.configs.add(row.config);
  }
  /** Bazel reports loading progress and query errors on stderr. */
  stderr(text:string) {
    const lines=(this.errPending+text).split(/\r\n|\n|\r/);
    this.errPending=lines.pop()!.slice(-8192);
    for(const line of lines) {
      const value=clean(line).trim();
      if(!value)continue;
      this.messages.push(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,seq=>seq.endsWith('m')?seq:'').slice(0,2048)+'\x1b[0m');
      if(this.messages.length>40)this.messages.shift();
      if(/^(?:INFO: )?(?:Loading|Analyzing|Computing|Fetching|Starting|Extracting)/.test(value))this.activity=value.replace(/^INFO: /,'');
    }
  }
  /** The lines that say what went wrong, without the progress around them. */
  get errors() {
    const kept=this.messages.filter(line=>!/^(?:INFO|DEBUG|Loading|Analyzing|Computing|Fetching|Starting|Extracting)\b/.test(clean(line).trim()));
    return (kept.length?kept:this.messages).slice(-12).join('\r\n');
  }
  finish(code:number) {
    this.consume(this.decoder.end()+'\n');this.stderr('\n');
    this.exitCode=code;this.ended=Date.now();
  }
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseQueryLine, QueryState, QUERY_ROWS} from '../src/query.js';

test('label_kind lines split into kind, label and cquery configuration',()=>{
  assert.deepEqual(parseQueryLine('cc_library rule //lib/codec:codec','label_kind'),{label:'//lib/codec:codec',kind:'cc_library',config:''});
  assert.deepEqual(parseQueryLine('source file //lib/codec:codec.cc','label_kind'),{label:'//lib/codec:codec.cc',kind:'source file',config:''});
  assert.deepEqual(parseQueryLine('generated file @@rules_go+//proto:api.pb.go','label_kind'),{label:'@@rules_go+//proto:api.pb.go',kind:'generated file',config:''});
  assert.deepEqual(parseQueryLine('package group //visibility:internal','label_kind'),{label:'//visibility:internal',kind:'package group',config:''});
  assert.deepEqual(parseQueryLine('go_binary rule //app:server (6f2b4e9)','label_kind'),{label:'//app:server',kind:'go_binary',config:'6f2b4e9'});
  assert.deepEqual(parseQueryLine('source file //app:main.go (null)','label_kind'),{label:'//app:main.go',kind:'source file',config:'null'});
});
test('label and package lines are targets; anything else is not mistaken for one',()=>{
  assert.deepEqual(parseQueryLine('//app:server','label'),{label:'//app:server',kind:'',config:''});
  assert.deepEqual(parseQueryLine('@maven//:guava (3c1a9f0)\r','label'),{label:'@maven//:guava',kind:'',config:'3c1a9f0'});
  assert.deepEqual(parseQueryLine('services/api','package'),{label:'//services/api',kind:'package',config:''});
  assert.deepEqual(parseQueryLine('@rules_go//go','package'),{label:'@rules_go//go',kind:'package',config:''});
  for(const line of ['','   ','Loading: 3 packages loaded','WARNING: something //app:server','{"label":"//app:server"}'])
    assert.equal(parseQueryLine(line,'label'),undefined,line);
  assert.equal(parseQueryLine('two words','package'),undefined);
});
test('results arrive across chunk and UTF-8 boundaries and are counted once',()=>{
  const q=new QueryState('query',['query','//...'],'label_kind');
  const bytes=Buffer.from('go_library rule //app:lib\nsource file //app:héllo.go\ngenerated file //app:api.pb.go');
  const split=bytes.indexOf(0xc3)+1;
  q.stdout(bytes.subarray(0,7));q.stdout(bytes.subarray(7,split));q.stdout(bytes.subarray(split));
  assert.equal(q.total,2);
  q.finish(0);
  assert.equal(q.total,3);assert.equal(q.rows[1].label,'//app:héllo.go');
  assert.equal(q.rules,1);assert.equal(q.files,2);assert.equal(q.packages.size,1);
  assert.deepEqual([...q.kinds],[['go_library',1],['source file',1],['generated file',1]]);
});
test('every line reaches the text results; the table keeps a bounded number of rows',()=>{
  const q=new QueryState('query',['query','//...'],'label_kind');
  const seen:string[]=[];q.onResult=(row,line)=>seen.push(row?row.label:`? ${line}`);
  q.stdout(Buffer.from(Array.from({length:QUERY_ROWS+25},(_,i)=>`cc_library rule //p${i%7}:t${i}\n`).join('')+'not a target line\n'));
  q.finish(0);
  assert.equal(q.total,QUERY_ROWS+25);assert.equal(q.rows.length,QUERY_ROWS);assert.equal(q.unparsed,1);
  assert.equal(seen.length,QUERY_ROWS+26);assert.equal(seen.at(-1),'? not a target line');
  assert.equal(q.packages.size,7);
});
test('the kind breakdown names what it can and folds only a real remainder into Other',()=>{
  const q=new QueryState('query',['query','//...'],'label_kind');
  const feed=(kinds:number)=>{for(let k=0;k<kinds;k++)for(let i=0;i<=k;i++)q.stdout(Buffer.from(`kind${k} rule //p:t${k}_${i}\n`));};
  feed(6);
  assert.deepEqual(q.topKinds.map(p=>p.label),['kind5','kind4','kind3','kind2','kind1','kind0']);
  const many=new QueryState('query',['query','//...'],'label_kind');
  for(let k=0;k<9;k++)for(let i=0;i<=k;i++)many.stdout(Buffer.from(`kind${k} rule //p:t${k}_${i}\n`));
  assert.deepEqual(many.topKinds.map(p=>[p.label,p.value]),[['kind8',9],['kind7',8],['kind6',7],['kind5',6],['kind4',5],['Other',10]]);
});
test('the expression is what was typed, without options, their values or startup flags',()=>{
  const expr=(args:string[],command='query')=>new QueryState(command,args,'label').expression;
  assert.equal(expr(['query','deps(//app:server)','--keep_going']),'deps(//app:server)');
  assert.equal(expr(['--output_base','/tmp/query','query','--output','label_kind','kind(rule, //...)']),'kind(rule, //...)');
  assert.equal(expr(['query','--universe_scope','//...','--','allpaths(//a, //b)']),'allpaths(//a, //b)');
  assert.equal(expr(['cquery','//app:server','--config=dev'],'cquery'),'//app:server');
});
test('progress names the current step; errors keep the tool\'s message, its color, and none of the progress',()=>{
  const q=new QueryState('query',['query','deps(//nope)'],'label_kind');
  q.stderr('Loading: 0 packages loaded\nLoading: 4 pack');q.stderr('ages loaded\n');
  assert.equal(q.activity,'Loading: 4 packages loaded');
  q.stderr('\x1b[31m\x1b[1mERROR: \x1b[0mno such package \'nope\'\nINFO: Elapsed time: 0.2s\n');
  q.finish(7);
  assert.equal(q.failed,true);
  assert.match(q.errors,/\x1b\[31m\x1b\[1mERROR: \x1b\[0mno such package/);
  assert.doesNotMatch(q.errors,/packages loaded|Elapsed/);
  const silent=new QueryState('query',['query','//...'],'label');silent.stderr('Loading: 1 packages loaded\n');silent.finish(1);
  assert.match(silent.errors,/1 packages loaded/);
});

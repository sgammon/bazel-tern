import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('wrapper preserves child output, exit status, BuildBuddy flags and application arguments', async () => {
  const dir=await mkdtemp(join(tmpdir(),'tern-bazel-test-'));
  try {
    const fake=join(dir,'bazel');
    await writeFile(fake, `#!/usr/bin/env node\nconst fs=require('fs'); fs.writeFileSync(process.env.ARGS,JSON.stringify(process.argv.slice(2))); console.log('compiler output'); console.error('https://bb.example/invocation/123'); process.exit(7);`,{mode:0o755});
    const run=spawnSync(process.execPath,['--import','tsx','src/cli.ts','--plain','--bazel',fake,'--','--output_base=/tmp/test','test','//...','--bes_backend=grpcs://bb.example','--','--my-test-arg'],{encoding:'utf8',env:{...process.env,ARGS:join(dir,'args')},timeout:10000});
    assert.equal(run.status,7,run.stderr);
    assert.match(run.stdout,/compiler output/); assert.match(run.stderr,/https:\/\/bb.example\/invocation\/123/);
    const args=JSON.parse(await readFile(join(dir,'args'),'utf8'));
    assert.equal(args[0],'--output_base=/tmp/test'); assert.equal(args[1],'test');
    assert.ok(args[2].startsWith('--build_event_json_file='));
    assert.deepEqual(args.slice(3),['//...','--bes_backend=grpcs://bb.example','--','--my-test-arg']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Ctrl+C reaches the Bazel process group and preserves an interrupted exit', async () => {
  const {spawn}=await import('node:child_process');
  const dir=await mkdtemp(join(tmpdir(),'tern-bazel-signal-'));
  try {
    const fake=join(dir,'bazel');
    await writeFile(fake,`#!/usr/bin/env node\nprocess.on('SIGINT',()=>{console.log('interrupted and flushed');process.exit(130);}); console.log('ready'); setInterval(()=>{},1000);`,{mode:0o755});
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts','--plain','--bazel',fake,'--','test','//...'],{env:process.env});
    let text=''; let sent=false;
    child.stdout.on('data',b=>{text+=b;if(!sent&&text.includes('ready')){sent=true;child.kill('SIGINT');}});
    const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
    const status=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);
    assert.equal(status,130);assert.match(text,/interrupted and flushed/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('growing BEP file is consumed during native-less execution and a user event file is preserved', async () => {
  const dir=await mkdtemp(join(tmpdir(),'tern-bazel-events-'));
  try {
    const fake=join(dir,'bazel'); const bep=join(dir,'my-events.json');
    await writeFile(bep,'{"oldBuild":true}\n');
    await writeFile(fake,`#!/usr/bin/env node\nconst fs=require('fs'); const a=process.argv.find(a=>a.startsWith('--build_event_json_file=')); const path=a.split('=').slice(1).join('='); fs.writeFileSync(path,JSON.stringify({started:{uuid:'new-build'}})+'\\n'); setTimeout(()=>{fs.appendFileSync(path,JSON.stringify({finished:{exitCode:{code:0}}})+'\\n');console.log('finished')},150);`,{mode:0o755});
    const run=spawnSync(process.execPath,['--import','tsx','src/cli.ts','--plain','--bazel',fake,'--','build','//...','--build_event_json_file='+bep],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stderr);assert.match(await readFile(bep,'utf8'),/new-build/);
    assert.doesNotMatch(run.stderr,/No local build events/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

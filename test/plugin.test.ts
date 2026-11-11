import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('plugin startup preserves user settings and executable aliases, forwarding exact arguments and status',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tern-plugin-'));
  try {
    writeFileSync(join(dir,'.zshrc'),`export USER_RC_LOADED=yes\nalias bazel=aspect\n`);
    writeFileSync(join(dir,'aspect'),`#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),rc:process.env.USER_RC_LOADED}));process.exit(7);`,{mode:0o755});
    const root=resolve('release/bazel');
    const run=spawnSync('/bin/zsh',['-dic','source "$TERN_BAZEL_ROOT/zsh/.zshrc"; bazel test "//has space:target" --bes_backend=grpcs://example'],{encoding:'utf8',env:{...process.env,PATH:dir+':'+process.env.PATH,TERN_BAZEL_ROOT:root,TERN_BAZEL_ORIGINAL_ZDOTDIR:dir,ZDOTDIR:root+'/zsh'}});
    assert.equal(run.status,7,run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()),{args:['test','//has space:target','--bes_backend=grpcs://example'],rc:'yes'});
    assert.equal(spawnSync('/bin/zsh',['-dfc','whence -w bazel'],{encoding:'utf8',env:{...process.env,PATH:dir+':'+process.env.PATH}}).stdout.includes('function'),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

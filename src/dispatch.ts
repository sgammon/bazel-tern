import { spawn } from 'node:child_process';
const [name,...args]=process.argv.slice(2);
if(!name)throw new Error('Missing Bazel executable');
// Shell functions are not executable files: the subprocess naturally finds the real tool.
if(!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERN_TSP==='0') {
  const child=spawn(name,args,{stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.on(signal,()=>child.kill(signal));
  child.on('error',e=>{console.error(e.message);process.exitCode=127;});
  child.on('close',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});
} else {
  process.argv=[process.argv[0],process.argv[1],'--bazel',name,'--',...args];
  await import('./cli.js');
}

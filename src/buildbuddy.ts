export type InvocationLink = {label:string;href:string};
export type InvocationContext = {failed?:boolean;buildbuddy?:boolean;remoteExecution?:boolean};

function invocationUrl(value:string) {
  try {
    const url=new URL(value);
    if(!['https:','http:'].includes(url.protocol) || url.username || url.password || !/\/invocation\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname))return undefined;
    return url;
  } catch {return undefined;}
}

/** A generic BES results URL is not evidence that its server implements BuildBuddy tabs. */
export function isBuildBuddyUrl(value:string):boolean {
  const url=invocationUrl(value);
  return !!url && (url.hostname==='buildbuddy.io' || url.hostname.endsWith('.buildbuddy.io'));
}

/** Native links need no running helper or BuildBuddy credentials after the build exits.
 * Tab hashes follow BuildBuddy's app/invocation/invocation_tabs.tsx.
 * A self-hosted deployment can be identified by the caller with `buildbuddy: true`.
 */
export function invocationLinks(value:string,context:InvocationContext={}):InvocationLink[] {
  const url=invocationUrl(value);
  if(!url)return [];
  const known=context.buildbuddy || isBuildBuddyUrl(value);
  const links:InvocationLink[]=[{label:known?'BuildBuddy':'Build results',href:value}];
  if(!known)return links;
  // A selected target otherwise takes precedence over the requested invocation tab.
  url.searchParams.delete('target');url.searchParams.delete('targetStatus');
  const tabs=context.failed ? [['Logs','log'],['Targets','targets']]
    : [['Cache','cache'],...(context.remoteExecution?[['Executions','execution']]:[]),['Timing','timing']];
  for(const [label,hash] of tabs) {url.hash=hash;links.push({label,href:url.href});}
  return links;
}

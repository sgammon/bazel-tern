import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invocationLinks, isBuildBuddyUrl} from '../src/buildbuddy.js';

test('BuildBuddy failures link directly to logs and targets instead of cache metrics',()=>{
  const url='https://app.buildbuddy.io/invocation/abc-123';
  assert.deepEqual(invocationLinks(url,{failed:true}),[
    {label:'BuildBuddy',href:url},
    {label:'Logs',href:url+'#log'},
    {label:'Targets',href:url+'#targets'},
  ]);
});

test('successful BuildBuddy links expose execution details only when remote execution is reported',()=>{
  const url='https://app.buildbuddy.io/invocation/abc-123';
  assert.deepEqual(invocationLinks(url).map(link=>link.href),[url,url+'#cache',url+'#timing']);
  assert.deepEqual(invocationLinks(url,{remoteExecution:true}).map(link=>link.href),[url,url+'#cache',url+'#execution',url+'#timing']);
});

test('explicitly identified self-hosted BuildBuddy keeps its origin, mount path, and unrelated query',()=>{
  const url='https://ci.example.net/builds/invocation/abc?group=team&target=%2F%2Ffoo&targetStatus=1#raw';
  const links=invocationLinks(url,{buildbuddy:true,failed:true});
  assert.equal(links[0].href,url);
  assert.equal(links[0].label,'BuildBuddy');
  assert.equal(links[1].href,'https://ci.example.net/builds/invocation/abc?group=team#log');
});

test('unknown BES servers retain their link without unsupported BuildBuddy tabs',()=>{
  const url='https://ci.example.net/invocation/abc';
  assert.deepEqual(invocationLinks(url),[{label:'Build results',href:url}]);
  assert.equal(isBuildBuddyUrl(url),false);
  assert.equal(isBuildBuddyUrl('https://tenant.buildbuddy.io/invocation/abc'),true);
  assert.equal(isBuildBuddyUrl('https://buildbuddy.io.evil.example/invocation/abc'),false);
});

test('invalid, credential-bearing, non-web, and non-invocation URLs do not become open actions',()=>{
  for(const url of ['', 'not a url','javascript:alert(1)','file:///invocation/abc','https://user:secret@app.buildbuddy.io/invocation/abc','https://app.buildbuddy.io/']) {
    assert.deepEqual(invocationLinks(url,{buildbuddy:true}),[]);
    assert.equal(isBuildBuddyUrl(url),false);
  }
});

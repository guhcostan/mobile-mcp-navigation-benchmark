import test from 'node:test';
import assert from 'node:assert/strict';
import { isApprovedSimulator } from './clef_mobile_core.mjs';
import { summarizePairs } from './benchmark_stats.mjs';

test('paired summary excludes failed or incomplete runs',()=>{
  const report=summarizePairs([
    {pair:1,runs:[{system:'LUNA',seconds:30,success:true},{system:'CLEF',seconds:20,success:true}]},
    {pair:2,runs:[{system:'LUNA',seconds:1,success:false},{system:'CLEF',seconds:25,success:true}]},
    {pair:3,runs:[{system:'LUNA',seconds:31,success:true},{system:'CLEF',seconds:29,success:true}]},
  ]);
  assert.equal(report.successfulPairs,2);
  assert.equal(report.medianLunaMinusClefSeconds,6);
  assert.deepEqual(report.pairedDeltas.map((pair)=>pair.luna_minus_clef_seconds),[10,null,2]);
});

test('IPv6 URL parser returns a bracketed loopback hostname',()=>{
  const url=new URL('http://[::1]:10100/v1');
  assert.equal(url.hostname,'[::1]');
  assert.equal(['localhost','127.0.0.1','::1'].includes(url.hostname.replace(/^\[|\]$/g,'')),true);
});

test('only explicitly identified iOS simulators pass device validation',()=>{
  assert.equal(isApprovedSimulator({platform:'ios',type:'simulator'}),true);
  assert.equal(isApprovedSimulator({platform:'ios',type:'device'}),false);
  assert.equal(isApprovedSimulator({platform:'ios'}),false);
});

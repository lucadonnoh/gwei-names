import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayPool,configuredGateways} from './content-gateways.js';
const endpoints=['https://primary.example','https://fallback.example'];

test('a slow primary is hedged, the winner streams, and the losing request is cancelled',async()=>{
 const calls=[];let slowSignal;const pool=createGatewayPool({hedgeMs:15,timeoutMs:500,fetchImpl:(url,{signal})=>{calls.push(url);if(url.startsWith(endpoints[0])){slowSignal=signal;return new Promise(()=>{});}return Promise.resolve(new Response('fallback html',{headers:{'content-type':'text/html'}}));}});
 const start=Date.now(),result=await pool(endpoints,'/ipfs/arbitrary/path?x=1');
 assert.equal(await result.text(),'fallback html');assert.ok(Date.now()-start<300);assert.equal(slowSignal.aborted,true);
 assert.deepEqual(calls,endpoints.map(url=>url+'/ipfs/arbitrary/path?x=1'));
});
test('fast primary avoids unnecessary fallback requests',async()=>{
 const calls=[];const pool=createGatewayPool({hedgeMs:15,fetchImpl:async url=>{calls.push(url);return new Response('ok');}});
 assert.equal(await (await pool(endpoints,'/ipfs/one')).text(),'ok');await new Promise(r=>setTimeout(r,25));assert.equal(calls.length,1);
});
test('service failures fail over immediately and enter cooldown',async()=>{
 const calls=[];const pool=createGatewayPool({hedgeMs:500,cooldownMs:1000,fetchImpl:async url=>{calls.push(url);return new Response('x',{status:url.startsWith(endpoints[0])?503:200});}});
 const start=Date.now();assert.ok(await pool(endpoints,'/ipfs/one'));assert.ok(Date.now()-start<200);
 calls.length=0;assert.ok(await pool(endpoints,'/ipfs/two'));assert.deepEqual(calls,[endpoints[1]+'/ipfs/two']);
});
test('missing content does not mark an otherwise healthy gateway offline',async()=>{
 let missing=true;const calls=[];const pool=createGatewayPool({fetchImpl:async url=>{calls.push(url);return new Response('x',{status:missing?404:200});}});
 assert.equal(await pool(endpoints,'/ipfs/missing'),null);missing=false;calls.length=0;
 assert.ok(await pool(endpoints,'/ipfs/available'));assert.equal(calls[0],endpoints[0]+'/ipfs/available');
});
test('all hung gateways finish within a bounded deadline even if fetch ignores abort',async()=>{
 const pool=createGatewayPool({hedgeMs:5,timeoutMs:35,fetchImpl:()=>new Promise(()=>{})});const start=Date.now();
 assert.equal(await pool(endpoints,'/ipfs/missing'),null);assert.ok(Date.now()-start<300);
});
test('recovery is attempted when every endpoint is cooling down',async()=>{
 let up=false;const pool=createGatewayPool({fetchImpl:async()=>new Response('x',{status:up?200:502})});
 assert.equal(await pool(endpoints,'/ipfs/one'),null);up=true;assert.ok(await pool(endpoints,'/ipfs/one'));
});
test('gateway configuration is shared and accepts only bounded HTTPS origins',()=>{
 assert.deepEqual(configuredGateways(undefined,endpoints),endpoints);
 assert.deepEqual(configuredGateways(JSON.stringify(endpoints),[]),endpoints);
 for(const value of ['[]','["http://localhost"]','["https://u:p@example.com"]','["https://example.com/path"]','["https://example.com/?token=x"]'])assert.throws(()=>configuredGateways(value,[]));
});

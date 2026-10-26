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
test('missing content is a 404 and does not mark an otherwise healthy gateway offline',async()=>{
 let missing=true;const calls=[];const pool=createGatewayPool({fetchImpl:async url=>{calls.push(url);return new Response('x',{status:missing?404:200});}});
 assert.equal((await pool(endpoints,'/ipfs/missing')).status,404);missing=false;calls.length=0;
 assert.ok(await pool(endpoints,'/ipfs/available'));assert.equal(calls[0],endpoints[0]+'/ipfs/available');
});
test('a 404 loses to a gateway that has the content, and to outages only when one gateway said 404',async()=>{
 const pool=createGatewayPool({hedgeMs:5,fetchImpl:async url=>new Response('found',{status:url.startsWith(endpoints[0])?404:200})});
 assert.equal(await (await pool(endpoints,'/ipfs/one')).text(),'found');
 const down=createGatewayPool({hedgeMs:5,fetchImpl:async url=>new Response('x',{status:url.startsWith(endpoints[0])?404:503})});
 assert.equal((await down(endpoints,'/ipfs/two')).status,404);
 const outage=createGatewayPool({hedgeMs:5,fetchImpl:async()=>new Response('x',{status:429})});
 assert.equal(await outage(endpoints,'/ipfs/three'),null);
});
test('one site’s missing or slow content does not bench the gateway for the others',async()=>{
 // A CID nobody provides (504) or one taking too long, on 2026-10-26, made every other site fail for 30 s.
 const calls=[];const pool=createGatewayPool({hedgeMs:500,timeoutMs:40,cooldownMs:60000,fetchImpl:(url,{signal})=>{calls.push(url);
  if(url.endsWith('/dead'))return Promise.resolve(new Response('x',{status:504}));
  if(url.endsWith('/slow'))return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
  return Promise.resolve(new Response('ok'));}});
 assert.equal(await pool(endpoints,'/ipfs/dead'),null);assert.equal(await pool(endpoints,'/ipfs/slow'),null);
 calls.length=0;assert.equal(await (await pool(endpoints,'/ipfs/live')).text(),'ok');assert.deepEqual(calls,[endpoints[0]+'/ipfs/live']);
 // A gateway that can't be reached at all still is.
 const tried=[];const unreachable=createGatewayPool({hedgeMs:500,cooldownMs:60000,fetchImpl:async url=>{tried.push(url);if(url.startsWith(endpoints[0]))throw new TypeError('connection refused');return new Response('ok');}});
 await unreachable(endpoints,'/ipfs/one');tried.length=0;
 assert.equal(await (await unreachable(endpoints,'/ipfs/two')).text(),'ok');assert.deepEqual(tried,[endpoints[1]+'/ipfs/two']);
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

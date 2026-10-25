// Deploys one commit of the dapp (Railway service gwei-dapp, production) and waits until Railway
// reports it live. CI runs this after the tests pass on main; it also works by hand.
//
//   RAILWAY_TOKEN=<project token> node scripts/railway-deploy.mjs <commit-sha>
//
// RAILWAY_TOKEN is a project token for the gwei-names project's production environment. A personal
// API token works too, as RAILWAY_API_TOKEN.

const SERVICE = '04084c71-f9b0-462f-8e97-9f3243c08026'; // gwei-dapp
const ENVIRONMENT = 'f1dcfbb5-c394-41b1-bfe5-c672ba61e2f6'; // production
const TIMEOUT_MS = 15 * 60 * 1000;
const DONE = new Set(['SUCCESS']);
const FAILED = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha || '')) {
  console.error('usage: node scripts/railway-deploy.mjs <full commit sha>');
  process.exit(2);
}
const headers = { 'content-type': 'application/json', 'user-agent': 'gwei-names-deploy' };
if (process.env.RAILWAY_TOKEN) headers['project-access-token'] = process.env.RAILWAY_TOKEN;
else if (process.env.RAILWAY_API_TOKEN) headers.authorization = `Bearer ${process.env.RAILWAY_API_TOKEN}`;
else {
  console.error('set RAILWAY_TOKEN (project token) or RAILWAY_API_TOKEN');
  process.exit(2);
}

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`Railway API: ${res.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}

const { serviceInstanceDeployV2: id } = await gql(
  'mutation($s:String!,$e:String!,$c:String){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}',
  { s: SERVICE, e: ENVIRONMENT, c: sha },
);
console.log(`deployment ${id} for ${sha.slice(0, 7)}`);
const deadline = Date.now() + TIMEOUT_MS;
let last = '';
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const { deployment } = await gql('query($id:String!){deployment(id:$id){status}}', { id }).catch((error) => {
    console.log(`status check failed, retrying: ${error.message}`);
    return { deployment: null };
  });
  const status = deployment?.status;
  if (status && status !== last) console.log(`status: ${(last = status)}`);
  if (DONE.has(status)) process.exit(0);
  if (FAILED.has(status)) {
    console.error(`Railway deployment ${id} ended ${status}`);
    process.exit(1);
  }
}
console.error(`Railway deployment ${id} not live after ${TIMEOUT_MS / 60000} minutes (last status ${last || 'unknown'})`);
process.exit(1);

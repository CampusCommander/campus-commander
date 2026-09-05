// Throwaway Kestra experiment. All requests stay on localhost.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const base='http://127.0.0.1:58089';
const credentialPath='/tmp/campus-v0-lab/kestra-auth.json';
let credentials;
try { credentials=JSON.parse(await readFile(credentialPath)); }
catch { credentials={username:'v0@example.test',password:'V0a'+randomBytes(24).toString('hex')};await writeFile(credentialPath,JSON.stringify(credentials),{mode:0o600}); }
const config=await (await fetch(base+'/api/v1/configs')).json();
if(!config.isBasicAuthInitialized){
 const response=await fetch(base+'/api/v1/main/basicAuth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
 if(!response.ok)throw new Error(`Local auth setup: ${response.status} ${await response.text()}`);
}
const headers={Authorization:'Basic '+Buffer.from(credentials.username+':'+credentials.password).toString('base64')};
const method=process.env.V0_WORKER_METHOD || 'POST';
assert.ok(['GET','POST'].includes(method));
const responses=new Map();
const events=[];let active=0,maxActive=0;
const server=createServer(async(req,res)=>{
 const part=req.url.split('/');
 if(part[1]==='assignment'){
  const id=Number(part[2]);
  const key=req.headers['idempotency-key'];
  assert.ok(key);
  if(responses.has(key)){
   events.push({event:'duplicate_request',id,time:Date.now()});
  }else{
   responses.set(key,(async()=>{
    active++;maxActive=Math.max(maxActive,active);
    events.push({event:'started',id,time:Date.now()});
    await new Promise(r=>setTimeout(r,100+(id%3)*100));
    const outcome=id===2?'transport_failed':id===4?'completed_with_errors':'succeeded';
    events.push({event:'settled',id,outcome,operations:500,time:Date.now()});active--;
    return {status:id===2?503:200,body:{assignment:id,outcome,operations:500,succeeded:id===4?497:id===2?0:500,failed:id===4?3:id===2?500:0}};
   })());
  }
  const result=await responses.get(key);
  res.writeHead(result.status,{'Content-Type':'application/json'});
  res.end(JSON.stringify(result.body));
 }else if(req.url==='/aggregate'){
  const settled=events.filter(x=>x.event==='settled');
  events.push({event:'aggregate',settled:settled.length,time:Date.now()});
  res.writeHead(settled.length===10?200:409,{'Content-Type':'application/json'});res.end(JSON.stringify({settled:settled.length}));
 }else{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(58189,'127.0.0.1',r));
const source=`id: v0_all_settled
namespace: campus.validation
tasks:
  - id: assignments
    type: io.kestra.plugin.core.flow.ForEach
    values: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
    concurrencyLimit: 3
    tasks:
      - id: worker
        type: io.kestra.plugin.core.http.Request
        uri: "http://127.0.0.1:58189/assignment/{{ taskrun.value }}"
        method: ${method}
        headers:
          Idempotency-Key: "{{ execution.id }}:{{ taskrun.value }}"
        allowFailure: true
  - id: aggregate
    type: io.kestra.plugin.core.http.Request
    uri: "http://127.0.0.1:58189/aggregate"
    method: GET
`;
await writeFile(new URL('kestra-all-settled.yaml',import.meta.url),source);
try{
 const existing=await fetch(base+'/api/v1/main/flows/campus.validation/v0_all_settled',{headers});
 const response=await fetch(base+(existing.ok?'/api/v1/main/flows/campus.validation/v0_all_settled':'/api/v1/main/flows'),{method:existing.ok?'PUT':'POST',headers:{...headers,'Content-Type':'application/x-yaml'},body:source});
 if(!response.ok)throw new Error(`Flow upload: ${response.status} ${await response.text()}`);
 const start=await fetch(base+'/api/v1/main/executions/campus.validation/v0_all_settled',{method:'POST',headers,body:new FormData()});
 if(!start.ok)throw new Error(`Flow start: ${start.status} ${await start.text()}`);
 const initial=await start.json();let execution=initial;
 const terminal=new Set(['SUCCESS','WARNING','FAILED','KILLED','CANCELLED']);
 const deadline=Date.now()+60000;
 while(!terminal.has(execution.state.current)&&Date.now()<deadline){
  await new Promise(r=>setTimeout(r,250));
  execution=await(await fetch(base+'/api/v1/main/executions/'+initial.id,{headers})).json();
 }
 const result={method,date:new Date().toISOString(),kestraVersion:config.version,executionId:initial.id,flowState:execution.state.current,maxConcurrentAssignments:maxActive,events,
 taskRuns:(execution.taskRunList||[]).map(t=>({taskId:t.taskId,value:t.value,state:t.state.current})),
 limits:['Synthetic external worker service, no Google requests','In-memory deduplication proves protocol only. Production needs a durable ledger across worker restarts','Tests transport failure and domain failure collection, not Kestra crash recovery','One localhost worker endpoint and ten assignments, not district capacity','allowFailure permits aggregation; application result ledger still determines business outcome']};
 await writeFile(new URL(`../evidence/kestra-probe-${method.toLowerCase()}.json`,import.meta.url),JSON.stringify(result,null,2)+'\n');
 assert.equal(events.filter(x=>x.event==='settled').length,10);
 assert.equal(events.find(x=>x.event==='aggregate')?.settled,10);
 assert.ok(maxActive>1&&maxActive<=3);
 assert.equal(result.flowState,'WARNING');
 assert.equal(result.taskRuns.find(x=>x.taskId==='aggregate')?.state,'SUCCESS');
 console.log(JSON.stringify({state:result.flowState,settled:10,maxActive,aggregation:'PASS'}));
}finally{await new Promise(r=>server.close(r));}

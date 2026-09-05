// Throwaway query experiment. Synthetic data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
const require = createRequire(`${process.env.V0_NODE_MODULES || '/tmp/campus-v0-lab/node/node_modules'}/loader.cjs`);
const { Pool } = require('pg');
const db = new Pool({ host:'127.0.0.1',port:55439,user:process.env.USER,database:'v0_validation',max:12 });
const started=performance.now();
await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;
 CREATE SCHEMA IF NOT EXISTS v0;
 CREATE TABLE IF NOT EXISTS v0.entities(id integer PRIMARY KEY, school integer, kind text, email text, name text, serial text, status text);
 TRUNCATE v0.entities;
 INSERT INTO v0.entities SELECT i,i%100,CASE WHEN i%2=0 THEN 'user' ELSE 'device' END,
 'entity'||lpad(i::text,7,'0')||'@school'||(i%7)||'.example.test',
 CASE WHEN i%5=0 THEN 'Garcia ' ELSE 'Smith ' END||lpad(i::text,7,'0'),
 'SER'||lpad(i::text,9,'0'),CASE WHEN i%7=0 THEN 'suspended' ELSE 'active' END
 FROM generate_series(1,1000000) i;
 CREATE INDEX IF NOT EXISTS v0_email ON v0.entities(email);
 CREATE INDEX IF NOT EXISTS v0_serial ON v0.entities(serial);
 CREATE INDEX IF NOT EXISTS v0_school_status ON v0.entities(school,status,id);
 CREATE INDEX IF NOT EXISTS v0_name_prefix ON v0.entities(lower(name) text_pattern_ops);
 CREATE INDEX IF NOT EXISTS v0_name_trgm ON v0.entities USING gin(lower(name) gin_trgm_ops);
 ANALYZE v0.entities;`);
console.log('One million synthetic rows loaded and indexed.');
const loadMs=performance.now()-started;
const queries=[
 {name:'exact_serial_scoped',sql:'SELECT id,name,serial FROM v0.entities WHERE serial=$1 AND school=$2',args:i=>['SER'+String((i*7919)%1000000+1).padStart(9,'0'),((i*7919)%1000000+1)%100]},
 {name:'school_status_first_page',sql:'SELECT id,name,serial FROM v0.entities WHERE school=$1 AND status=$2 ORDER BY id LIMIT 100',args:i=>[i%100,'active']},
 {name:'prefix_name_scoped',sql:"SELECT id,name FROM v0.entities WHERE lower(name) LIKE $1 AND school=$2 ORDER BY lower(name),id LIMIT 100",args:i=>['smith 00'+String(i%10)+'%',i%100]},
 {name:'trigram_substring_scoped',sql:"SELECT id,name FROM v0.entities WHERE lower(name) LIKE $1 AND school=$2 ORDER BY id LIMIT 100",args:i=>['%garcia 00'+String(i%10)+'%',i%100]}
];
const percentile=(v,p)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
let active=true;
const backgrounds=[0,1].map(async worker=>{let count=0;while(active){
 await db.query('SELECT count(*) FROM v0.entities WHERE school=$1',[count++%100]);
 await db.query("UPDATE v0.entities SET status=status WHERE id >= $1 AND id < $1+50",[(count*997+worker)%999900]);
}return count;});
const results=[];
for(const q of queries){
 const timings=[];
 for(let i=0;i<150;i++){const start=performance.now();const r=await db.query(q.sql,q.args(i));assert.ok(r.rowCount<=100);timings.push(performance.now()-start);}
 const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.args(42))).rows[0]['QUERY PLAN'];
 results.push({name:q.name,samples:150,p50Ms:percentile(timings,.5),p95Ms:percentile(timings,.95),p99Ms:percentile(timings,.99),maxMs:Math.max(...timings),plan});
 console.log(q.name,JSON.stringify({p95:percentile(timings,.95),p99:percentile(timings,.99)}));
}
active=false;const backgroundIterations=await Promise.all(backgrounds);
assert.equal((await db.query("SELECT id FROM v0.entities WHERE serial='SER000000001' AND school=2")).rowCount,0);
const bytes=(await db.query("SELECT pg_total_relation_size('v0.entities')::text AS bytes")).rows[0].bytes;
await writeFile(new URL('../evidence/query-probe.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),rows:1000000,loadMs,totalRelationBytes:bytes,backgroundIterations,results,
 limits:['SQL-only timings on this host, not API or browser latency','Warm and progressively warmed data, not controlled cold-cache results','Simple school predicate is not the complete grant model','No memberships, audit history, effective overlays, imports, or real Google load','Prefix and substring probes are not a complete ranked fuzzy-search design']},null,2)+'\n');
await db.end();

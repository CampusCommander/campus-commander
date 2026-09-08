export const httpProbe = `const fs=require('node:fs'),https=require('node:https'),tls=require('node:tls');
const host=process.env.CC_PROBE_HOST,port=Number(process.env.CC_PROBE_PORT);
const request=https.get({hostname:'127.0.0.1',port,path:process.argv[2],servername:host,
  ca:process.env.CC_PROBE_CA?fs.readFileSync(process.env.CC_PROBE_CA):undefined,rejectUnauthorized:true,
  checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(host,cert)},response=>{
    response.resume();if(response.statusCode!==200)process.exitCode=1;
  });request.setTimeout(2500,()=>request.destroy());request.on('error',()=>{process.exitCode=1;});`;

const imports = `import {readFile,mkdir,chmod} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('/app/package.json');const pg=require('pg');
const {parseDeploymentConfig}=await import('/app/dist/deployment/lib/deployment.js');
const {connectionOptions,connectDatabase,provision,migrate,checkReadiness,verifyConnection}=await import('/app/deployment/postgres/index.mjs');
const config=parseDeploymentConfig(JSON.parse(await readFile('/config/deployment.json','utf8')));
const secret=async ref=>(await readFile('/run/secrets/'+ref.name+'/'+ref.key,'utf8')).replace(/\\r?\\n$/,'');
const operator=JSON.parse(await readFile('/config/operator.json','utf8'));`;

export const prepare = `${imports}
let client;
try {
  const app=config.services.applicationDatabase,kestra=config.services.kestraDatabase;
  const settings={application:{database:app.database,role:app.role,password:await secret(app.passwordSecretRef),
    migrationRole:operator.migrationRole,migrationPassword:await secret(operator.migrationPasswordSecretRef)},
    kestra:{database:kestra.database,role:kestra.role,password:await secret(kestra.passwordSecretRef)}};
  for(const [only,service,key] of [['application',app,'applicationDatabase'],['kestra',kestra,'kestraDatabase']]) {
    if(service.placement.kind!=='local')continue;
    const admin=operator.databaseAdmins[key];
    client=new pg.Client(await connectionOptions({...service,database:'postgres',role:'postgres',passwordSecretRef:admin},secret));
    await client.connect();await provision(client,{...settings,only});await client.end();client=undefined;
  }
  client=await connectDatabase({...app,role:operator.migrationRole,passwordSecretRef:operator.migrationPasswordSecretRef},secret);
  await migrate(client,{runtimeRole:app.role});await client.end();client=undefined;
  client=await connectDatabase(app,secret);
  const {initializeBootstrap}=await import('/app/deployment/bootstrap/access.mjs');
  await initializeBootstrap(client,await secret(config.services.api.bootstrapSecretRef));
}catch{console.error('Installation database preparation failed.');process.exitCode=1;}
finally{await client?.end().catch(()=>undefined);}`;

export const waitDatabase = `${imports}
let accepted=false;
for(let attempt=0;attempt<120;attempt++){
  let client;
  try{
    const service=process.env.CC_WAIT_DATABASE==='kestra'?config.services.kestraDatabase:config.services.applicationDatabase;
    client=await connectDatabase(service,secret);
    accepted=process.env.CC_WAIT_DATABASE==='kestra'?true:await checkReadiness(client);
    if(accepted&&process.env.CC_WAIT_DATABASE!=='kestra')accepted=(await client.query('SELECT 1 FROM cc.bootstrap_access WHERE id=1')).rowCount===1;
  }catch{accepted=false;}finally{await client?.end().catch(()=>undefined);}
  if(accepted)break;await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!accepted){console.error('Database initialization is not ready.');process.exitCode=1;}`;

export const renderRedisScript = `${imports}
try{
 const {renderRedis}=await import('/app/deployment/redis/runtime.mjs');
 const {writeFile}=await import('node:fs/promises');
 await writeFile('/generated/redis.conf',renderRedis(config,Buffer.from(await secret(config.services.redis.passwordSecretRef))),{mode:0o600});
}catch{console.error('Redis runtime configuration failed.');process.exitCode=1;}`;

export const createDirectory = `const fs=require('node:fs');const path=process.env.CC_DIRECTORY;
fs.mkdirSync(path,{recursive:true,mode:0o700});fs.chmodSync(path,0o700);`;

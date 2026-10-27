#!/usr/bin/env node
// Offline one-time migration. Writes only to a new copy, never to the live DB.
import {existsSync, mkdirSync, realpathSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {preflightUnifiedTaskMigration, applyUnifiedTaskMigrationToCopy} from '../src/v2/unified-task-migration.js';

const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);return i===-1?null:args[i+1];};
const source=arg('--live-db'), artifactRoot=arg('--artifacts');
const projectId=arg('--project'), output=arg('--out'), apply=args.includes('--apply');
if(!source||!artifactRoot||!projectId||(apply&&!output)){
 console.error('Usage: node scripts/migrate-legacy-task-tree.mjs --live-db DB --artifacts DIR --project ID [--apply --out NEW_DB]');
 process.exitCode=2;
}else{
 const live=realpathSync(source);
 const db=new DatabaseSync(live,{readOnly:true});
 let copyStore;
 try{
  const liveTasks=db.prepare('SELECT id,version,updated_at,data_json FROM v2_tasks WHERE project_id=?').all(projectId)
    .map(row=>({...JSON.parse(row.data_json),id:row.id,version:row.version,updatedAt:row.updated_at}));
  const report=preflightUnifiedTaskMigration({artifactRoot,liveTasks});
  console.log(JSON.stringify({mode:'PREFLIGHT',projectId,report},null,2));
  if(apply){
   const out=resolve(output);
   if(out===live||existsSync(out)) throw new Error('output must be a new path, not live DB');
   if(!report.safeToApply) throw new Error('migration blocked: '+report.blockers.join(','));
   mkdirSync(dirname(out),{recursive:true});
   await backup(db,out);
   copyStore=new SQLiteV2Store(out);
   const migrated=applyUnifiedTaskMigrationToCopy({artifactRoot,store:copyStore,projectId,isolatedCopyConfirmed:true,liveDatabasePath:live});
   console.log(JSON.stringify({mode:'MIGRATED_COPY',out,migrated},null,2));
   console.log('Live DB unchanged. Review the copy and arrange a separate, offline activation.');
  }
 }finally{copyStore?.close();db.close();}
}

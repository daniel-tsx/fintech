import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { firstCaptureIntentHarness } from '../support/first-capture-intent-harness';

const describeMigration=process.env.RUN_DB_TESTS==='1'&&process.env.RUN_MIGRATION_TESTS==='1'?describe:describe.skip;
jest.setTimeout(30000);
describeMigration('B2-A forward migration and private authority',()=>{
  const folder=resolve(__dirname,'../../drizzle'), temporary=resolve(__dirname,'../../../../.tmp/r2-b2-a-tests');
  const harnesses:Awaited<ReturnType<typeof firstCaptureIntentHarness>>[]=[];const stagedFolders:string[]=[];
  function staged(count:number,failure=false){
    const target=resolve(temporary,randomUUID());mkdirSync(resolve(target,'meta'),{recursive:true});stagedFolders.push(target);
    const journal=JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};
    journal.entries=journal.entries.filter(e=>e.idx<count);writeFileSync(resolve(target,'meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)copyFileSync(resolve(folder,entry.tag+'.sql'),resolve(target,entry.tag+'.sql'));
    if(failure){const path=resolve(target,journal.entries.at(-1)!.tag+'.sql');writeFileSync(path,readFileSync(path,'utf8')+"\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'planned B2-A rollback'; END $$;\n");}
    return target;
  }
  async function setup(source=folder){
    const h=await firstCaptureIntentHarness(source);harnesses.push(h);const url=new URL(process.env.MIGRATION_ADMIN_URL!);
    url.pathname='/'+String((await h.db.sql`select current_database() n`)[0].n);
    async function apply(from=folder){const sql=postgres(url.toString(),{max:1,connection:{statement_timeout:10000}});try{await migrate(drizzle(sql),{migrationsFolder:from});}finally{await sql.end();}}
    return{h,url,apply};
  }
  afterAll(async()=>{
    for(const h of harnesses)await h.close(16);
    for(const path of stagedFolders){if(!resolve(path).startsWith(temporary+sep))throw new Error('Staged migration cleanup escaped task directory');rmSync(path,{recursive:true,force:true});}
  });
  async function data(sql:Sql,names?:string[]){
    const selected=names??(await sql<{name:string}[]>`select tablename name from pg_tables where schemaname='public' order by tablename`).map(x=>x.name);
    const result:Record<string,unknown>={};for(const name of selected)result[name]=await sql`select to_jsonb(t) row from ${sql('public.'+name)} t order by to_jsonb(t)::text`;return result;
  }
  async function catalog(sql:Sql){return{
    functions:await sql<{oid:number;proname:string;proowner:number;proacl:string|null;definition:string}[]>`select oid,proname,proowner,proacl::text,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace order by oid`,
    functionGrants:await sql<{oid:number;grantor:number;grantee:number;privilege_type:string;is_grantable:boolean;role_name:string|null}[]>`select p.oid,a.grantor,a.grantee,a.privilege_type,a.is_grantable,r.rolname role_name
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles r on r.oid=a.grantee
      where p.pronamespace='public'::regnamespace order by p.oid,a.grantee,a.grantor,a.privilege_type`,
    constraints:await sql`select c.relname,k.conname,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by c.relname,k.conname`,
    relations:await sql`select relname,relowner,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname`,
    roles:await sql`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where position(md5(current_database()) in rolname)>0 order by rolname`,
    schema:await sql`select nspacl::text from pg_namespace where nspname='public'`,
  };}
  it('installs sixteen migrations with empty capabilities and no runtime or monetary grants',async()=>{
    const{h,apply}=await setup();await apply();await apply();
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(16);
    for(const table of ['capture_preparation_issuances','financial_application_contracts','financial_application_scope_authority','financial_application_permits'])
      expect(await h.db.sql`select 1 from ${h.db.sql(table)}`).toHaveLength(0);
    expect(await h.db.sql`select 1 from capture_accounting_scopes where status='ACTIVE'`).toHaveLength(0);
    const functions=await h.db.sql`select p.proname,p.proconfig,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a join pg_roles r on r.oid=a.grantee where r.rolcanlogin and a.privilege_type='EXECUTE') login_execute
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('prepare_capture_application','read_capture_preparation','claim_capture_preparation','validate_capture_preparation')`;
    expect(functions).toHaveLength(4);for(const f of functions)expect(f).toMatchObject({proconfig:['search_path=pg_catalog, pg_temp'],public_execute:false,login_execute:false});
    const[owner]=await h.db.sql<{rolname:string}[]>`select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname='fintech_capture_prepare_'||md5(current_database())`;
    expect(owner).toMatchObject({rolcanlogin:false,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
    expect(await h.db.sql`select 1 from pg_auth_members a join pg_roles r on r.oid=a.roleid where r.rolname=${owner.rolname}`).toHaveLength(0);
    const[rights]=await h.db.sql`select has_schema_privilege(${owner.rolname},'public','CREATE') create_schema,
      has_table_privilege(${owner.rolname},'public.ledger_transactions','INSERT') journal,
      has_table_privilege(${owner.rolname},'public.ledger_entries','INSERT') entry,
      has_table_privilege(${owner.rolname},'public.ledger_accounts','INSERT') account,
      has_table_privilege(${owner.rolname},'public.financial_applications','INSERT') application,
      has_table_privilege(${owner.rolname},'public.financial_application_dispositions','INSERT') disposition,
      has_table_privilege(${owner.rolname},'public.financial_application_contracts','INSERT') contract,
      has_table_privilege(${owner.rolname},'public.financial_application_scope_authority','INSERT') enrollment,
      has_column_privilege(${owner.rolname},'public.payments','captured_amount','UPDATE') captured,
      has_column_privilege(${owner.rolname},'public.webhook_events','status','UPDATE') terminal`;
    expect(Object.values(rights)).toEqual(Array(10).fill(false));
  });
  it('preserves populated0014 P-B/P-C/B1, obligations and all historical functions/keys',async()=>{
    const{h,apply}=await setup(staged(15));await h.install();const f=await h.fixture(),[accepted]=await h.accept(await h.request(f));
    const e=await h.captureEvidence(f,accepted.result),before=await data(h.db.sql),old=await catalog(h.db.sql);
    await apply();await apply();expect(await data(h.db.sql,Object.keys(before))).toEqual(before);
    const current=await catalog(h.db.sql);
    for(const fn of old.functions){
      const changed=['guard_manual_authorization_authority','current_financial_application_manifest'].includes(fn.proname);
      expect(current.functions).toEqual(expect.arrayContaining([expect.objectContaining({oid:fn.oid,proname:fn.proname,proowner:fn.proowner,
        ...(changed?{proacl:fn.proacl}:{definition:fn.definition})})]));
    }
    expect(current.functionGrants).toEqual(expect.arrayContaining([...old.functionGrants]));
    const oldIds=new Set(old.functions.map(f=>f.oid)),additions=current.functionGrants.filter(g=>oldIds.has(g.oid)&&!old.functionGrants.some(o=>JSON.stringify(o)===JSON.stringify(g)));
    for(const grant of additions){expect(grant.privilege_type).toBe('EXECUTE');expect(grant.is_grantable).toBe(false);expect(grant.role_name).toMatch(/^fintech_capture_(prepare|check)_[a-f0-9]{32}$/);}
    expect(current.constraints).toEqual(expect.arrayContaining([...old.constraints]));
    expect((await h.db.sql`select public.manual_authorization_history(${f.rootId}) valid`)[0].valid).toBe(true);
    expect((await h.db.sql`select public.check_first_capture_intent((select id from first_capture_intent_manifests where payment_id=${f.paymentId}),true,true) valid`)[0].valid).toBe(true);
    expect(await h.evidence.read(e.inboxId,'payment.capture_succeeded')).toMatchObject({id:e.proofId,capture_principal:'10000'});
    expect((await h.db.sql`select disposition,reason from provider_observation_obligations where source_id=${e.sourceId}`)[0])
      .toEqual({disposition:'BLOCKING_REVIEW',reason:'CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED'});
    await expect(h.inspect(f)).rejects.toThrow(/blocked/);
  });
  it('late0015 failure restores catalogs, privileges and populated evidence before retry',async()=>{
    const{h,apply}=await setup(staged(15));await h.install();const f=await h.fixture();await h.accept(await h.request(f));
    const before=await data(h.db.sql),old=await catalog(h.db.sql);let error:unknown;
    try{await apply(staged(16,true));}catch(e){error=e;}
    expect((error as {cause:Error}).cause.message).toMatch('planned B2-A rollback');
    expect(await data(h.db.sql)).toEqual(before);expect(await catalog(h.db.sql)).toEqual(old);
    expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(15);
    await apply();expect((await h.db.sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(16);
  });
  it('waits on a real root-table writer with no partial capability visible',async()=>{
    const{h,url,apply}=await setup(staged(15));let release!:()=>void,ready!:()=>void,holder=0;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
    const first=h.db.transaction(async tx=>{holder=Number((await tx`select pg_backend_pid() p`)[0].p);await tx`lock table public.financial_application_roots in row exclusive mode`;ready();await gate;});
    const sql=postgres(url.toString(),{max:1,connection:{statement_timeout:10000}});let pending:Promise<void>|undefined;
    try{await Promise.race([started,first]);const waiter=Number((await sql`select pg_backend_pid() p`)[0].p);expect(waiter).not.toBe(holder);
      pending=migrate(drizzle(sql),{migrationsFolder:folder});let observed=false;
      for(let n=0;n<150;n++){if((await h.db.sql`select ${holder}=any(pg_blocking_pids(${waiter})) blocked`)[0].blocked){observed=true;break;}await delay(20);}
      expect(observed).toBe(true);expect(await h.db.sql`select 1 from pg_tables where schemaname='public' and tablename='capture_preparation_issuances'`).toHaveLength(0);
      expect(await h.db.sql`select 1 from pg_proc where pronamespace='public'::regnamespace and proname='prepare_capture_application'`).toHaveLength(0);
      release();await Promise.all([first,pending]);await apply();
    }finally{release();await Promise.allSettled([first,...(pending?[pending]:[])]);await sql.end();}
  });
});

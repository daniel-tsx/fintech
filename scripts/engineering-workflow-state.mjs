#!/usr/bin/env node
// Local, dependency-free checkpoint/resume ledger. This is NOT an agent launcher
// or authorization mechanism; reviewer provenance and command results need external verification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(repo, '.tmp', 'agent-workflows');
const MODES = new Set(['DESIGN_ONLY','MEDIUM','HIGH_RISK']);
const WRITE_STAGES = new Set(['PLAN','CORRECT_DESIGN','IMPLEMENT','CORRECT']);
const STATES = new Set(['INSPECT','PLAN','PLAN_REVIEW','CORRECT_DESIGN','IMPLEMENT','VERIFY','CODE_REVIEW','CORRECT','FINAL_GATE','HUMAN_APPROVAL','BLOCKED']);
const gates = {
  INSPECT: { READY: 'PLAN' },
  PLAN: { READY: 'PLAN_REVIEW' },
  PLAN_REVIEW: { PLAN_APPROVED: 'APPROVED_NEXT', PLAN_REQUEST_CHANGES: 'CORRECT_DESIGN' },
  CORRECT_DESIGN: { READY: 'PLAN_REVIEW' },
  IMPLEMENT: { READY: 'VERIFY' },
  VERIFY: { VERIFIED: 'CODE_REVIEW', FAILED: 'CORRECT' },
  CODE_REVIEW: { REVIEW_APPROVED: 'FINAL_GATE', REVIEW_REQUEST_CHANGES: 'CORRECT' },
  CORRECT: { READY: 'VERIFY' },
  FINAL_GATE: { PASSED: 'HUMAN_APPROVAL', BLOCKED: 'BLOCKED' }
};
const [command, slug, ...raw] = process.argv.slice(2);
const json = value => JSON.stringify(value, null, 2);
function git(...args) { return execFileSync('git', args, { cwd: repo, encoding: 'buffer', stdio: ['ignore','pipe','pipe'] }); }
function gitText(...args) { return git(...args).toString('utf8').trim(); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function field(hash, name, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  hash.update(Buffer.from(`${name}:${b.length}:`, 'utf8')); hash.update(b); hash.update(Buffer.from('\n'));
}
function sourceFingerprint() {
  // HEAD + staged index + porcelain status + every nonignored tracked/untracked
  // worktree file's bytes. Independent of mtime and ignored handoff artifacts.
  const hash = createHash('sha256');
  const head = gitText('rev-parse','HEAD');
  field(hash, 'HEAD', head);
  field(hash, 'INDEX', git('ls-files','--stage','-z'));
  field(hash, 'STATUS', git('status','--porcelain=v1','-z','--untracked-files=all'));
  const names = git('ls-files','--cached','--others','--exclude-standard','-z')
    .toString('utf8').split('\0').filter(Boolean).sort();
  for(const name of names) {
    field(hash,'PATH',name);
    const full = join(repo, name);
    if(!existsSync(full)) { field(hash,'MISSING','1'); continue; }
    const st = lstatSync(full);
    if(st.isSymbolicLink()) field(hash,'SYMLINK',readlinkSync(full));
    else if(st.isFile()) field(hash,'FILE',readFileSync(full));
    else if(st.isDirectory()) field(hash,'SUBMODULE_OR_DIRECTORY',name);
    else field(hash,'SPECIAL',st.mode);
    field(hash,'MODE',st.mode & 0o111);
  }
  return {head, sha256:hash.digest('hex'), files:names.length};
}
function taskDir() {
  assert(slug && /^[a-z0-9][a-z0-9._-]{0,69}$/.test(slug) && !['.','..'].includes(slug),
    'Task slug must be a safe lowercase identifier (max 70 chars)');
  return join(workspace,slug);
}
function assertIgnored(dir) {
  assert(gitText('rev-parse','--show-toplevel').replaceAll('\\','/').toLowerCase() === repo.replaceAll('\\','/').toLowerCase(),
    'Script must be located directly in the Git repository root/scripts');
  const rel = relative(repo,join(dir,'state.json')).split(sep).join('/');
  try { git('check-ignore','--quiet','--',rel); } catch { throw new Error(`Refusing to store workflow state outside gitignored path: ${rel}`); }
}
function stateFile(dir){return join(dir,'state.json');}
function load(dir) {
  const p = stateFile(dir);
  assert(existsSync(p),`Missing checkpoint ${p}; use init first`);
  let state;
  try {state=JSON.parse(readFileSync(p,'utf8'));} catch {throw new Error('Checkpoint JSON is damaged. Restore it; do not infer/auto-approve prior stages.');}
  assert(state.schema===1&&state.task===slug&&MODES.has(state.mode)&&STATES.has(state.stage)&&
    Number.isInteger(state.correctionRoundsUsed)&&state.correctionRoundsUsed>=0&&state.correctionRoundsUsed<=2&&
    Array.isArray(state.history)&&Array.isArray(state.artifacts), 'Invalid checkpoint schema: fail closed');
  return state;
}
function save(dir,state) {
  state.updatedAt = new Date().toISOString();
  const file=stateFile(dir), tmp=join(dir,`state.${process.pid}.tmp`);
  // Existing journal remains intact if write fails. Move atomically within same filesystem.
  writeFileSync(tmp,json(state)+'\n',{flag:'wx',mode:0o600});
  renameSync(tmp,file);
}
function options(argv) {
  const opt={};
  for(let i=0;i<argv.length;i+=2) {
    const k=argv[i];assert(k?.startsWith('--')&&i+1<argv.length,`Expected --key value, got ${k}`);
    assert(!Object.hasOwn(opt,k),`Duplicate option ${k}`);
    opt[k]=argv[i+1];
  }
  return opt;
}
function evidence(dir, supplied) {
  if(!supplied) return null;
  assert(!isAbsolute(supplied), 'Evidence path must be relative to the repository');
  const full=resolve(repo,supplied), r=relative(dir,full);
  assert(r && r!=='.'&&!r.startsWith(`..${sep}`)&&r!=='..'&&!isAbsolute(r),
    'Evidence must be inside the ignored task workspace');
  assert(existsSync(full)&&lstatSync(full).isFile()&&!lstatSync(full).isSymbolicLink(), `Missing or unsafe evidence file ${supplied}`);
  const realDir=realpathSync(dir), realFile=realpathSync(full), rr=relative(realDir,realFile);
  assert(rr && rr!=='..'&&!rr.startsWith(`..${sep}`)&&!isAbsolute(rr), 'Evidence symlinks may not escape task workspace');
  return {path:relative(repo,full).split(sep).join('/'),sha256:sha(readFileSync(full))};
}
function artifactProblems(state,dir,allowPlanInProgress=false) {
  const issues=[];
  for(const a of state.artifacts) {
    if(allowPlanInProgress && a.kind==='plan') continue;
    try {
      const now=evidence(dir,a.path);
      if(now.sha256!==a.sha256) issues.push(`Modified: ${a.path}`);
    } catch { issues.push(`Missing/unsafe: ${a.path}`); }
  }
  return issues;
}
function currentAssessment(state,dir) {
  const now=sourceFingerprint();
  const writing=WRITE_STAGES.has(state.stage);
  const changed=now.sha256!==state.revision.sha256;
  const mismatched=artifactProblems(state,dir,state.stage==='CORRECT_DESIGN');
  const result=mismatched.length ? 'BLOCKED_EVIDENCE_CHANGED'
    : changed && !writing ? 'BLOCKED_REVISION_CHANGED'
    : changed && writing ? 'IN_PROGRESS_EDIT' : 'READY';
  return {result,stage:state.stage,revisionChanged:changed,artifactProblems:mismatched,
    correctionRoundsUsed:state.correctionRoundsUsed,correctionBudgetRemaining:2-state.correctionRoundsUsed,
    paused:state.paused??null,base:state.base,currentHead:now.head,sourceFingerprint:now.sha256,
    nextAction: result==='READY'||result==='IN_PROGRESS_EDIT'?`Continue ${state.stage}; never infer a completed stage from an interruption`: 'Stop, inspect and use explicitly reviewed rebaseline; approvals may not be reused'};
}
function fail(message) {throw new Error(message);}
function parseEvidence(dir,opt,required=false) {
  const a=evidence(dir,opt['--artifact']);
  if(required)assert(a,'Stage requires --artifact <ignored task file>, containing independent or executable evidence');
  return a;
}
function appendArtifact(state,a,kind) {
  if(!a)return;
  const prior=state.artifacts.findIndex(x=>x.path===a.path);
  if(prior>=0) {
    assert(kind==='plan'||kind==='verification'||kind==='final',
      'Reviewer findings must use a new immutable artifact filename per review attempt');
    state.artifacts.splice(prior,1);
  }
  state.artifacts.push({...a,kind});
}
function run() {
  assert(command&&slug,'Usage: node scripts/engineering-workflow-state.mjs <init|resume|advance|pause|rebaseline> <task-slug> ...');
  const dir=taskDir(); assertIgnored(dir);
  const lockFile=join(dir,'.checkpoint.lock');
  const isWrite=['init','advance','pause','rebaseline'].includes(command);
  let locked=false;
  if(isWrite) {
    mkdirSync(dir,{recursive:true});
    assert(!lstatSync(dir).isSymbolicLink(),'Unsafe task workspace symlink');
    try {writeFileSync(lockFile,`${process.pid} ${new Date().toISOString()}\n`,{flag:'wx',mode:0o600});locked=true;}
    catch(e) {if(e.code==='EEXIST')fail(`Task checkpoint is locked; inspect ${lockFile} and verify no writer is running before manual cleanup`);throw e;}
  } else if(command==='resume'&&existsSync(lockFile)) {
    fail(`A checkpoint writer is active or a stale lock remains at ${lockFile}; inspect before resuming`);
  }
  try {
  if(command==='init') {
    const [mode,...rest]=raw; assert(MODES.has(mode),'Usage: init <slug> DESIGN_ONLY|MEDIUM|HIGH_RISK');
    assert(rest.length===0,'Unexpected arguments');
    assert(!existsSync(stateFile(dir)), 'Checkpoint already exists; use resume, not init');
    mkdirSync(dir,{recursive:true});
    const rev=sourceFingerprint();
    const state={schema:1,task:slug,mode,base:rev.head,stage:'INSPECT',revision:rev,
      correctionRoundsUsed:0,artifacts:[],approvals:{plan:null,code:null},verification:null,paused:null,
      history:[{time:new Date().toISOString(),stage:'INSPECT',event:'INITIALIZED',revision:rev.sha256}]};
    save(dir,state);console.log(json({status:'INITIALIZED',task:slug,mode,stage:'INSPECT',sourceFingerprint:rev.sha256}));return;
  }
  const state=load(dir);
  if(command==='resume') {assert(raw.length===0,'resume takes no extra arguments');console.log(json(currentAssessment(state,dir)));return;}
  if(command==='pause') {
    const [why,...rest]=raw;
    assert(['USAGE_LIMIT','REVIEW_CAPACITY','PERMISSION','ENVIRONMENT','INTERRUPTED'].includes(why),'Invalid pause reason');
    assert(rest.length===0,'Unexpected pause arguments');
    state.paused={reason:why,at:new Date().toISOString(),stage:state.stage};
    state.history.push({time:state.paused.at,stage:state.stage,event:`PAUSED_${why}`});
    save(dir,state);console.log(json({status:'PAUSED',stage:state.stage,reason:why}));return;
  }
  if(command==='rebaseline') {
    const [target,...rest]=raw,opt=options(rest);
    assert(opt['--reason']?.trim().length>=12,'Explicit --reason (12+ chars) is required');
    assert(state.stage!=='HUMAN_APPROVAL','Human-approval gate requires fresh explicit human decision, not auto rebaseline');
    assert(target==='PLAN'||(state.mode!=='DESIGN_ONLY'&&target==='VERIFY'),
      'Rebaseline must restart PLAN, or VERIFY with independently preserved plan approval');
    if(target==='VERIFY') {
      assert(state.approvals.plan, 'VERIFY rebaseline requires existing independently approved plan');
      assert(state.artifacts.some(a=>a.kind==='plan'), 'VERIFY rebaseline requires an unchanged recorded plan artifact');
    }
    const issues=artifactProblems(state,dir,true);
    const immutableReviewProblems=state.artifacts.filter(a=>a.kind==='review').filter(a=>{
      try { return evidence(dir,a.path).sha256!==a.sha256; } catch { return true; }
    });
    assert(immutableReviewProblems.length===0,'Prior reviewer artifact changed; restore original evidence before rebaseline');
    const now=sourceFingerprint();
    state.stage=target;state.revision=now;state.paused=null;
    if(target==='PLAN')state.approvals={plan:null,code:null};
    else state.approvals.code=null;
    state.verification=null;
    // Do not trust any stale artifact digest after an explicit rebaseline.
    // Historical review evidence must still be intact; only updated plan/verification
    // evidence is removed from the active snapshot, not deleted from disk.
    state.artifacts=state.artifacts.filter(x=>x.kind==='review'||target==='VERIFY'&&x.kind==='plan');
    state.history.push({time:new Date().toISOString(),stage:target,event:'EXPLICIT_REBASELINE',reason:opt['--reason'],revision:now.sha256});
    save(dir,state);console.log(json({status:'REBASELINED_REAPPROVAL_REQUIRED',stage:target,correctionRoundsUsed:state.correctionRoundsUsed}));return;
  }
  if(command==='advance') {
    const [verdict,...rest]=raw,opt=options(rest),stage=state.stage;
    assert(!['BLOCKED','HUMAN_APPROVAL'].includes(stage),'Cannot auto-advance a stopped/human-gated workflow');
    assert(verdict&&Object.hasOwn(gates[stage]??{},verdict),`Invalid ${stage} verdict ${verdict}`);
    const assessed=currentAssessment(state,dir);
    assert(['READY','IN_PROGRESS_EDIT'].includes(assessed.result),`Refuse advance: ${assessed.result}; use resume/rebaseline`);
    assert(!assessed.revisionChanged||WRITE_STAGES.has(stage),'Unreviewed source revision change');
    const needsReview=stage==='PLAN_REVIEW'||stage==='CODE_REVIEW';
    const requireArtifact=needsReview||stage==='PLAN'||stage==='CORRECT_DESIGN'||
      stage==='VERIFY'&&verdict==='VERIFIED'||stage==='FINAL_GATE'&&verdict==='PASSED';
    const a=parseEvidence(dir,opt,requireArtifact);
    if(needsReview){
      assert(opt['--reviewer-id']&&opt['--reviewer-id']!=='self',
        'Independent reviewer provenance required (--reviewer-id <fresh-agent/session-id>); must be verified externally');
      assert(!state.history.some(h=>h.reviewer===opt['--reviewer-id']),
        'A fresh review cannot reuse a previously checkpointed reviewer/session ID');
    }
    assert(!opt['--reviewer-id']||needsReview,'--reviewer-id applies only to independent reviews');
    let next=gates[stage][verdict];
    if(next==='APPROVED_NEXT')next=state.mode==='DESIGN_ONLY'?'FINAL_GATE':'IMPLEMENT';
    if(['CORRECT_DESIGN','CORRECT'].includes(next)) {
      if(state.correctionRoundsUsed===2)fail('Correction budget exhausted; stop and obtain human decision (do not reset counter)');
      state.correctionRoundsUsed++;
    }
    const now=sourceFingerprint();
    if(stage==='PLAN'||stage==='CORRECT_DESIGN')appendArtifact(state,a,'plan');
    else if(needsReview)appendArtifact(state,a,'review');
    else if(stage==='VERIFY') {appendArtifact(state,a,'verification');if(verdict==='VERIFIED')state.verification={revision:now.sha256,evidence:a};}
    else if(stage==='FINAL_GATE')appendArtifact(state,a,'final');
    else appendArtifact(state,a,'handoff');
    if(stage==='PLAN_REVIEW'){
      if(verdict==='PLAN_APPROVED')state.approvals.plan={revision:now.sha256,reviewer:opt['--reviewer-id'],evidence:a};
      else state.approvals.plan=null;
    }
    if(stage==='CODE_REVIEW'){
      if(verdict==='REVIEW_APPROVED')state.approvals.code={revision:now.sha256,reviewer:opt['--reviewer-id'],evidence:a};
      else state.approvals.code=null;
    }
    if(['IMPLEMENT','CORRECT'].includes(stage)) {state.approvals.code=null;state.verification=null;}
    if(stage==='VERIFY'&&verdict==='FAILED') {state.approvals.code=null;state.verification=null;}
    if(stage==='FINAL_GATE'&&verdict==='PASSED') {
      if(state.mode==='DESIGN_ONLY')assert(state.approvals.plan?.revision===now.sha256,'Design approval does not match source revision');
      else {
        assert(state.approvals.plan&&state.approvals.code?.revision===now.sha256,'Missing code approval for current source revision');
        assert(state.verification?.revision===now.sha256,'Mandatory verification not recorded for current revision');
      }
    }
    state.stage=next;state.revision=now;state.paused=null;
    state.history.push({time:new Date().toISOString(),stage,event:verdict,next,revision:now.sha256,
      artifact:a?.path??null,reviewer:opt['--reviewer-id']??null,correctionRoundsUsed:state.correctionRoundsUsed});
    save(dir,state);console.log(json({status:'CHECKPOINT_SAVED',completed:stage,verdict,next,
      sourceFingerprint:now.sha256,correctionRoundsUsed:state.correctionRoundsUsed}));return;
  }
  fail(`Unknown command: ${command}`);
  } finally {if(locked)unlinkSync(lockFile);}
}
try {run();} catch(e) {console.error(`WORKFLOW_STATE_BLOCKED: ${e.message}`);process.exitCode=1;}

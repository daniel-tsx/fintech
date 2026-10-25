-- P-B: private MANUAL authorization only. Contracts/enrollments stay empty;
-- no runtime principal, capture intent, provider call or monetary effect.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.financial_application_roots IN SHARE ROW EXCLUSIVE MODE;

-- Claim bookkeeping is a separate capability, with the same unforgeable
-- transaction/backend/principal binding as an application permit.
CREATE TABLE public.manual_authorization_claim_writes (
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, database_principal name NOT NULL,
  inbox_id uuid NOT NULL REFERENCES public.webhook_events(id),
  operation text NOT NULL CHECK(operation IN ('CLAIM','FAIL')),
  before_image jsonb NOT NULL, after_image jsonb NOT NULL,
  PRIMARY KEY(transaction_id,backend_pid,inbox_id)
);
CREATE TRIGGER manual_claim_immutable BEFORE UPDATE OR DELETE ON public.manual_authorization_claim_writes
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence();
CREATE TRIGGER manual_claim_truncate BEFORE TRUNCATE ON public.manual_authorization_claim_writes
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence();
REVOKE ALL ON public.manual_authorization_claim_writes FROM PUBLIC;

-- The trigger can discover owners with private reads without trusting the
-- invoking role. Only prepare's NOLOGIN owner can mint these exact images.
CREATE TABLE public.manual_authorization_issuances (
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, database_principal name NOT NULL,
  root_id uuid NOT NULL UNIQUE REFERENCES public.financial_application_roots(id) DEFERRABLE INITIALLY DEFERRED,
  manifest_id uuid NOT NULL UNIQUE REFERENCES public.financial_application_manifests(id) DEFERRABLE INITIALLY DEFERRED,
  root_image jsonb NOT NULL, manifest_image jsonb NOT NULL,
  PRIMARY KEY(transaction_id,backend_pid)
);
CREATE TRIGGER manual_issuance_immutable BEFORE UPDATE OR DELETE ON public.manual_authorization_issuances
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence();
CREATE TRIGGER manual_issuance_truncate BEFORE TRUNCATE ON public.manual_authorization_issuances
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence();
REVOKE ALL ON public.manual_authorization_issuances FROM PUBLIC;

CREATE FUNCTION public.manual_authorization_scope_protected(p_merchant uuid,p_currency text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=p_merchant AND currency=p_currency)
    AND (EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='AUTHORIZE' AND phase='TERMINAL' AND policy='LEGACY' AND version=1
      AND prepare_function='public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_manual_authorization(uuid)'::regprocedure)
      OR EXISTS(SELECT 1 FROM public.manual_authorization_issuances WHERE root_image->>'merchant_id'=p_merchant::text AND root_image->>'currency'=p_currency));
END $$;

CREATE FUNCTION public.guard_manual_authorization_issuance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user<>'fintech_manual_authorization_'||md5(current_database())
    OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.database_principal IS DISTINCT FROM session_user OR NEW.root_image->>'id' IS DISTINCT FROM NEW.root_id::text
    OR NEW.root_image->>'family' IS DISTINCT FROM 'AUTHORIZE' OR NEW.manifest_image->>'id' IS DISTINCT FROM NEW.manifest_id::text
    OR NEW.manifest_image->>'root_id' IS DISTINCT FROM NEW.root_id::text
    OR NEW.manifest_image->>'transaction_id' IS DISTINCT FROM NEW.transaction_id::text
    OR (NEW.manifest_image->>'backend_pid')::integer IS DISTINCT FROM NEW.backend_pid
    OR NEW.manifest_image#>>'{source_manifest,database_principal}' IS DISTINCT FROM NEW.database_principal::text THEN
    RAISE EXCEPTION 'Protected SQL authorization issuance writer required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_issuance_writer BEFORE INSERT ON public.manual_authorization_issuances
  FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_issuance();

-- Keep the installed REFUND implementations byte-for-byte as private delegates.
-- Replacing the original OIDs below also preserves every existing trigger binding.
DO $$ DECLARE n text; d text; prefix text; owner_name name; BEGIN
  FOREACH n IN ARRAY ARRAY['validate_financial_application'] LOOP
    SELECT pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner) INTO STRICT d,owner_name
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=n;
    prefix:='CREATE OR REPLACE FUNCTION public.'||n||'(';
    IF left(d,length(prefix))<>prefix THEN RAISE EXCEPTION 'Unexpected installed application function %',n; END IF;
    EXECUTE overlay(d placing 'CREATE OR REPLACE FUNCTION public.'||n||'_before_manual_authorization(' from 1 for length(prefix));
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',n||'_before_manual_authorization',CASE WHEN n='validate_financial_application' THEN 'uuid' ELSE '' END);
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',owner_name);
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',n||'_before_manual_authorization',CASE WHEN n='validate_financial_application' THEN 'uuid' ELSE '' END,owner_name);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.validate_financial_application(p_root uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE;
BEGIN
  SELECT v.* INTO m FROM public.financial_applications a JOIN public.financial_application_manifests v ON v.id=a.manifest_id WHERE a.root_id=p_root;
  IF FOUND AND m.proof_kind='PAYMENT_OPERATION_V1' THEN
    -- advance_financial_application_revision calls this before minting its
    -- revision effect; deferred closure separately requires that exact effect.
    PERFORM public.check_manual_authorization(m.id,false,false);
  ELSE
    PERFORM public.validate_financial_application_before_manual_authorization(p_root);
  END IF;
END $$;

-- Historical authentication deliberately reads only the original immutable
-- command/execution/source/signed receipt, never current capture eligibility.
CREATE FUNCTION public.manual_authorization_original_proof(p_proof uuid)
RETURNS public.payment_operation_evidence
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.payment_operation_evidence%ROWTYPE; a public.provider_command_authorities%ROWTYPE;
  r public.provider_financial_receipts%ROWTYPE; s public.provider_observation_sources%ROWTYPE;
  checked jsonb; b jsonb; obj jsonb; response jsonb; facts jsonb; meta jsonb; k text; expected text;
BEGIN
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE id=p_proof;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=e.outbox_id;
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=e.source_id AND outbox_id=e.outbox_id AND execution_id=e.execution_id;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=e.inbox_id;
  IF (e.proof_version,e.validator_version,e.operation,e.outcome,e.provider_mode,e.accounting_policy,e.acceptance_epoch)
      IS DISTINCT FROM (1,'PAYMENT_OPERATION_V1','payment.authorized','AUTHORIZE_SUCCEEDED','TEST','LEGACY',0::bigint)
    OR e.authorization_source_id IS NOT NULL OR e.capture_principal IS NOT NULL
    OR e.authorized_principal IS NULL OR e.authorized_principal<=0 OR e.authorized_principal>9007199254740991
    OR (a.operation,a.operation_id,a.payment_id,a.merchant_id,a.currency,a.provider,a.provider_account,a.provider_mode,a.amount,a.accounting_policy,a.acceptance_epoch)
      IS DISTINCT FROM ('AUTHORIZE',e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.provider_mode,e.authorized_principal,e.accounting_policy,e.acceptance_epoch)
    OR NOT EXISTS(SELECT 1 FROM public.provider_command_executions WHERE id=e.execution_id AND outbox_id=e.outbox_id)
    OR NOT EXISTS(SELECT 1 FROM public.receipt_admissions WHERE inbox_id=e.inbox_id AND contract_version=2 AND operation=e.operation
      AND provider=e.provider AND provider_account=e.provider_account AND financially_relevant)
    OR (r.provider,r.provider_account) IS DISTINCT FROM (e.provider,e.provider_account) THEN
    RAISE EXCEPTION 'Exact original test MANUAL authorization proof required'; END IF;
  checked:=public.checked_payment_command_source(e.source_id); response:=checked->'object';
  b:=public.payment_json(r.raw_body); obj:=b#>'{data,object}';
  IF public.payment_operation_receipt_facts(e.inbox_id)->>'contradiction' IS NOT NULL
    OR public.payment_operation_receipt_facts(e.inbox_id)->>'operation' IS DISTINCT FROM e.operation
    OR b->>'type' IS DISTINCT FROM 'payment_intent.amount_capturable_updated'
    OR b->>'api_version' IS DISTINCT FROM '2026-08-26.dahlia'
    OR b->'livemode' IS DISTINCT FROM 'false'::jsonb OR obj->'livemode' IS DISTINCT FROM 'false'::jsonb
    OR b#>>'{request,idempotency_key}' IS DISTINCT FROM a.command_key
    OR b#>>'{request,id}' IS DISTINCT FROM checked->>'request_id'
    OR (response->>'id',public.financial_external_reference(response->'latest_charge')) IS DISTINCT FROM (e.payment_intent_id,e.charge_id)
    OR (e.charge_id LIKE 'ch\_%' ESCAPE '\') IS NOT TRUE
    OR (obj->>'id',upper(obj->>'currency'),public.financial_external_reference(obj->'latest_charge'))
      IS DISTINCT FROM (e.payment_intent_id,e.currency,e.charge_id)
    OR response->>'status' IS DISTINCT FROM 'requires_capture' OR obj->>'status' IS DISTINCT FROM 'requires_capture'
    OR response->>'capture_method' IS DISTINCT FROM 'manual'
    OR (obj?'capture_method' AND obj->>'capture_method' IS DISTINCT FROM 'manual')
    OR public.payment_minor(response,'amount') IS DISTINCT FROM a.amount
    OR public.payment_minor(response,'amount_received') IS DISTINCT FROM 0::bigint
    OR public.payment_minor(response,'amount_capturable') IS DISTINCT FROM a.amount
    OR public.payment_minor(obj,'amount') IS DISTINCT FROM a.amount
    OR public.payment_minor(obj,'amount_received') IS DISTINCT FROM 0::bigint
    OR public.payment_minor(obj,'amount_capturable') IS DISTINCT FROM a.amount THEN
    RAISE EXCEPTION 'Original signed authorization and command result disagree'; END IF;
  FOREACH meta IN ARRAY ARRAY[obj->'metadata',response->'metadata'] LOOP
    IF meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object' THEN RAISE EXCEPTION 'Malformed original authorization metadata'; END IF;
    FOREACH k IN ARRAY ARRAY['merchantId','paymentId','authorizeAttemptId','currency'] LOOP
      expected:=CASE k WHEN 'merchantId' THEN a.merchant_id::text WHEN 'paymentId' THEN a.payment_id::text WHEN 'authorizeAttemptId' THEN a.operation_id::text ELSE a.currency END;
      IF meta?k AND (jsonb_typeof(meta->k) IS DISTINCT FROM 'string' OR meta->>k IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'Original authorization metadata contradiction'; END IF;
    END LOOP;
  END LOOP;
  -- This is the exact immutable B1 AUTH interpretation, including its null
  -- predecessor/finality fields, not a weakened subset of a capture proof.
  facts:=jsonb_build_object('validator','PAYMENT_OPERATION_V1','interpretation','STRIPE_PAYMENT_WORKFLOW_V1',
    'operation',e.operation,'outcome','AUTHORIZE_SUCCEEDED','provider',a.provider,'provider_account',a.provider_account,'provider_mode',a.provider_mode,
    'attempt_id',a.operation_id,'payment_id',a.payment_id,'merchant_id',a.merchant_id,'currency',a.currency,'outbox_id',a.outbox_id,'command_key',a.command_key,
    'command_hash',encode(sha256(convert_to(a.command_payload::text,'UTF8')),'hex'),'accounting_policy',a.accounting_policy,'acceptance_epoch',a.acceptance_epoch,
    'source',checked,'authorization',NULL,'payment_intent_id',e.payment_intent_id,'charge_id',e.charge_id,'capture_principal',NULL,
    'authorized_principal',a.amount,'zero_received_baseline',0,'authorized_capacity',a.amount,'final_capture',NULL,
    'event_id',b->>'id','event_api_version',b->>'api_version','receipt_hash',encode(sha256(r.raw_body),'hex'),'verifier',r.verification_version,'normalization_version',r.normalization_version);
  IF e.facts IS DISTINCT FROM facts OR e.fingerprint IS DISTINCT FROM sha256(convert_to(facts::text,'UTF8')) THEN
    RAISE EXCEPTION 'Original authorization interpretation mismatch'; END IF;
  RETURN e;
END $$;

CREATE FUNCTION public.check_manual_authorization(p_manifest uuid,p_final boolean,p_historical boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; r public.financial_application_roots%ROWTYPE;
  e public.payment_operation_evidence%ROWTYPE; a public.provider_command_authorities%ROWTYPE;
  app public.financial_applications%ROWTYPE; src jsonb; bp jsonb; ba jsonb; bw jsonb; ap jsonb; aa jsonb; aw jsonb; audit jsonb;
  stamp timestamptz; x jsonb; actual jsonb; rev public.financial_application_revision_effects%ROWTYPE;
BEGIN
  SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=p_manifest;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  SELECT * INTO STRICT app FROM public.financial_applications WHERE root_id=r.id AND manifest_id=m.id;
  IF NOT p_historical AND (public.current_financial_application_manifest()).id IS DISTINCT FROM m.id THEN
    RAISE EXCEPTION 'Current protected authorization transaction required'; END IF;
  e:=public.manual_authorization_original_proof(m.payment_operation_proof_id);
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=e.outbox_id;
  src:=m.source_manifest; bp:=src->'payment_before'; ba:=src->'attempt_before'; bw:=src->'inbox_before';
  stamp:=(src->>'applied_at')::timestamptz;
  IF (m.proof_kind,m.proof_revision,m.proof_operation,m.contract_version,m.result,m.inbox_id,m.payment_id,m.merchant_id,m.currency,m.policy,m.epoch)
      IS DISTINCT FROM ('PAYMENT_OPERATION_V1',1,'payment.authorized',1,'VERIFIED_NO_EFFECT',e.inbox_id,e.payment_id,e.merchant_id,e.currency,'LEGACY',0::bigint)
    OR (r.family,r.phase,r.operation_id,r.attempt_id,r.payment_id,r.merchant_id,r.currency,r.provider,r.provider_account,r.accepted_outbox_id,r.policy,r.acceptance_epoch)
      IS DISTINCT FROM ('AUTHORIZE','TERMINAL',e.attempt_id,e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.outbox_id,'LEGACY',0::bigint)
    OR r.refund_id IS NOT NULL OR r.dispute_id IS NOT NULL OR r.settlement_id IS NOT NULL OR r.payout_id IS NOT NULL
    OR src->>'reason' IS DISTINCT FROM 'AUTHORIZE_SUCCESS' OR src->'proof' IS DISTINCT FROM to_jsonb(e)
    OR src->'command' IS DISTINCT FROM to_jsonb(a) OR src->'root' IS DISTINCT FROM to_jsonb(r)
    OR stamp IS NULL OR m.created_at IS DISTINCT FROM stamp OR app.created_at IS DISTINCT FROM stamp
    OR app.result IS DISTINCT FROM m.result OR app.audit_id IS DISTINCT FROM (src->>'audit_id')::uuid
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='AUTHORIZE' AND phase='TERMINAL' AND policy='LEGACY'
      AND version=1 AND prepare_function='public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_manual_authorization(uuid)'::regprocedure)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=e.merchant_id AND currency=e.currency
      AND (provider,provider_account,policy,epoch,admission_mode)=(e.provider,e.provider_account,'LEGACY',0,'DORMANT')) THEN
    RAISE EXCEPTION 'Exact complete MANUAL authorization contract required'; END IF;
  IF bp IS NULL OR ba IS NULL OR bw IS NULL
    OR (bp->>'id',bp->>'merchant_id',bp->>'currency',bp->>'status',bp->>'capture_method')
      IS DISTINCT FROM (e.payment_id::text,e.merchant_id::text,e.currency,'REQUIRES_AUTHORIZATION','MANUAL')
    OR (bp->>'amount')::bigint IS DISTINCT FROM e.authorized_principal
    OR (bp->>'authorized_amount')::bigint IS DISTINCT FROM 0::bigint OR (bp->>'captured_amount')::bigint IS DISTINCT FROM 0::bigint
    OR (bp->>'platform_fee_amount')::bigint IS DISTINCT FROM 0::bigint OR (bp->>'refunded_amount')::bigint IS DISTINCT FROM 0::bigint
    OR bp->'authorized_at' IS DISTINCT FROM 'null'::jsonb OR bp->'captured_at' IS DISTINCT FROM 'null'::jsonb
    OR (ba->>'id',ba->>'payment_id',ba->>'merchant_id',ba->>'currency',ba->>'kind',ba->>'status')
      IS DISTINCT FROM (e.attempt_id::text,e.payment_id::text,e.merchant_id::text,e.currency,'AUTHORIZE','PENDING')
    OR (ba->>'amount')::bigint IS DISTINCT FROM e.authorized_principal OR ba->>'failure_code' IS NOT NULL
    OR (ba->>'provider_transaction_id' IS NOT NULL AND ba->>'provider_transaction_id' IS DISTINCT FROM e.payment_intent_id)
    OR (bw->>'id',bw->>'status',(bw->>'attempts')::integer) IS DISTINCT FROM (e.inbox_id::text,'PROCESSING',m.claim_generation)
    OR src#>>'{obligation,inbox_id}' IS DISTINCT FROM e.inbox_id::text
    OR src#>>'{obligation,payment_operation_proof_id}' IS DISTINCT FROM e.id::text
    OR src#>>'{obligation,disposition}' IS DISTINCT FROM 'AWAITING_APPLICATION'
    OR (src#>>'{obligation,obligation_revision}')::bigint IS NULL THEN
    RAISE EXCEPTION 'Frozen original workflow/claim/binding mismatch'; END IF;
  ap:=bp||jsonb_build_object('status','AUTHORIZED','authorized_amount',e.authorized_principal,'authorized_at',stamp,'updated_at',stamp,'version',(bp->>'version')::integer+1);
  aa:=ba||jsonb_build_object('status','SUCCEEDED','provider_transaction_id',e.payment_intent_id,'updated_at',stamp);
  aw:=bw||jsonb_build_object('status','PROCESSED','processed_at',stamp,'locked_at',NULL,'updated_at',stamp);
  audit:=jsonb_build_object('id',app.audit_id,'merchant_id',e.merchant_id,'actor_type','PROVIDER','actor_id',e.payment_intent_id,
    'action','payment.authorized','target_type','payment','target_id',e.payment_id::text,'correlation_id',NULL,
    'metadata',jsonb_build_object('attemptId',e.attempt_id,'outboxId',e.outbox_id,'proofId',e.id,'rootId',r.id,'amount',e.authorized_principal,'currency',e.currency),'created_at',stamp);
  IF m.effect_manifest IS DISTINCT FROM jsonb_build_array(
    jsonb_build_object('table','payments','id',e.payment_id,'write','UPDATE','before',bp,'after',ap),
    jsonb_build_object('table','payment_attempts','id',e.attempt_id,'write','UPDATE','before',ba,'after',aa),
    jsonb_build_object('table','audit_logs','id',app.audit_id,'write','INSERT','after',audit),
    jsonb_build_object('table','webhook_events','id',e.inbox_id,'write','UPDATE','before',bw,'after',aw)) THEN
    RAISE EXCEPTION 'Missing whole group or altered authorization plan'; END IF;
  IF p_historical THEN
    IF NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=e.payment_id AND p.merchant_id=e.merchant_id AND p.currency=e.currency
      AND p.amount=e.authorized_principal AND p.capture_method='MANUAL' AND p.authorized_amount=e.authorized_principal AND p.authorized_at=stamp
      AND p.version>=(ap->>'version')::integer AND p.status NOT IN ('CREATED','REQUIRES_AUTHORIZATION','FAILED'))
      OR NOT EXISTS(SELECT 1 FROM public.payment_attempts t WHERE t.id=e.attempt_id AND t.kind='AUTHORIZE' AND t.status='SUCCEEDED'
        AND (t.payment_id,t.merchant_id,t.currency,t.amount,t.provider_transaction_id)=(e.payment_id,e.merchant_id,e.currency,e.authorized_principal,e.payment_intent_id)
        AND t.failure_code IS NULL) THEN
      RAISE EXCEPTION 'Historical authorization owner or monotone success mismatch'; END IF;
  END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(m.effect_manifest) LOOP
    IF p_historical AND x->>'table' IN ('payments','payment_attempts') THEN CONTINUE; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',x->>'table') INTO actual USING (x->>'id')::uuid;
    IF actual IS DISTINCT FROM x->'after' THEN RAISE EXCEPTION 'Authorization effect group is incomplete'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.audit_logs log WHERE log.action='payment.authorized'
    AND EXISTS(SELECT 1 FROM public.manual_authorization_record_owners('audit_logs',
      jsonb_build_object('target_id',log.target_id,'metadata',log.metadata)) owners WHERE owners.payment_id=e.payment_id))<>1 THEN
    RAISE EXCEPTION 'Exactly one owned terminal authorization audit required'; END IF;
  IF (SELECT count(*) FROM public.financial_application_dispositions WHERE root_id=r.id)<>2
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_dispositions WHERE root_id=r.id AND inbox_id=e.inbox_id
      AND id=(src->>'receipt_disposition_id')::uuid AND obligation_revision=(src#>>'{obligation,obligation_revision}')::bigint AND disposition='VERIFIED_NO_EFFECT' AND created_at=stamp)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_dispositions WHERE root_id=r.id AND id=(src->>'source_disposition_id')::uuid
      AND observation_source_id=e.source_id AND disposition='VERIFIED_NO_EFFECT' AND created_at=stamp)
    OR EXISTS(SELECT 1 FROM public.financial_application_effect_links WHERE root_id=r.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE business_id=e.attempt_id)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_permits WHERE manifest_id=m.id AND transaction_id=m.transaction_id AND backend_pid=m.backend_pid
      AND database_principal::text=src->>'database_principal')
    OR NOT EXISTS(SELECT 1 FROM public.manual_authorization_issuances i WHERE i.root_id=r.id AND i.manifest_id=m.id
      AND i.transaction_id=m.transaction_id AND i.backend_pid=m.backend_pid AND i.database_principal::text=src->>'database_principal'
      AND i.root_image=to_jsonb(r) AND i.manifest_image=to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'])
    OR NOT EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c WHERE c.inbox_id=m.inbox_id AND c.operation='CLAIM'
      AND c.after_image=bw AND c.database_principal::text=src->>'database_principal') THEN RAISE EXCEPTION 'Authorization source/permit/claim/no-effect completeness mismatch'; END IF;
  IF NOT p_historical AND (EXISTS(SELECT 1 FROM public.payment_attempts WHERE payment_id=e.payment_id AND id<>e.attempt_id)
    OR EXISTS(SELECT 1 FROM public.capture_accounting_lots WHERE payment_id=e.payment_id)
    OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=e.payment_id)
    OR EXISTS(SELECT 1 FROM public.disputes WHERE payment_id=e.payment_id)
    OR EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE payment_id=e.payment_id AND outbox_id<>e.outbox_id)
    OR EXISTS(SELECT 1 FROM public.financial_application_roots WHERE payment_id=e.payment_id AND id<>r.id)) THEN
    RAISE EXCEPTION 'MANUAL authorization cannot create another operation or money effect'; END IF;
  IF NOT p_historical AND NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations o WHERE o.inbox_id=m.inbox_id AND to_jsonb(o)=src->'obligation') THEN
    RAISE EXCEPTION 'Exact current authorization obligation required'; END IF;
  SELECT * INTO rev FROM public.financial_application_revision_effects WHERE manifest_id=m.id;
  IF p_final AND (NOT FOUND OR (rev.root_id,rev.prior_revision,rev.final_revision) IS DISTINCT FROM (r.id,m.scope_revision,m.scope_revision+1)
    OR NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency
      AND CASE WHEN p_historical THEN s.evidence_revision>=rev.final_revision ELSE s.evidence_revision=rev.final_revision END)) THEN
    RAISE EXCEPTION 'Final authorization requires exact guarded revision effect'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.guard_manual_authorization_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE;
  issuance public.manual_authorization_issuances%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='financial_application_roots' THEN r:=NEW;
  ELSIF TG_TABLE_NAME='financial_application_manifests' THEN
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=NEW.root_id;
  ELSIF TG_TABLE_NAME='financial_application_permits' THEN
    SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=NEW.manifest_id;
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  ELSE
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=NEW.root_id;
  END IF;
  IF r.family NOT IN ('AUTHORIZE','CAPTURE','VOID') OR NOT public.manual_authorization_scope_protected(r.merchant_id,r.currency) THEN RETURN NEW; END IF;
  IF r.family<>'AUTHORIZE' THEN RAISE EXCEPTION 'Enrolled CAPTURE/VOID application authority is not installed'; END IF;
  SELECT * INTO issuance FROM public.manual_authorization_issuances WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND database_principal=session_user AND root_id=r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact server-issued authorization root required'; END IF;
  IF issuance.root_image IS DISTINCT FROM to_jsonb(r) THEN RAISE EXCEPTION 'Exact server-issued authorization root required'; END IF;
  IF TG_TABLE_NAME='financial_application_revision_effects' THEN
    m:=public.current_financial_application_manifest();
    IF issuance.manifest_id IS DISTINCT FROM m.id OR (NEW.manifest_id,NEW.root_id,NEW.prior_revision,NEW.final_revision)
      IS DISTINCT FROM (m.id,m.root_id,m.scope_revision,m.scope_revision+1) THEN RAISE EXCEPTION 'Exact guarded AUTH revision writer required'; END IF;
  ELSE
    IF TG_TABLE_NAME='financial_application_manifests' THEN
      IF to_jsonb(NEW)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM issuance.manifest_image
        OR NEW.proof_kind<>'PAYMENT_OPERATION_V1' OR NEW.proof_operation<>'payment.authorized'
        OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
        OR NEW.source_manifest->>'database_principal' IS DISTINCT FROM session_user::text THEN RAISE EXCEPTION 'Exact SQL AUTH manifest required'; END IF;
    ELSIF TG_TABLE_NAME='financial_application_permits' THEN
      IF NEW.manifest_id IS DISTINCT FROM issuance.manifest_id OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id()
        OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid() OR NEW.database_principal IS DISTINCT FROM session_user
        OR (m.transaction_id,m.backend_pid) IS DISTINCT FROM (NEW.transaction_id,NEW.backend_pid)
        OR to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM issuance.manifest_image
        OR m.proof_kind<>'PAYMENT_OPERATION_V1' THEN RAISE EXCEPTION 'Exact SQL AUTH transaction permit required'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_authorization_issuer BEFORE INSERT ON public.financial_application_roots FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_authority();
CREATE TRIGGER manual_authorization_issuer BEFORE INSERT ON public.financial_application_manifests FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_authority();
CREATE TRIGGER manual_authorization_issuer BEFORE INSERT ON public.financial_application_permits FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_authority();
CREATE TRIGGER manual_authorization_issuer BEFORE INSERT ON public.financial_application_revision_effects FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_authority();

-- Prospective P issuance has closure even if the entire application or effect
-- group is missing. Old REFUND and unenrolled P-A storage probes stay inert.
CREATE FUNCTION public.check_manual_authorization_finality() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE; actual jsonb; protected boolean;
BEGIN
  IF TG_TABLE_NAME='financial_application_roots' THEN
    SELECT * INTO r FROM public.financial_application_roots WHERE id=NEW.id;
  ELSIF TG_TABLE_NAME='financial_application_manifests' THEN
    SELECT * INTO r FROM public.financial_application_roots WHERE id=NEW.root_id;
  ELSIF TG_TABLE_NAME='manual_authorization_issuances' THEN
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=NEW.root_id;
  ELSIF TG_TABLE_NAME IN ('financial_application_permits','financial_application_revision_effects') THEN
    SELECT v.* INTO STRICT m FROM public.financial_application_manifests v WHERE v.id=NEW.manifest_id;
    SELECT * INTO r FROM public.financial_application_roots WHERE id=m.root_id;
  ELSE
    -- Claims/failure bookkeeping are separate transactions and never finality.
    IF TG_TABLE_NAME='webhook_events' AND to_jsonb(NEW)->>'status'<>'PROCESSED' THEN RETURN NULL; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',TG_TABLE_NAME) INTO actual USING NEW.id;
    SELECT EXISTS(SELECT 1 FROM (VALUES(to_jsonb(NEW)),(actual)) v(body)
      CROSS JOIN LATERAL public.manual_authorization_record_owners(TG_TABLE_NAME,v.body) owners
      JOIN public.financial_application_scope_authority s ON s.merchant_id=owners.merchant_id AND (owners.currency IS NULL OR s.currency=owners.currency)
      WHERE public.manual_authorization_scope_protected(s.merchant_id,s.currency)) INTO protected;
    IF NOT protected OR (TG_TABLE_NAME='audit_logs' AND to_jsonb(NEW)->>'action'<>'payment.authorized') THEN RETURN NULL; END IF;
    m:=public.current_financial_application_manifest();
    SELECT * INTO r FROM public.financial_application_roots WHERE id=m.root_id;
  END IF;
  IF r.family='AUTHORIZE' AND public.manual_authorization_scope_protected(r.merchant_id,r.currency) THEN
    SELECT v.* INTO STRICT m FROM public.financial_application_manifests v JOIN public.financial_applications a ON a.manifest_id=v.id WHERE a.root_id=r.id;
    PERFORM public.validate_manual_authorization(m.id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.financial_application_roots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.financial_application_manifests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.financial_application_permits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.financial_application_revision_effects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.manual_authorization_issuances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER INSERT ON public.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();
CREATE CONSTRAINT TRIGGER manual_authorization_complete AFTER UPDATE ON public.webhook_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_finality();

CREATE FUNCTION public.validate_manual_authorization(p_manifest uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$ SELECT public.check_manual_authorization(p_manifest,true,false) $$;

CREATE FUNCTION public.manual_authorization_history(p_root uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m uuid;
BEGIN
  SELECT v.id INTO STRICT m FROM public.financial_applications a JOIN public.financial_application_manifests v ON v.id=a.manifest_id
    JOIN public.financial_application_roots r ON r.id=a.root_id WHERE a.root_id=p_root AND r.family='AUTHORIZE' AND v.proof_kind='PAYMENT_OPERATION_V1';
  RETURN public.check_manual_authorization(m,true,true);
EXCEPTION WHEN no_data_found OR raise_exception OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE FUNCTION public.recognize_manual_authorization(p_outbox uuid,p_inbox uuid,p_proof uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original public.financial_application_roots%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Authorization recognition requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT r.* INTO STRICT original FROM public.financial_application_roots r JOIN public.financial_applications a ON a.root_id=r.id
    JOIN public.financial_application_manifests m ON m.id=a.manifest_id
    WHERE r.accepted_outbox_id=p_outbox AND m.inbox_id=p_inbox AND m.payment_operation_proof_id=p_proof
      AND r.family='AUTHORIZE' AND m.proof_kind='PAYMENT_OPERATION_V1';
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=original.provider AND provider_account=original.provider_account FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured authorization account required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(original.merchant_id::text||':'||original.currency,0));
  PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=original.merchant_id AND currency=original.currency FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned authorization scope required'; END IF;
  PERFORM 1 FROM public.payments WHERE id=original.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=original.payment_id ORDER BY id FOR UPDATE;
  IF NOT public.manual_authorization_history(original.id) THEN RAISE EXCEPTION 'Original complete MANUAL authorization required'; END IF;
  RETURN original.id;
END $$;

-- Only a complete original AUTH application discharges these two exact causes.
-- REFUND projections and every other raw classification retain their old meaning.
CREATE FUNCTION public.manual_authorization_cause_cleared(p_inbox uuid,p_revision bigint,p_source uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d record;
BEGIN
  IF num_nonnulls(p_inbox,p_source)<>1 OR (p_inbox IS NOT NULL AND p_revision IS NULL) THEN RETURN false; END IF;
  FOR d IN SELECT x.root_id,m.inbox_id,m.source_manifest,e.source_id FROM public.financial_application_dispositions x
    JOIN public.financial_applications a ON a.root_id=x.root_id JOIN public.financial_application_manifests m ON m.id=a.manifest_id
    JOIN public.payment_operation_evidence e ON e.id=m.payment_operation_proof_id
    WHERE m.proof_kind='PAYMENT_OPERATION_V1' AND x.disposition='VERIFIED_NO_EFFECT'
      AND ((p_inbox IS NOT NULL AND x.inbox_id=p_inbox AND x.obligation_revision=p_revision AND m.inbox_id=p_inbox
        AND (m.source_manifest#>>'{obligation,obligation_revision}')::bigint=p_revision)
        OR (p_source IS NOT NULL AND x.observation_source_id=p_source AND e.source_id=p_source)) LOOP
    IF public.manual_authorization_history(d.root_id) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION public.manual_authorization_blocked(p_provider text,p_account text,p_merchant uuid,p_currency text,
  p_own_inbox uuid DEFAULT NULL,p_own_revision bigint DEFAULT NULL,p_own_source uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.receipt_admission_obligations o WHERE
    ((o.provider=p_provider AND o.provider_account=p_account AND o.merchant_id IS NULL AND o.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
      OR (o.merchant_id=p_merchant AND o.currency=p_currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
    AND NOT (o.inbox_id IS NOT DISTINCT FROM p_own_inbox AND o.obligation_revision IS NOT DISTINCT FROM p_own_revision AND o.disposition='AWAITING_APPLICATION')
    AND NOT (o.disposition='AWAITING_APPLICATION' AND public.manual_authorization_cause_cleared(o.inbox_id,o.obligation_revision,NULL)))
  OR EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE
    ((o.provider=p_provider AND o.provider_account=p_account AND o.merchant_id IS NULL AND o.disposition='BLOCKING_REVIEW')
      OR (o.merchant_id=p_merchant AND o.currency=p_currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
    AND NOT (o.source_id IS NOT DISTINCT FROM p_own_source AND o.disposition='AWAITING_APPLICATION')
    AND NOT (o.disposition='AWAITING_APPLICATION' AND public.manual_authorization_cause_cleared(NULL,NULL,o.source_id)))
  OR EXISTS(SELECT 1 FROM public.provider_observation_sources s JOIN public.provider_command_authorities a ON a.outbox_id=s.outbox_id
    WHERE a.provider=p_provider AND a.provider_account=p_account AND a.merchant_id=p_merchant AND a.currency=p_currency
      AND NOT EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE o.source_id=s.id))
  OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers b WHERE (b.provider=p_provider AND b.provider_account=p_account AND b.merchant_id IS NULL)
    OR (b.merchant_id=p_merchant AND b.currency=p_currency))
  OR EXISTS(SELECT 1 FROM public.accounting_exceptions WHERE merchant_id=p_merchant AND currency=p_currency AND status='OPEN')
$$;

CREATE OR REPLACE FUNCTION public.inspect_receipt_admission(p_provider text,p_account text,p_merchant uuid,p_currency text,
  p_scope_revision bigint DEFAULT NULL,p_intake_revision bigint DEFAULT NULL) RETURNS TABLE(scope_revision bigint,intake_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Receipt admission inspection requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=p_provider AND provider_account=p_account FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured account required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_merchant::text||':'||p_currency,0));
  SELECT s.evidence_revision INTO scope_revision FROM public.capture_accounting_scopes s WHERE s.merchant_id=p_merchant AND s.currency=p_currency FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned scope required'; END IF;
  SELECT coalesce((SELECT a.evidence_revision FROM public.receipt_intake_authority a WHERE a.provider=p_provider AND a.provider_account=p_account),0) INTO intake_revision;
  IF (p_scope_revision IS NOT NULL AND p_scope_revision<>scope_revision) OR (p_intake_revision IS NOT NULL AND p_intake_revision<>intake_revision) THEN RAISE EXCEPTION 'Stale receipt clearance revision'; END IF;
  IF public.manual_authorization_blocked(p_provider,p_account,p_merchant,p_currency) THEN
    RAISE EXCEPTION 'Receipt admission blocked by unresolved evidence or exception'; END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION public.prepare_manual_authorization(p_outbox uuid,p_inbox uuid,p_proof uuid,p_generation integer,
  p_obligation bigint,p_scope bigint,p_intake bigint) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.provider_command_authorities%ROWTYPE; e public.payment_operation_evidence%ROWTYPE;
  w public.webhook_events%ROWTYPE; p public.payments%ROWTYPE; t public.payment_attempts%ROWTYPE;
  o public.receipt_admission_obligations%ROWTYPE; r public.financial_application_roots%ROWTYPE;
  planned public.financial_application_manifests%ROWTYPE;
  scope_rev bigint; intake_rev bigint; stamp timestamptz:=clock_timestamp(); manifest uuid:=gen_random_uuid(); audit uuid:=gen_random_uuid();
  bp jsonb; ba jsonb; bw jsonb; ap jsonb; aa jsonb; aw jsonb; audit_row jsonb; sources jsonb; effects jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MANUAL authorization requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF w.status<>'PROCESSING' OR w.attempts IS DISTINCT FROM p_generation OR p_generation<1 THEN RAISE EXCEPTION 'Current private inbox claim required'; END IF;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=p_outbox AND operation='AUTHORIZE';
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=a.provider AND provider_account=a.provider_account AND provider_mode='TEST' FOR SHARE;
  IF NOT FOUND OR a.provider_mode IS DISTINCT FROM 'TEST' THEN RAISE EXCEPTION 'Configured TEST account required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(a.merchant_id::text||':'||a.currency,0));
  SELECT evidence_revision INTO STRICT scope_rev FROM public.capture_accounting_scopes WHERE merchant_id=a.merchant_id AND currency=a.currency FOR NO KEY UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=a.merchant_id AND currency=a.currency
    AND (provider,provider_account,policy,epoch,admission_mode)=(a.provider,a.provider_account,'LEGACY',0,'DORMANT')) THEN RAISE EXCEPTION 'Private DORMANT LEGACY authority required'; END IF;
  SELECT coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=a.provider AND provider_account=a.provider_account),0) INTO intake_rev;
  IF (scope_rev,intake_rev) IS DISTINCT FROM (p_scope,p_intake) THEN RAISE EXCEPTION 'Stale authorization evidence revisions'; END IF;
  PERFORM 1 FROM public.payments WHERE id=a.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=a.payment_id ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT p FROM public.payments WHERE id=a.payment_id;
  SELECT * INTO STRICT t FROM public.payment_attempts WHERE id=a.operation_id;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='AUTHORIZE' AND phase='TERMINAL' AND policy='LEGACY'
    AND version=1 AND prepare_function='public.prepare_manual_authorization(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure
    AND validate_function='public.validate_manual_authorization(uuid)'::regprocedure) THEN RAISE EXCEPTION 'Exact MANUAL authorization contract is not installed'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_application_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()) THEN
    RAISE EXCEPTION 'One protected application per transaction'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_application_roots WHERE family='AUTHORIZE' AND operation_id=a.operation_id AND phase='TERMINAL' AND currency=a.currency) THEN
    RAISE EXCEPTION 'Existing authorization root requires original-result recognition'; END IF;
  e:=public.load_effective_payment_operation_evidence(p_inbox,1,'payment.authorized');
  IF e.id IS DISTINCT FROM p_proof OR e.outbox_id IS DISTINCT FROM p_outbox THEN RAISE EXCEPTION 'Exact selected AUTH proof required'; END IF;
  e:=public.manual_authorization_original_proof(e.id);
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF (o.obligation_revision,o.disposition,o.payment_operation_proof_id,o.payment_id,o.merchant_id,o.currency,o.provider,o.provider_account,o.operation)
      IS DISTINCT FROM (p_obligation,'AWAITING_APPLICATION',e.id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,'payment.authorized')
    OR o.proof_revision IS NOT NULL OR o.review_id IS NOT NULL OR o.scope_evidence_revision>scope_rev OR o.intake_evidence_revision>intake_rev
    OR NOT EXISTS(SELECT 1 FROM public.provider_observation_obligations WHERE source_id=e.source_id AND disposition='AWAITING_APPLICATION'
      AND (provider,provider_account,merchant_id,currency)=(e.provider,e.provider_account,e.merchant_id,e.currency)) THEN
    RAISE EXCEPTION 'Exact owned bound AUTH sources required'; END IF;
  IF p.capture_method<>'MANUAL' OR p.status<>'REQUIRES_AUTHORIZATION' OR p.amount<>e.authorized_principal
    OR p.authorized_amount<>0 OR p.captured_amount<>0 OR p.platform_fee_amount<>0 OR p.refunded_amount<>0 OR p.authorized_at IS NOT NULL OR p.captured_at IS NOT NULL
    OR (p.merchant_id,p.currency) IS DISTINCT FROM (e.merchant_id,e.currency)
    OR (t.kind,t.status,t.payment_id,t.merchant_id,t.currency,t.amount) IS DISTINCT FROM ('AUTHORIZE','PENDING',p.id,p.merchant_id,p.currency,p.amount)
    OR t.failure_code IS NOT NULL OR (t.provider_transaction_id IS NOT NULL AND t.provider_transaction_id IS DISTINCT FROM e.payment_intent_id)
    OR (SELECT count(*) FROM public.payment_attempts WHERE payment_id=p.id)<>1
    OR EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE payment_id=p.id AND outbox_id<>p_outbox)
    OR EXISTS(SELECT 1 FROM public.financial_application_roots WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.capture_accounting_lots WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=p.id) OR EXISTS(SELECT 1 FROM public.disputes WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions j JOIN public.payment_attempts x ON x.id=j.business_id WHERE x.payment_id=p.id) THEN
    RAISE EXCEPTION 'Unrecognized MANUAL authorization with no other operation/effect required'; END IF;
  IF EXISTS(SELECT 1 FROM public.audit_logs log WHERE log.action='payment.authorized'
    AND EXISTS(SELECT 1 FROM public.manual_authorization_record_owners('audit_logs',
      jsonb_build_object('target_id',log.target_id,'metadata',log.metadata)) owners WHERE owners.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Unrecognized prior authorization audit history'; END IF;
  IF public.manual_authorization_blocked(a.provider,a.provider_account,a.merchant_id,a.currency,p_inbox,p_obligation,e.source_id) THEN
    RAISE EXCEPTION 'Authorization blocked by unrelated or unresolved source'; END IF;
  r.id:=gen_random_uuid(); r.family:='AUTHORIZE'; r.operation_id:=a.operation_id; r.phase:='TERMINAL';
  r.merchant_id:=a.merchant_id; r.currency:=a.currency; r.provider:=a.provider; r.provider_account:=a.provider_account;
  r.policy:='LEGACY'; r.acceptance_epoch:=0; r.accepted_outbox_id:=a.outbox_id; r.payment_id:=a.payment_id; r.attempt_id:=a.operation_id; r.created_at:=stamp;
  bp:=to_jsonb(p); ba:=to_jsonb(t); bw:=to_jsonb(w);
  ap:=bp||jsonb_build_object('status','AUTHORIZED','authorized_amount',e.authorized_principal,'authorized_at',stamp,'updated_at',stamp,'version',p.version+1);
  aa:=ba||jsonb_build_object('status','SUCCEEDED','provider_transaction_id',e.payment_intent_id,'updated_at',stamp);
  aw:=bw||jsonb_build_object('status','PROCESSED','processed_at',stamp,'locked_at',NULL,'updated_at',stamp);
  audit_row:=jsonb_build_object('id',audit,'merchant_id',p.merchant_id,'actor_type','PROVIDER','actor_id',e.payment_intent_id,'action','payment.authorized',
    'target_type','payment','target_id',p.id::text,'correlation_id',NULL,
    'metadata',jsonb_build_object('attemptId',t.id,'outboxId',a.outbox_id,'proofId',e.id,'rootId',r.id,'amount',p.amount,'currency',p.currency),'created_at',stamp);
  sources:=jsonb_build_object('reason','AUTHORIZE_SUCCESS','audit_id',audit,'applied_at',stamp,'database_principal',session_user,
    'receipt_disposition_id',gen_random_uuid(),'source_disposition_id',gen_random_uuid(),
    'proof',to_jsonb(e),'command',to_jsonb(a),'root',to_jsonb(r),'obligation',to_jsonb(o),'payment_before',bp,'attempt_before',ba,'inbox_before',bw);
  effects:=jsonb_build_array(jsonb_build_object('table','payments','id',p.id,'write','UPDATE','before',bp,'after',ap),
    jsonb_build_object('table','payment_attempts','id',t.id,'write','UPDATE','before',ba,'after',aa),
    jsonb_build_object('table','audit_logs','id',audit,'write','INSERT','after',audit_row),
    jsonb_build_object('table','webhook_events','id',p_inbox,'write','UPDATE','before',bw,'after',aw));
  planned:=jsonb_populate_record(NULL::public.financial_application_manifests,jsonb_build_object(
    'id',manifest,'root_id',r.id,'transaction_id',pg_current_xact_id(),'backend_pid',pg_backend_pid(),'inbox_id',p_inbox,
    'proof_revision',1,'proof_operation','payment.authorized','claim_generation',p_generation,'merchant_id',p.merchant_id,'currency',p.currency,
    'payment_id',p.id,'policy','LEGACY','epoch',0,'scope_revision',scope_rev,'intake_revision',intake_rev,'contract_version',1,
    'result','VERIFIED_NO_EFFECT','source_manifest',sources,'effect_manifest',effects,'created_at',stamp,'proof_kind','PAYMENT_OPERATION_V1','payment_operation_proof_id',e.id));
  INSERT INTO public.manual_authorization_issuances(transaction_id,backend_pid,database_principal,root_id,manifest_id,root_image,manifest_image)
    VALUES(pg_current_xact_id(),pg_backend_pid(),session_user,r.id,manifest,to_jsonb(r),to_jsonb(planned)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id']);
  INSERT INTO public.financial_application_roots(id,family,operation_id,phase,merchant_id,currency,provider,provider_account,policy,acceptance_epoch,accepted_outbox_id,payment_id,attempt_id,created_at)
    VALUES(r.id,r.family,r.operation_id,r.phase,r.merchant_id,r.currency,r.provider,r.provider_account,r.policy,r.acceptance_epoch,r.accepted_outbox_id,r.payment_id,r.attempt_id,r.created_at);
  INSERT INTO public.financial_application_manifests(id,root_id,transaction_id,backend_pid,inbox_id,proof_revision,proof_operation,claim_generation,
    merchant_id,currency,payment_id,policy,epoch,scope_revision,intake_revision,contract_version,result,source_manifest,effect_manifest,created_at,proof_kind,payment_operation_proof_id)
    VALUES(manifest,r.id,pg_current_xact_id(),pg_backend_pid(),p_inbox,1,'payment.authorized',p_generation,p.merchant_id,p.currency,p.id,
      'LEGACY',0,scope_rev,intake_rev,1,'VERIFIED_NO_EFFECT',sources,effects,stamp,'PAYMENT_OPERATION_V1',e.id);
  INSERT INTO public.financial_application_permits(transaction_id,backend_pid,manifest_id) VALUES(pg_current_xact_id(),pg_backend_pid(),manifest);
  RETURN manifest;
END $$;

CREATE FUNCTION public.apply_manual_authorization() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; e public.payment_operation_evidence%ROWTYPE;
  stamp timestamptz; audit public.audit_logs%ROWTYPE;
BEGIN
  m:=public.current_financial_application_manifest();
  IF m.proof_kind<>'PAYMENT_OPERATION_V1' OR m.proof_operation<>'payment.authorized' OR m.source_manifest->>'reason' IS DISTINCT FROM 'AUTHORIZE_SUCCESS' THEN
    RAISE EXCEPTION 'Current MANUAL authorization plan required'; END IF;
  e:=public.manual_authorization_original_proof(m.payment_operation_proof_id); stamp:=(m.source_manifest->>'applied_at')::timestamptz;
  IF public.manual_authorization_blocked(e.provider,e.provider_account,e.merchant_id,e.currency,m.inbox_id,(m.source_manifest#>>'{obligation,obligation_revision}')::bigint,e.source_id) THEN
    RAISE EXCEPTION 'Authorization evidence became blocked'; END IF;
  UPDATE public.payment_attempts SET status='SUCCEEDED',provider_transaction_id=e.payment_intent_id,updated_at=stamp WHERE id=e.attempt_id;
  UPDATE public.payments SET status='AUTHORIZED',authorized_amount=e.authorized_principal,authorized_at=stamp,updated_at=stamp,version=version+1 WHERE id=e.payment_id;
  SELECT * INTO STRICT audit FROM jsonb_populate_record(NULL::public.audit_logs,m.effect_manifest#>'{2,after}');
  INSERT INTO public.audit_logs SELECT audit.*;
  UPDATE public.webhook_events SET status='PROCESSED',processed_at=stamp,locked_at=NULL,updated_at=stamp
    WHERE id=m.inbox_id AND status='PROCESSING' AND attempts=m.claim_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorization claim finality compare-and-set failed'; END IF;
  INSERT INTO public.financial_applications(root_id,manifest_id,result,audit_id,created_at)
    VALUES(m.root_id,m.id,'VERIFIED_NO_EFFECT',audit.id,stamp);
  INSERT INTO public.financial_application_dispositions(id,root_id,inbox_id,obligation_revision,disposition,created_at)
    VALUES((m.source_manifest->>'receipt_disposition_id')::uuid,m.root_id,m.inbox_id,(m.source_manifest#>>'{obligation,obligation_revision}')::bigint,'VERIFIED_NO_EFFECT',stamp);
  INSERT INTO public.financial_application_dispositions(id,root_id,observation_source_id,disposition,created_at)
    VALUES((m.source_manifest->>'source_disposition_id')::uuid,m.root_id,e.source_id,'VERIFIED_NO_EFFECT',stamp);
  PERFORM public.advance_financial_application_revision();
  RETURN m.root_id;
END $$;

CREATE OR REPLACE FUNCTION public.guard_financial_application_records() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE;
BEGIN
  m:=public.current_financial_application_manifest();
  IF NEW.root_id IS DISTINCT FROM m.root_id THEN RAISE EXCEPTION 'Application root does not match transaction permit'; END IF;
  IF m.proof_kind='PAYMENT_OPERATION_V1' THEN
    IF m.proof_operation IS DISTINCT FROM 'payment.authorized' OR m.result<>'VERIFIED_NO_EFFECT'
      OR m.source_manifest->>'reason' IS DISTINCT FROM 'AUTHORIZE_SUCCESS'
      OR NOT EXISTS(SELECT 1 FROM public.financial_application_roots WHERE id=m.root_id AND family='AUTHORIZE') THEN
      RAISE EXCEPTION 'Only exact MANUAL authorization records are installed'; END IF;
    IF TG_TABLE_NAME='financial_applications' THEN
      IF (NEW.manifest_id,NEW.result,NEW.audit_id,NEW.created_at) IS DISTINCT FROM
        (m.id,m.result,(m.source_manifest->>'audit_id')::uuid,(m.source_manifest->>'applied_at')::timestamptz) THEN RAISE EXCEPTION 'Exact authorization completion record required'; END IF;
    ELSIF TG_TABLE_NAME='financial_application_dispositions' THEN
      IF NEW.disposition<>'VERIFIED_NO_EFFECT' OR NEW.created_at IS DISTINCT FROM (m.source_manifest->>'applied_at')::timestamptz
        OR NEW.delivery_id IS NOT NULL OR NEW.barrier_key IS NOT NULL
        OR NOT ((NEW.id=(m.source_manifest->>'receipt_disposition_id')::uuid AND NEW.inbox_id=m.inbox_id AND NEW.obligation_revision=(m.source_manifest#>>'{obligation,obligation_revision}')::bigint
            AND NEW.observation_source_id IS NULL AND EXISTS(SELECT 1 FROM public.receipt_admission_obligations o
              WHERE o.inbox_id=NEW.inbox_id AND to_jsonb(o)=m.source_manifest->'obligation'))
          OR (NEW.id=(m.source_manifest->>'source_disposition_id')::uuid AND NEW.inbox_id IS NULL AND NEW.obligation_revision IS NULL
            AND NEW.observation_source_id=(m.source_manifest#>>'{proof,source_id}')::uuid
            AND EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE o.source_id=NEW.observation_source_id AND o.disposition='AWAITING_APPLICATION'
              AND o.merchant_id=m.merchant_id AND o.currency=m.currency))) IS TRUE THEN
        RAISE EXCEPTION 'Exact selected AUTH source disposition required'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Original REFUND branch and its proof_revision=1 contract are unchanged.
  IF TG_TABLE_NAME='financial_applications' THEN
    IF NEW.manifest_id IS DISTINCT FROM m.id THEN RAISE EXCEPTION 'Application manifest mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME='financial_application_dispositions' THEN
    IF NEW.disposition IS DISTINCT FROM (CASE WHEN m.result='VERIFIED_NO_EFFECT' THEN 'VERIFIED_NO_EFFECT' ELSE 'APPLIED' END) THEN RAISE EXCEPTION 'Source disposition mismatch'; END IF;
    IF NEW.delivery_id IS NOT NULL THEN RAISE EXCEPTION 'Delivery recovery contract closed'; END IF;
    IF NEW.inbox_id IS NOT NULL AND (NEW.inbox_id IS DISTINCT FROM m.inbox_id
      OR NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations WHERE inbox_id=NEW.inbox_id AND obligation_revision=NEW.obligation_revision
        AND disposition='AWAITING_APPLICATION' AND proof_revision=m.proof_revision)) THEN RAISE EXCEPTION 'Exact original obligation revision required'; END IF;
    IF NEW.observation_source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.webhook_financial_evidence e
      JOIN public.provider_observation_projections l ON l.observation_id=e.refund_observation_id
      JOIN public.provider_observation_sources s ON s.id=l.source_id
      JOIN public.financial_application_roots r ON r.id=m.root_id AND r.accepted_outbox_id=s.outbox_id
      JOIN public.provider_observation_obligations o ON o.source_id=s.id AND o.disposition='AWAITING_APPLICATION'
      WHERE e.inbox_id=m.inbox_id AND e.proof_revision=m.proof_revision AND l.source_id=NEW.observation_source_id
      AND e.refund_id=r.refund_id AND s.normalized_outcome->>'object_id'=e.provider_object_id
      AND s.normalized_outcome->>'reason'=CASE e.operation WHEN 'refund.succeeded' THEN 'CONFIRMED_PROVIDER_RESULT' WHEN 'refund.failed' THEN 'DEFINITIVE_PROVIDER_FAILURE' END) THEN
      RAISE EXCEPTION 'Exact owned D02 applying source required'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Add one narrow dispatch to contract2 finality; preserve all classification,
-- proof-owner, BLOCKING_REVIEW and contract1 code exactly as installed in B1.
DO $$ DECLARE d text; old_line text:='IF o.disposition=''AWAITING_APPLICATION'' THEN PERFORM public.load_effective_payment_operation_evidence(a.inbox_id,1,a.operation); END IF;'; BEGIN
  SELECT pg_get_functiondef('public.check_receipt_admission_obligation()'::regprocedure) INTO d;
  IF length(d)-length(replace(d,old_line,''))<>length(old_line) THEN RAISE EXCEPTION 'Expected exact installed B1 obligation dispatch'; END IF;
  EXECUTE replace(d,old_line,$branch$
    IF o.disposition='AWAITING_APPLICATION' THEN
      IF a.operation='payment.authorized' AND EXISTS(SELECT 1 FROM public.financial_application_manifests m
        JOIN public.financial_applications app ON app.manifest_id=m.id
        WHERE m.proof_kind='PAYMENT_OPERATION_V1' AND m.inbox_id=a.inbox_id AND m.payment_operation_proof_id=pe.id
          AND public.manual_authorization_history(app.root_id)) THEN
        NULL;
      ELSE
        PERFORM public.load_effective_payment_operation_evidence(a.inbox_id,1,a.operation);
      END IF;
    END IF;$branch$);
END $$;

CREATE FUNCTION public.manual_authorization_record_owners(p_relation text,p_row jsonb)
RETURNS TABLE(merchant_id uuid,currency text,payment_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; proof uuid; root uuid;
BEGIN
  IF p_row IS NULL THEN RETURN; END IF;
  IF p_relation='audit_logs' THEN
    -- Resolve the real target even when supplied merchant/type fields lie.
    target:=CASE WHEN pg_input_is_valid(p_row->>'target_id','uuid') THEN (p_row->>'target_id')::uuid END;
    proof:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,proofId}','uuid') THEN (p_row#>>'{metadata,proofId}')::uuid END;
    root:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,rootId}','uuid') THEN (p_row#>>'{metadata,rootId}')::uuid END;
    RETURN QUERY SELECT p.merchant_id,p.currency,p.id FROM public.payments p WHERE p.id=target;
    RETURN QUERY SELECT DISTINCT s.merchant_id,NULL::text,NULL::uuid FROM public.financial_application_scope_authority s WHERE s.merchant_id::text=p_row->>'merchant_id';
    RETURN QUERY SELECT e.merchant_id,e.currency,e.payment_id FROM public.payment_operation_evidence e WHERE e.id=proof;
    RETURN QUERY SELECT r.merchant_id,r.currency,r.payment_id FROM public.financial_application_roots r WHERE r.id=root;
  ELSIF p_relation='webhook_events' THEN
    RETURN QUERY SELECT e.merchant_id,e.currency,e.payment_id FROM public.payment_operation_evidence e WHERE e.inbox_id::text=p_row->>'id' AND e.operation='payment.authorized';
    RETURN QUERY SELECT o.merchant_id,o.currency,o.payment_id FROM public.receipt_admission_obligations o WHERE o.inbox_id::text=p_row->>'id' AND o.operation='payment.authorized';
  END IF;
END $$;

CREATE FUNCTION public.guard_manual_authorization_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; protected boolean; m public.financial_application_manifests%ROWTYPE; proof uuid; root uuid;
BEGIN
  IF TG_OP='DELETE' THEN n:=to_jsonb(OLD); END IF;
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  SELECT EXISTS(SELECT 1 FROM (VALUES(n),(o)) v(body)
    CROSS JOIN LATERAL public.manual_authorization_record_owners(TG_TABLE_NAME,v.body) owners
    JOIN public.financial_application_scope_authority s ON s.merchant_id=owners.merchant_id AND (owners.currency IS NULL OR s.currency=owners.currency)
    WHERE public.manual_authorization_scope_protected(s.merchant_id,s.currency)) INTO protected;
  IF NOT protected THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  proof:=CASE WHEN pg_input_is_valid(n#>>'{metadata,proofId}','uuid') THEN (n#>>'{metadata,proofId}')::uuid END;
  root:=CASE WHEN pg_input_is_valid(n#>>'{metadata,rootId}','uuid') THEN (n#>>'{metadata,rootId}')::uuid END;
  IF TG_TABLE_NAME='audit_logs' AND n->>'action' IS DISTINCT FROM 'payment.authorized'
    AND NOT EXISTS(SELECT 1 FROM public.payment_operation_evidence e WHERE e.operation='payment.authorized' AND e.id=proof)
    AND NOT EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.family='AUTHORIZE' AND r.id=root) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Protected authorization record cannot be deleted'; END IF;
  IF TG_TABLE_NAME='webhook_events' AND EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c
    WHERE c.transaction_id=pg_current_xact_id() AND c.backend_pid=pg_backend_pid() AND c.database_principal=session_user
      AND c.inbox_id=NEW.id AND c.before_image=o AND c.after_image=n) THEN
    IF TG_OP<>'UPDATE' OR n-ARRAY['status','attempts','locked_at','available_at','last_error','updated_at']
      IS DISTINCT FROM o-ARRAY['status','attempts','locked_at','available_at','last_error','updated_at'] THEN
      RAISE EXCEPTION 'Claim writer can change only bounded lease bookkeeping'; END IF;
    IF NOT ((NEW.status='PROCESSING' AND NEW.attempts=OLD.attempts+1 AND OLD.attempts<8
        AND (OLD.status IN ('PENDING','RETRY') OR (OLD.status='PROCESSING' AND OLD.locked_at<now()-interval '2 minutes'))
        AND OLD.available_at<=now() AND NEW.available_at=OLD.available_at AND NEW.last_error IS NOT DISTINCT FROM OLD.last_error AND NEW.locked_at=now() AND NEW.updated_at=now())
      OR (OLD.status='PROCESSING' AND NEW.attempts=OLD.attempts AND NEW.attempts BETWEEN 1 AND 8
        AND NEW.status::text=CASE WHEN OLD.attempts>=8 THEN 'DEAD' ELSE 'RETRY' END
        AND NEW.locked_at IS NULL AND NEW.available_at=now()+make_interval(secs=>least(300,power(2,OLD.attempts)::integer))
        AND NEW.last_error='Manual authorization application failed' AND NEW.updated_at=now())) THEN RAISE EXCEPTION 'Exact claim/failure transition required'; END IF;
    RETURN NEW;
  END IF;
  m:=public.current_financial_application_manifest();
  IF m.proof_kind<>'PAYMENT_OPERATION_V1' OR m.proof_operation<>'payment.authorized'
    OR EXISTS(SELECT 1 FROM (VALUES(n),(o)) v(body)
      CROSS JOIN LATERAL public.manual_authorization_record_owners(TG_TABLE_NAME,v.body) owners
      WHERE (owners.merchant_id IS NOT NULL AND owners.merchant_id IS DISTINCT FROM m.merchant_id)
        OR (owners.currency IS NOT NULL AND owners.currency IS DISTINCT FROM m.currency))
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=TG_TABLE_NAME AND x->>'id'=n->>'id'
      AND x->>'write'=TG_OP AND x->'after'=n AND (TG_OP='INSERT' OR x->'before'=o)) THEN
    RAISE EXCEPTION 'Exact owned SQL authorization record write required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_authorization_write BEFORE INSERT OR UPDATE OR DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_write();
CREATE TRIGGER manual_authorization_write BEFORE INSERT OR UPDATE OR DELETE ON public.webhook_events FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_write();

CREATE FUNCTION public.claim_manual_authorization(p_inbox uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; generation integer;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Authorization claim requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations o JOIN public.payment_operation_evidence e ON e.id=o.payment_operation_proof_id
    JOIN public.financial_application_scope_authority s ON s.merchant_id=e.merchant_id AND s.currency=e.currency
    WHERE o.inbox_id=p_inbox AND o.disposition='AWAITING_APPLICATION' AND e.operation='payment.authorized' AND e.provider_mode='TEST'
      AND (s.provider,s.provider_account,s.policy,s.epoch,s.admission_mode)=(e.provider,e.provider_account,'LEGACY',0,'DORMANT')) THEN
    RAISE EXCEPTION 'Bound private AUTH obligation required'; END IF;
  INSERT INTO public.manual_authorization_claim_writes(transaction_id,backend_pid,database_principal,inbox_id,operation,before_image,after_image)
    VALUES(pg_current_xact_id(),pg_backend_pid(),session_user,p_inbox,'CLAIM',to_jsonb(w),
      to_jsonb(w)||jsonb_build_object('status','PROCESSING','attempts',w.attempts+1,'locked_at',now(),'updated_at',now()));
  UPDATE public.webhook_events SET status='PROCESSING',attempts=attempts+1,locked_at=now(),updated_at=now()
    WHERE id=p_inbox AND attempts<8 AND available_at<=now()
      AND (status IN ('PENDING','RETRY') OR (status='PROCESSING' AND locked_at<now()-interval '2 minutes')) RETURNING attempts INTO generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorization inbox is not claimable'; END IF;
  RETURN generation;
END $$;

CREATE FUNCTION public.fail_manual_authorization(p_inbox uuid,p_generation integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Authorization failure CAS requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations o JOIN public.payment_operation_evidence e ON e.id=o.payment_operation_proof_id
    JOIN public.financial_application_scope_authority s ON s.merchant_id=e.merchant_id AND s.currency=e.currency
    WHERE o.inbox_id=p_inbox AND e.operation='payment.authorized' AND e.provider_mode='TEST'
      AND (s.provider,s.provider_account,s.policy,s.epoch,s.admission_mode)=(e.provider,e.provider_account,'LEGACY',0,'DORMANT')) THEN RAISE EXCEPTION 'Private AUTH claim required'; END IF;
  IF w.status<>'PROCESSING' OR w.attempts IS DISTINCT FROM p_generation OR w.attempts NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
  INSERT INTO public.manual_authorization_claim_writes(transaction_id,backend_pid,database_principal,inbox_id,operation,before_image,after_image)
    VALUES(pg_current_xact_id(),pg_backend_pid(),session_user,p_inbox,'FAIL',to_jsonb(w),to_jsonb(w)||jsonb_build_object(
      'status',CASE WHEN w.attempts>=8 THEN 'DEAD' ELSE 'RETRY' END,'available_at',now()+make_interval(secs=>least(300,power(2,w.attempts)::integer)),
      'locked_at',NULL,'last_error','Manual authorization application failed','updated_at',now()));
  UPDATE public.webhook_events SET status=CASE WHEN attempts>=8 THEN 'DEAD'::public.inbox_status ELSE 'RETRY'::public.inbox_status END,
    available_at=now()+make_interval(secs=>least(300,power(2,attempts)::integer)),locked_at=NULL,last_error='Manual authorization application failed',updated_at=now()
    WHERE id=p_inbox AND status='PROCESSING' AND attempts=p_generation AND attempts BETWEEN 1 AND 8;
  RETURN FOUND;
END $$;

CREATE FUNCTION public.guard_manual_authorization_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user<>'fintech_manual_claim_'||md5(current_database())
    OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.database_principal IS DISTINCT FROM session_user OR NEW.before_image->>'id' IS DISTINCT FROM NEW.inbox_id::text
    OR NEW.after_image->>'id' IS DISTINCT FROM NEW.inbox_id::text THEN RAISE EXCEPTION 'Protected claim witness writer required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_claim_writer BEFORE INSERT ON public.manual_authorization_claim_writes
  FOR EACH ROW EXECUTE FUNCTION public.guard_manual_authorization_claim();
CREATE FUNCTION public.check_manual_authorization_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.webhook_events w WHERE w.id=NEW.inbox_id AND to_jsonb(w)=NEW.after_image) THEN
    RAISE EXCEPTION 'Claim witness requires its exact final inbox write'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manual_claim_complete AFTER INSERT ON public.manual_authorization_claim_writes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_authorization_claim();

--> statement-breakpoint
DO $$ DECLARE authorizer text:='fintech_manual_authorization_'||md5(current_database());
  claimer text:='fintech_manual_claim_'||md5(current_database()); historian text:='fintech_manual_history_'||md5(current_database());
  application text:='fintech_application_'||md5(current_database()); admission text:='fintech_admission_'||md5(current_database());
  role_name text; f record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[authorizer,claimer,historian] LOOP
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',role_name);
  END LOOP;
  EXECUTE format('GRANT SELECT ON public.financial_application_contracts,public.financial_application_scope_authority,public.financial_application_roots,
    public.financial_application_manifests,public.financial_application_permits,public.financial_applications,public.financial_application_dispositions,
    public.financial_application_revision_effects,public.financial_application_effect_links,public.payment_operation_evidence,public.provider_command_authorities,
    public.provider_command_executions,public.provider_observation_sources,public.provider_observation_obligations,public.provider_financial_receipts,
    public.receipt_admissions,public.receipt_admission_obligations,public.financial_evidence_accounts,public.capture_accounting_scopes,public.receipt_intake_authority,
    public.webhook_events,public.payments,public.payment_attempts,public.refunds,public.disputes,public.capture_accounting_lots,public.audit_logs,
    public.ledger_transactions,public.receipt_delivery_barriers,public.accounting_exceptions,public.manual_authorization_claim_writes,
    public.manual_authorization_issuances TO %I',historian);
  EXECUTE format('GRANT SELECT ON public.financial_application_contracts,public.financial_application_scope_authority,public.financial_application_roots,
    public.financial_application_manifests,public.financial_application_permits,public.financial_applications,public.financial_application_dispositions,
    public.provider_command_authorities,public.provider_observation_obligations,public.receipt_admission_obligations,
    public.financial_evidence_accounts,public.capture_accounting_scopes,public.receipt_intake_authority,public.webhook_events,public.payments,
    public.payment_attempts,public.refunds,public.disputes,public.capture_accounting_lots,public.ledger_transactions TO %I',authorizer);
  EXECUTE format('GRANT INSERT ON public.financial_application_roots,public.financial_application_manifests,public.financial_application_permits,
    public.financial_applications,public.financial_application_dispositions,public.audit_logs,public.manual_authorization_issuances TO %I',authorizer);
  EXECUTE format('GRANT SELECT(action,target_id,metadata) ON public.audit_logs TO %I',authorizer);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts,public.capture_accounting_scopes TO %I',authorizer);
  EXECUTE format('GRANT UPDATE(status,authorized_amount,authorized_at,updated_at,version) ON public.payments TO %I',authorizer);
  EXECUTE format('GRANT UPDATE(status,provider_transaction_id,updated_at) ON public.payment_attempts TO %I',authorizer);
  EXECUTE format('GRANT UPDATE(status,processed_at,locked_at,updated_at) ON public.webhook_events TO %I',authorizer);
  EXECUTE format('GRANT SELECT ON public.webhook_events,public.receipt_admission_obligations,public.payment_operation_evidence,
    public.financial_application_scope_authority TO %I',claimer);
  EXECUTE format('GRANT INSERT ON public.manual_authorization_claim_writes TO %I',claimer);
  EXECUTE format('GRANT UPDATE(status,attempts,locked_at,available_at,last_error,updated_at) ON public.webhook_events TO %I',claimer);
  EXECUTE format('GRANT SELECT ON public.financial_application_roots,public.financial_applications,public.financial_application_scope_authority TO %I',admission);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.checked_payment_command_source(uuid),public.provider_form(bytea),public.provider_form_component(text),
    public.payment_json(bytea),public.check_payment_json(json),public.payment_minor(jsonb,text),public.payment_operation_receipt_facts(uuid),
    public.financial_external_reference(jsonb),public.current_financial_application_manifest() TO %I',historian);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.load_effective_payment_operation_evidence(uuid,integer,text),
    public.current_financial_application_manifest(),public.advance_financial_application_revision() TO %I',authorizer);
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'manual_authorization_original_proof','check_manual_authorization','validate_manual_authorization','manual_authorization_history',
    'manual_authorization_scope_protected','guard_manual_authorization_issuance',
    'recognize_manual_authorization','manual_authorization_cause_cleared','manual_authorization_blocked','manual_authorization_record_owners',
    'guard_manual_authorization_write','guard_manual_authorization_authority','check_manual_authorization_finality',
    'prepare_manual_authorization','apply_manual_authorization','claim_manual_authorization','fail_manual_authorization',
    'guard_manual_authorization_claim','check_manual_authorization_claim') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,CASE
      WHEN f.proname IN ('prepare_manual_authorization','apply_manual_authorization','recognize_manual_authorization') THEN authorizer
      WHEN f.proname IN ('claim_manual_authorization','fail_manual_authorization') THEN claimer ELSE historian END);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.manual_authorization_original_proof(uuid),public.manual_authorization_blocked(text,text,uuid,text,uuid,bigint,uuid) TO %I',authorizer);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.manual_authorization_history(uuid),public.manual_authorization_record_owners(text,jsonb) TO %I',authorizer);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.check_manual_authorization(uuid,boolean,boolean) TO %I',application);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.manual_authorization_history(uuid),public.manual_authorization_blocked(text,text,uuid,text,uuid,bigint,uuid) TO %I',admission);
  FOREACH role_name IN ARRAY ARRAY[authorizer,claimer,historian] LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',role_name);
  END LOOP;
END $$;

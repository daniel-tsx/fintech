-- P-C: private first-capture intent only; no financial application or runtime grant.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.financial_application_permits IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.financial_application_roots ADD CONSTRAINT capture_intent_auth_owner UNIQUE(id,payment_id,merchant_id,currency);
ALTER TABLE public.outbox_events ADD CONSTRAINT capture_intent_outbox_owner UNIQUE(id,aggregate_id);
ALTER TABLE public.provider_command_authorities ADD CONSTRAINT capture_intent_command_owner UNIQUE(outbox_id,operation_id,payment_id,merchant_id,currency);
ALTER TABLE public.audit_logs ADD CONSTRAINT capture_intent_audit_owner UNIQUE(id,merchant_id);

CREATE TABLE public.first_capture_intent_requests (
  id uuid PRIMARY KEY, auth_root_id uuid NOT NULL, merchant_id uuid NOT NULL, currency text NOT NULL, payment_id uuid NOT NULL,
  operation text NOT NULL, request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 255),
  request_payload jsonb NOT NULL, request_hash bytea NOT NULL,
  database_principal name NOT NULL, transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(merchant_id,operation,request_key), UNIQUE(id,auth_root_id,payment_id,merchant_id,currency),
  FOREIGN KEY(auth_root_id,payment_id,merchant_id,currency) REFERENCES public.financial_application_roots(id,payment_id,merchant_id,currency),
  CHECK(operation='fixture.first-capture:'||payment_id::text)
);
CREATE TABLE public.first_capture_intent_manifests (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, auth_root_id uuid NOT NULL,
  payment_id uuid NOT NULL UNIQUE, merchant_id uuid NOT NULL, currency text NOT NULL,
  provider text NOT NULL CHECK(provider='STRIPE'), provider_account text NOT NULL, provider_mode text NOT NULL CHECK(provider_mode='TEST'),
  policy text NOT NULL CHECK(policy='LEGACY'), epoch bigint NOT NULL CHECK(epoch=0),
  variant text NOT NULL CHECK(variant IN ('FULL','FIRST_PARTIAL','FINAL_PARTIAL')),
  amount bigint NOT NULL CHECK(amount>0 AND amount<=9007199254740991),
  authorized_amount bigint NOT NULL CHECK(authorized_amount>0 AND authorized_amount<=9007199254740991),
  payment_version integer NOT NULL, scope_revision bigint NOT NULL, intake_revision bigint NOT NULL,
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, database_principal name NOT NULL,
  attempt_id uuid NOT NULL UNIQUE, outbox_id uuid NOT NULL UNIQUE, audit_id uuid NOT NULL UNIQUE,
  source_manifest jsonb NOT NULL, effect_manifest jsonb NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(transaction_id,backend_pid), UNIQUE(id,request_id,auth_root_id,payment_id,merchant_id,currency),
  FOREIGN KEY(request_id,auth_root_id,payment_id,merchant_id,currency)
    REFERENCES public.first_capture_intent_requests(id,auth_root_id,payment_id,merchant_id,currency),
  FOREIGN KEY(attempt_id,payment_id,merchant_id,currency) REFERENCES public.payment_attempts(id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(outbox_id,attempt_id) REFERENCES public.outbox_events(id,aggregate_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(outbox_id,attempt_id,payment_id,merchant_id,currency)
    REFERENCES public.provider_command_authorities(outbox_id,operation_id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(audit_id,merchant_id) REFERENCES public.audit_logs(id,merchant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  CHECK((variant='FULL' AND amount=authorized_amount) OR (variant IN ('FIRST_PARTIAL','FINAL_PARTIAL') AND amount<authorized_amount))
);
CREATE TABLE public.first_capture_intent_acceptances (
  manifest_id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, auth_root_id uuid NOT NULL,
  payment_id uuid NOT NULL UNIQUE, merchant_id uuid NOT NULL, currency text NOT NULL,
  status_code integer NOT NULL CHECK(status_code=202), response_body jsonb NOT NULL,
  prior_revision bigint NOT NULL, final_revision bigint NOT NULL CHECK(final_revision=prior_revision+1), created_at timestamptz NOT NULL,
  FOREIGN KEY(manifest_id,request_id,auth_root_id,payment_id,merchant_id,currency)
    REFERENCES public.first_capture_intent_manifests(id,request_id,auth_root_id,payment_id,merchant_id,currency)
);
ALTER TABLE public.financial_application_permits ALTER COLUMN manifest_id DROP NOT NULL;
ALTER TABLE public.financial_application_permits ADD COLUMN permit_kind text NOT NULL DEFAULT 'APPLICATION',
  ADD COLUMN intent_manifest_id uuid UNIQUE REFERENCES public.first_capture_intent_manifests(id),
  ADD CONSTRAINT application_permit_exclusive_target CHECK(((permit_kind='APPLICATION' AND manifest_id IS NOT NULL AND intent_manifest_id IS NULL)
    OR (permit_kind='CAPTURE_INTENT' AND manifest_id IS NULL AND intent_manifest_id IS NOT NULL)) IS TRUE);
--> statement-breakpoint

CREATE FUNCTION public.first_capture_intent_scope_protected(p_merchant uuid,p_currency text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=p_merchant AND currency=p_currency)
    AND (EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='CAPTURE' AND phase='INTENT_ACCEPTANCE' AND policy='LEGACY'
      AND version=1 AND prepare_function='public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_first_capture_intent(uuid)'::regprocedure)
      OR EXISTS(SELECT 1 FROM public.first_capture_intent_manifests WHERE merchant_id=p_merchant AND currency=p_currency));
END
$$;

CREATE FUNCTION public.current_first_capture_intent() RETURNS public.first_capture_intent_manifests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE;
BEGIN
  SELECT v.* INTO m FROM public.financial_application_permits p JOIN public.first_capture_intent_manifests v ON v.id=p.intent_manifest_id
    WHERE p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.database_principal=session_user
      AND p.permit_kind='CAPTURE_INTENT' AND p.manifest_id IS NULL
      AND (v.transaction_id,v.backend_pid,v.database_principal)=(p.transaction_id,p.backend_pid,p.database_principal);
  IF NOT FOUND THEN RAISE EXCEPTION 'Current transaction/backend capture intent permit required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency
      AND (s.provider,s.provider_account,s.policy,s.epoch,s.admission_mode)=(m.provider,m.provider_account,'LEGACY',0,'DORMANT'))
    OR NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency
      AND s.evidence_revision IN (m.scope_revision,(SELECT final_revision FROM public.first_capture_intent_acceptances WHERE manifest_id=m.id)))
    OR m.intake_revision IS DISTINCT FROM coalesce((SELECT evidence_revision FROM public.receipt_intake_authority
      WHERE provider=m.provider AND provider_account=m.provider_account),0) THEN RAISE EXCEPTION 'Stale capture intent policy or evidence revision'; END IF;
  RETURN m;
END $$;

CREATE FUNCTION public.check_first_capture_intent(p_manifest uuid,p_final boolean,p_historical boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE; q public.first_capture_intent_requests%ROWTYPE;
  r public.financial_application_roots%ROWTYPE; auth public.financial_application_manifests%ROWTYPE; proof public.payment_operation_evidence%ROWTYPE;
  a public.first_capture_intent_acceptances%ROWTYPE; expected jsonb; payload jsonb; bp jsonb; x jsonb; actual jsonb; n integer:=0;
BEGIN
  SELECT * INTO STRICT m FROM public.first_capture_intent_manifests WHERE id=p_manifest;
  SELECT * INTO STRICT q FROM public.first_capture_intent_requests WHERE id=m.request_id;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.auth_root_id;
  SELECT v.* INTO STRICT auth FROM public.financial_applications app JOIN public.financial_application_manifests v ON v.id=app.manifest_id WHERE app.root_id=r.id;
  SELECT * INTO STRICT proof FROM public.payment_operation_evidence WHERE id=auth.payment_operation_proof_id;
  SELECT * INTO STRICT a FROM public.first_capture_intent_acceptances WHERE manifest_id=m.id;
  IF NOT public.manual_authorization_history(r.id) OR m.source_manifest->'request' IS DISTINCT FROM to_jsonb(q)
    OR m.source_manifest->'auth_root' IS DISTINCT FROM to_jsonb(r) OR m.source_manifest->'auth_manifest' IS DISTINCT FROM to_jsonb(auth)
    OR m.source_manifest->'auth_proof' IS DISTINCT FROM to_jsonb(proof)
    OR (m.auth_root_id,m.payment_id,m.merchant_id,m.currency,m.provider,m.provider_account,m.provider_mode,m.authorized_amount,m.policy,m.epoch)
      IS DISTINCT FROM (r.id,r.payment_id,r.merchant_id,r.currency,r.provider,r.provider_account,proof.provider_mode,proof.authorized_principal,'LEGACY',0::bigint)
    OR (q.auth_root_id,q.payment_id,q.merchant_id,q.currency,q.transaction_id,q.backend_pid,q.database_principal)
      IS DISTINCT FROM(m.auth_root_id,m.payment_id,m.merchant_id,m.currency,m.transaction_id,m.backend_pid,m.database_principal)
    OR q.request_payload IS DISTINCT FROM jsonb_build_object('authRootId',r.id,'merchantId',r.merchant_id,'paymentId',r.payment_id,'currency',r.currency,'amount',m.amount,'variant',m.variant)
    OR q.request_hash IS DISTINCT FROM sha256(convert_to(q.request_payload::text,'UTF8'))
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_permits p WHERE p.permit_kind='CAPTURE_INTENT' AND p.manifest_id IS NULL AND p.intent_manifest_id=m.id
      AND (p.transaction_id,p.backend_pid,p.database_principal)=(m.transaction_id,m.backend_pid,m.database_principal))
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='CAPTURE' AND phase='INTENT_ACCEPTANCE' AND policy='LEGACY' AND version=1
      AND prepare_function='public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_first_capture_intent(uuid)'::regprocedure) THEN RAISE EXCEPTION 'Exact original capture intent authority required'; END IF;
  bp:=m.source_manifest->'payment_before';
  IF bp IS DISTINCT FROM auth.effect_manifest#>'{0,after}' OR m.payment_version IS DISTINCT FROM (bp->>'version')::integer
    OR (bp->>'status',bp->>'capture_method',(bp->>'authorized_amount')::bigint,(bp->>'captured_amount')::bigint,
      (bp->>'platform_fee_amount')::bigint,(bp->>'refunded_amount')::bigint)
      IS DISTINCT FROM('AUTHORIZED','MANUAL',m.authorized_amount,0::bigint,0::bigint,0::bigint)
    OR jsonb_array_length(m.effect_manifest)<>6 THEN RAISE EXCEPTION 'Exact first capture before-image and six effect groups required'; END IF;
  payload:=jsonb_build_object('merchantId',m.merchant_id,'paymentId',m.payment_id,'attemptId',m.attempt_id,'amount',m.amount,'currency',m.currency,
    'providerPaymentId',proof.payment_intent_id,'finalCapture',m.variant<>'FIRST_PARTIAL','idempotencyKey','capture:'||m.attempt_id::text);
  expected:=jsonb_build_array(
    jsonb_build_object('table','payments','id',m.payment_id,'write','UPDATE','before',bp,'after',bp||jsonb_build_object('status','CAPTURE_PENDING','version',m.payment_version+1,'updated_at',m.created_at)),
    jsonb_build_object('table','payment_attempts','id',m.attempt_id,'write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.payment_attempts,
      jsonb_build_object('id',m.attempt_id,'merchant_id',m.merchant_id,'payment_id',m.payment_id,'kind','CAPTURE','status','PENDING','amount',m.amount,'currency',m.currency,
        'provider_transaction_id',NULL,'failure_code',NULL,'created_at',m.created_at,'updated_at',m.created_at)))),
    jsonb_build_object('table','outbox_events','id',m.outbox_id,'write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.outbox_events,
      jsonb_build_object('id',m.outbox_id,'aggregate_type','PAYMENT_ATTEMPT','aggregate_id',m.attempt_id,'event_type','provider.capture.requested','payload',payload,
        'status','PENDING','attempts',0,'available_at',m.created_at,'locked_at',NULL,'published_at',NULL,'last_error',NULL,'created_at',m.created_at,'updated_at',m.created_at)))),
    jsonb_build_object('table','provider_command_authorities','id',m.outbox_id,'write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.provider_command_authorities,
      jsonb_build_object('outbox_id',m.outbox_id,'provider',m.provider,'provider_account',m.provider_account,'provider_mode','TEST','operation','CAPTURE','operation_id',m.attempt_id,
        'payment_id',m.payment_id,'merchant_id',m.merchant_id,'currency',m.currency,'amount',m.amount,'command_key','capture:'||m.attempt_id::text,'command_payload',payload,
        'accounting_policy','LEGACY','acceptance_epoch',0,'accepted_at',m.effect_manifest#>>'{3,after,accepted_at}')))),
    jsonb_build_object('table','audit_logs','id',m.audit_id,'write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.audit_logs,
      jsonb_build_object('id',m.audit_id,'merchant_id',m.merchant_id,'actor_type','FIXTURE','actor_id',m.database_principal,'action','payment.capture_requested','target_type','payment',
        'target_id',m.payment_id::text,'correlation_id',NULL,'metadata',jsonb_build_object('intentId',m.id,'authRootId',r.id,'attemptId',m.attempt_id,'outboxId',m.outbox_id,
          'amount',m.amount,'variant',m.variant),'created_at',m.created_at)))),
    jsonb_build_object('table','first_capture_intent_acceptances','id',m.id,'write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.first_capture_intent_acceptances,
      jsonb_build_object('manifest_id',m.id,'request_id',q.id,'auth_root_id',r.id,'payment_id',m.payment_id,'merchant_id',m.merchant_id,'currency',m.currency,'status_code',202,
        'response_body',jsonb_build_object('paymentId',m.payment_id,'attemptId',m.attempt_id,'status','CAPTURE_PENDING','amount',m.amount),
        'prior_revision',m.scope_revision,'final_revision',m.scope_revision+1,'created_at',m.created_at)))));
  IF m.effect_manifest IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Missing whole group or altered first capture plan'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(expected) LOOP
    n:=n+1;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE %I=$1',x->>'table',CASE n WHEN 4 THEN 'outbox_id' WHEN 6 THEN 'manifest_id' ELSE 'id' END)
      INTO actual USING (x->>'id')::uuid;
    IF p_historical AND n=1 THEN
      IF NOT EXISTS(SELECT 1 FROM public.payments WHERE id=m.payment_id AND merchant_id=m.merchant_id AND currency=m.currency
        AND amount=m.authorized_amount AND authorized_amount=m.authorized_amount AND capture_method='MANUAL' AND version>=m.payment_version+1) THEN
        RAISE EXCEPTION 'Historical capture payment identity mismatch'; END IF;
    ELSIF p_historical AND n=2 THEN
      IF actual-ARRAY['status','provider_transaction_id','failure_code','updated_at'] IS DISTINCT FROM (x->'after')-ARRAY['status','provider_transaction_id','failure_code','updated_at'] THEN
        RAISE EXCEPTION 'Historical capture attempt identity mismatch'; END IF;
    ELSIF p_historical AND n=3 THEN
      IF actual-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at']
        IS DISTINCT FROM (x->'after')-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at'] THEN
        RAISE EXCEPTION 'Historical capture outbox identity mismatch'; END IF;
    ELSIF actual IS DISTINCT FROM x->'after' THEN RAISE EXCEPTION 'First capture effect group is incomplete'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency
    AND CASE WHEN p_historical THEN s.evidence_revision>=a.final_revision WHEN p_final THEN s.evidence_revision=a.final_revision ELSE s.evidence_revision=m.scope_revision END) THEN
    RAISE EXCEPTION 'Exact guarded capture intent revision required'; END IF;
  IF NOT p_historical THEN
    IF (m.transaction_id,m.backend_pid,m.database_principal) IS DISTINCT FROM(pg_current_xact_id(),pg_backend_pid(),session_user)
      OR m.intake_revision IS DISTINCT FROM coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=m.provider AND provider_account=m.provider_account),0)
      OR (SELECT count(*) FROM public.payment_attempts WHERE payment_id=m.payment_id)<>2
      OR (SELECT count(*) FROM public.provider_command_authorities WHERE payment_id=m.payment_id)<>2
      OR (SELECT count(*) FROM public.financial_application_roots WHERE payment_id=m.payment_id)<>1
      OR (SELECT count(*) FROM public.outbox_events o WHERE EXISTS(
        SELECT 1 FROM public.first_capture_intent_record_owners('outbox_events',to_jsonb(o)) owners WHERE owners.payment_id=m.payment_id))<>2
      OR (SELECT count(*) FROM public.audit_logs audit_row WHERE audit_row.action='payment.capture_requested' AND EXISTS(
        SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',to_jsonb(audit_row)) owners WHERE owners.payment_id=m.payment_id))<>1
      OR EXISTS(SELECT 1 FROM public.capture_accounting_lots WHERE payment_id=m.payment_id)
      OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=m.payment_id) OR EXISTS(SELECT 1 FROM public.disputes WHERE payment_id=m.payment_id)
      OR EXISTS(SELECT 1 FROM public.ledger_transactions j JOIN public.payment_attempts t ON t.id=j.business_id WHERE t.payment_id=m.payment_id)
      OR EXISTS(SELECT 1 FROM public.financial_application_dispositions WHERE root_id IN (SELECT id FROM public.financial_application_roots WHERE payment_id=m.payment_id AND id<>r.id))
      OR public.manual_authorization_blocked(m.provider,m.provider_account,m.merchant_id,m.currency) THEN
      RAISE EXCEPTION 'Capture intent requires exact workflow groups and no financial or source effects'; END IF;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.validate_first_capture_intent(p_manifest uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.check_first_capture_intent(p_manifest,true,false) $$;

CREATE FUNCTION public.advance_first_capture_intent_revision() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE;
BEGIN
  m:=public.current_first_capture_intent();
  PERFORM public.check_first_capture_intent(m.id,false,false);
  UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1
    WHERE merchant_id=m.merchant_id AND currency=m.currency AND evidence_revision=m.scope_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capture intent revision compare-and-set failed'; END IF;
END $$;

CREATE FUNCTION public.apply_first_capture_intent() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE; child public.payment_attempts%ROWTYPE; w public.outbox_events%ROWTYPE;
  audit public.audit_logs%ROWTYPE; a public.first_capture_intent_acceptances%ROWTYPE;
BEGIN
  m:=public.current_first_capture_intent();
  IF public.manual_authorization_blocked(m.provider,m.provider_account,m.merchant_id,m.currency) THEN RAISE EXCEPTION 'Capture intent evidence became blocked'; END IF;
  UPDATE public.payments SET status='CAPTURE_PENDING',version=version+1,updated_at=m.created_at WHERE id=m.payment_id;
  child:=jsonb_populate_record(NULL::public.payment_attempts,m.effect_manifest#>'{1,after}');
  INSERT INTO public.payment_attempts SELECT child.*;
  w:=jsonb_populate_record(NULL::public.outbox_events,m.effect_manifest#>'{2,after}');
  INSERT INTO public.outbox_events SELECT w.*;
  PERFORM public.accept_provider_command(m.outbox_id,m.provider_account,m.provider_mode);
  audit:=jsonb_populate_record(NULL::public.audit_logs,m.effect_manifest#>'{4,after}');
  INSERT INTO public.audit_logs SELECT audit.*;
  a:=jsonb_populate_record(NULL::public.first_capture_intent_acceptances,m.effect_manifest#>'{5,after}');
  INSERT INTO public.first_capture_intent_acceptances SELECT a.*;
  PERFORM public.advance_first_capture_intent_revision();
  RETURN jsonb_build_object('statusCode',a.status_code,'body',a.response_body);
END $$;

CREATE FUNCTION public.accept_first_capture_intent(p_root uuid,p_key text,p_amount numeric,p_variant text,
  p_version integer,p_scope bigint,p_intake bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.first_capture_intent_requests%ROWTYPE; m public.first_capture_intent_manifests%ROWTYPE; a public.first_capture_intent_acceptances%ROWTYPE;
BEGIN
  q:=public.first_capture_intent_request(p_root,p_key,p_amount,p_variant);
  SELECT * INTO a FROM public.first_capture_intent_acceptances WHERE request_id=q.id;
  IF FOUND THEN
    SELECT * INTO STRICT m FROM public.first_capture_intent_manifests WHERE id=a.manifest_id;
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=m.provider AND provider_account=m.provider_account FOR SHARE;
    PERFORM pg_advisory_xact_lock(hashtextextended(m.merchant_id::text||':'||m.currency,0));
    PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=m.merchant_id AND currency=m.currency FOR NO KEY UPDATE;
    PERFORM public.check_first_capture_intent(m.id,true,true);
    RETURN jsonb_build_object('statusCode',a.status_code,'body',a.response_body);
  END IF;
  PERFORM public.prepare_first_capture_intent(p_root,p_key,p_amount,p_variant,p_version,p_scope,p_intake);
  RETURN public.apply_first_capture_intent();
END $$;

-- The request wrapper is acquired before account/advisory/scope/payment locks.
-- A conflicting INSERT waits; the following statement reads the committed winner.
CREATE FUNCTION public.first_capture_intent_request(p_root uuid,p_key text,p_amount numeric,p_variant text)
RETURNS public.first_capture_intent_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; q public.first_capture_intent_requests%ROWTYPE; body jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'First capture intent requires READ COMMITTED'; END IF;
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 255 OR p_variant IS NULL OR p_variant NOT IN ('FULL','FIRST_PARTIAL','FINAL_PARTIAL')
    OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount<=0 OR p_amount>9007199254740991
    OR trunc(p_amount)<>p_amount THEN RAISE EXCEPTION 'Exact bounded integer capture amount, variant and private key required'; END IF;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=p_root AND family='AUTHORIZE' AND phase='TERMINAL';
  body:=jsonb_build_object('authRootId',r.id,'merchantId',r.merchant_id,'paymentId',r.payment_id,'currency',r.currency,
    'amount',p_amount::bigint,'variant',p_variant);
  INSERT INTO public.first_capture_intent_requests(id,auth_root_id,merchant_id,currency,payment_id,operation,request_key,request_payload,request_hash,
    database_principal,transaction_id,backend_pid,created_at)
    VALUES(gen_random_uuid(),r.id,r.merchant_id,r.currency,r.payment_id,'fixture.first-capture:'||r.payment_id::text,p_key,body,
      sha256(convert_to(body::text,'UTF8')),session_user,pg_current_xact_id(),pg_backend_pid(),clock_timestamp())
    ON CONFLICT(merchant_id,operation,request_key) DO NOTHING;
  SELECT * INTO STRICT q FROM public.first_capture_intent_requests WHERE merchant_id=r.merchant_id
    AND operation='fixture.first-capture:'||r.payment_id::text AND request_key=p_key FOR UPDATE;
  IF q.auth_root_id IS DISTINCT FROM r.id OR q.request_payload IS DISTINCT FROM body
    OR q.request_hash IS DISTINCT FROM sha256(convert_to(body::text,'UTF8')) OR q.database_principal IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'Private capture request payload or principal conflict'; END IF;
  RETURN q;
END $$;

CREATE FUNCTION public.prepare_first_capture_intent(p_root uuid,p_key text,p_amount numeric,p_variant text,
  p_version integer,p_scope bigint,p_intake bigint) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.first_capture_intent_requests%ROWTYPE; r public.financial_application_roots%ROWTYPE;
  auth public.financial_application_manifests%ROWTYPE; proof public.payment_operation_evidence%ROWTYPE; p public.payments%ROWTYPE;
  m public.first_capture_intent_manifests%ROWTYPE; child public.payment_attempts%ROWTYPE; w public.outbox_events%ROWTYPE;
  command public.provider_command_authorities%ROWTYPE; audit public.audit_logs%ROWTYPE; acceptance public.first_capture_intent_acceptances%ROWTYPE;
  sr bigint; ir bigint; stamp timestamptz:=clock_timestamp(); bp jsonb; after_payment jsonb; payload jsonb;
BEGIN
  q:=public.first_capture_intent_request(p_root,p_key,p_amount,p_variant);
  IF EXISTS(SELECT 1 FROM public.first_capture_intent_acceptances WHERE request_id=q.id) THEN RAISE EXCEPTION 'Existing capture intent requires immutable replay'; END IF;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=q.auth_root_id;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=r.provider_account AND provider_mode='TEST' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured TEST capture account required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.merchant_id::text||':'||r.currency,0));
  SELECT evidence_revision INTO STRICT sr FROM public.capture_accounting_scopes WHERE merchant_id=r.merchant_id AND currency=r.currency FOR NO KEY UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=r.merchant_id AND currency=r.currency
    AND (provider,provider_account,policy,epoch,admission_mode)=(r.provider,r.provider_account,'LEGACY',0,'DORMANT')) THEN RAISE EXCEPTION 'Private DORMANT LEGACY capture authority required'; END IF;
  SELECT coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=r.provider AND provider_account=r.provider_account),0) INTO ir;
  IF (sr,ir) IS DISTINCT FROM(p_scope,p_intake) THEN RAISE EXCEPTION 'Stale capture intent evidence revisions'; END IF;
  PERFORM 1 FROM public.payments WHERE id=r.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=r.payment_id ORDER BY id FOR UPDATE;
  IF NOT public.manual_authorization_history(r.id) THEN RAISE EXCEPTION 'Original complete MANUAL authorization required for first capture'; END IF;
  SELECT v.* INTO STRICT auth FROM public.financial_applications a JOIN public.financial_application_manifests v ON v.id=a.manifest_id WHERE a.root_id=r.id;
  SELECT * INTO STRICT proof FROM public.payment_operation_evidence WHERE id=auth.payment_operation_proof_id;
  SELECT * INTO STRICT p FROM public.payments WHERE id=r.payment_id;
  IF NOT public.first_capture_intent_scope_protected(r.merchant_id,r.currency)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='CAPTURE' AND phase='INTENT_ACCEPTANCE' AND policy='LEGACY' AND version=1
      AND prepare_function='public.prepare_first_capture_intent(uuid,text,numeric,text,integer,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_first_capture_intent(uuid)'::regprocedure) THEN RAISE EXCEPTION 'Exact private first capture contract is not installed'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_application_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()) THEN
    RAISE EXCEPTION 'One protected application or capture intent per transaction'; END IF;
  IF q.transaction_id IS DISTINCT FROM pg_current_xact_id() OR q.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR p.capture_method<>'MANUAL' OR p.status<>'AUTHORIZED' OR p.version IS DISTINCT FROM p_version
    OR to_jsonb(p) IS DISTINCT FROM auth.effect_manifest#>'{0,after}' OR p.authorized_amount<>proof.authorized_principal
    OR p.captured_amount<>0 OR p.platform_fee_amount<>0 OR p.refunded_amount<>0 OR p.captured_at IS NOT NULL
    OR (p_variant='FULL' AND p_amount<>p.authorized_amount) OR (p_variant<>'FULL' AND p_amount>=p.authorized_amount)
    OR (SELECT count(*) FROM public.payment_attempts WHERE payment_id=p.id)<>1
    OR EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE payment_id=p.id AND outbox_id<>r.accepted_outbox_id)
    OR EXISTS(SELECT 1 FROM public.financial_application_roots WHERE payment_id=p.id AND id<>r.id)
    OR EXISTS(SELECT 1 FROM public.first_capture_intent_manifests WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.audit_logs audit_row WHERE audit_row.action='payment.capture_requested' AND EXISTS(
      SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',to_jsonb(audit_row)) owners WHERE owners.payment_id=p.id))
    OR EXISTS(SELECT 1 FROM public.capture_accounting_lots WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=p.id) OR EXISTS(SELECT 1 FROM public.disputes WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions j JOIN public.payment_attempts t ON t.id=j.business_id WHERE t.payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.outbox_events o WHERE o.id<>r.accepted_outbox_id AND EXISTS(
      SELECT 1 FROM public.first_capture_intent_record_owners('outbox_events',to_jsonb(o)) owners WHERE owners.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Exact first MANUAL capture with no other operation or financial effect required'; END IF;
  IF public.manual_authorization_blocked(r.provider,r.provider_account,r.merchant_id,r.currency) THEN RAISE EXCEPTION 'First capture blocked by unresolved evidence'; END IF;
  m.id:=gen_random_uuid(); m.request_id:=q.id; m.auth_root_id:=r.id; m.payment_id:=p.id; m.merchant_id:=p.merchant_id; m.currency:=p.currency;
  m.provider:=r.provider; m.provider_account:=r.provider_account; m.provider_mode:='TEST'; m.policy:='LEGACY'; m.epoch:=0;
  m.variant:=p_variant; m.amount:=p_amount::bigint; m.authorized_amount:=p.authorized_amount; m.payment_version:=p.version;
  m.scope_revision:=sr; m.intake_revision:=ir; m.transaction_id:=pg_current_xact_id(); m.backend_pid:=pg_backend_pid(); m.database_principal:=session_user;
  m.attempt_id:=gen_random_uuid(); m.outbox_id:=gen_random_uuid(); m.audit_id:=gen_random_uuid(); m.created_at:=stamp;
  bp:=to_jsonb(p); after_payment:=bp||jsonb_build_object('status','CAPTURE_PENDING','version',p.version+1,'updated_at',stamp);
  child:=jsonb_populate_record(NULL::public.payment_attempts,jsonb_build_object('id',m.attempt_id,'merchant_id',p.merchant_id,'payment_id',p.id,
    'kind','CAPTURE','status','PENDING','amount',m.amount,'currency',p.currency,'provider_transaction_id',NULL,'failure_code',NULL,'created_at',stamp,'updated_at',stamp));
  payload:=jsonb_build_object('merchantId',p.merchant_id,'paymentId',p.id,'attemptId',m.attempt_id,'amount',m.amount,'currency',p.currency,
    'providerPaymentId',proof.payment_intent_id,'finalCapture',p_variant<>'FIRST_PARTIAL','idempotencyKey','capture:'||m.attempt_id::text);
  w:=jsonb_populate_record(NULL::public.outbox_events,jsonb_build_object('id',m.outbox_id,'aggregate_type','PAYMENT_ATTEMPT','aggregate_id',m.attempt_id,
    'event_type','provider.capture.requested','payload',payload,'status','PENDING','attempts',0,'available_at',stamp,'locked_at',NULL,
    'published_at',NULL,'last_error',NULL,'created_at',stamp,'updated_at',stamp));
  command:=jsonb_populate_record(NULL::public.provider_command_authorities,jsonb_build_object('outbox_id',m.outbox_id,'provider',r.provider,
    'provider_account',r.provider_account,'provider_mode','TEST','operation','CAPTURE','operation_id',m.attempt_id,'payment_id',p.id,
    'merchant_id',p.merchant_id,'currency',p.currency,'amount',m.amount,'command_key','capture:'||m.attempt_id::text,'command_payload',payload,
    'accounting_policy','LEGACY','acceptance_epoch',0,'accepted_at',now()));
  audit:=jsonb_populate_record(NULL::public.audit_logs,jsonb_build_object('id',m.audit_id,'merchant_id',p.merchant_id,'actor_type','FIXTURE',
    'actor_id',session_user,'action','payment.capture_requested','target_type','payment','target_id',p.id::text,'correlation_id',NULL,
    'metadata',jsonb_build_object('intentId',m.id,'authRootId',r.id,'attemptId',m.attempt_id,'outboxId',m.outbox_id,'amount',m.amount,'variant',p_variant),'created_at',stamp));
  acceptance:=jsonb_populate_record(NULL::public.first_capture_intent_acceptances,jsonb_build_object('manifest_id',m.id,'request_id',q.id,
    'auth_root_id',r.id,'payment_id',p.id,'merchant_id',p.merchant_id,'currency',p.currency,'status_code',202,
    'response_body',jsonb_build_object('paymentId',p.id,'attemptId',m.attempt_id,'status','CAPTURE_PENDING','amount',m.amount),
    'prior_revision',sr,'final_revision',sr+1,'created_at',stamp));
  m.source_manifest:=jsonb_build_object('request',to_jsonb(q),'auth_root',to_jsonb(r),'auth_manifest',to_jsonb(auth),'auth_proof',to_jsonb(proof),'payment_before',bp);
  m.effect_manifest:=jsonb_build_array(jsonb_build_object('table','payments','id',p.id,'write','UPDATE','before',bp,'after',after_payment),
    jsonb_build_object('table','payment_attempts','id',m.attempt_id,'write','INSERT','after',to_jsonb(child)),
    jsonb_build_object('table','outbox_events','id',m.outbox_id,'write','INSERT','after',to_jsonb(w)),
    jsonb_build_object('table','provider_command_authorities','id',m.outbox_id,'write','INSERT','after',to_jsonb(command)),
    jsonb_build_object('table','audit_logs','id',m.audit_id,'write','INSERT','after',to_jsonb(audit)),
    jsonb_build_object('table','first_capture_intent_acceptances','id',m.id,'write','INSERT','after',to_jsonb(acceptance)));
  INSERT INTO public.first_capture_intent_manifests SELECT m.*;
  INSERT INTO public.financial_application_permits(transaction_id,backend_pid,manifest_id,database_principal,permit_kind,intent_manifest_id)
    VALUES(pg_current_xact_id(),pg_backend_pid(),NULL,session_user,'CAPTURE_INTENT',m.id);
  RETURN m.id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.first_capture_intent_record_owners(p_relation text,p_row jsonb)
RETURNS TABLE(merchant_id uuid,currency text,payment_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; child uuid; intent uuid; root uuid; linked_outbox uuid;
BEGIN
  IF p_row IS NULL THEN RETURN; END IF;
  target:=CASE WHEN pg_input_is_valid(p_row->>'payment_id','uuid') THEN (p_row->>'payment_id')::uuid END;
  child:=CASE WHEN pg_input_is_valid(p_row->>'operation_id','uuid') THEN (p_row->>'operation_id')::uuid END;
  IF p_relation='payments' THEN target:=(p_row->>'id')::uuid;
  ELSIF p_relation='payment_attempts' THEN child:=(p_row->>'id')::uuid;
  ELSIF p_relation='outbox_events' THEN
    child:=CASE WHEN pg_input_is_valid(p_row->>'aggregate_id','uuid') THEN (p_row->>'aggregate_id')::uuid END;
    RETURN QUERY SELECT p.merchant_id,p.currency,p.id FROM public.payments p WHERE p.id=child;
    RETURN QUERY SELECT p.merchant_id,p.currency,p.id FROM public.payments p
      WHERE p.id=CASE WHEN pg_input_is_valid(p_row#>>'{payload,paymentId}','uuid') THEN (p_row#>>'{payload,paymentId}')::uuid END;
    RETURN QUERY SELECT t.merchant_id,t.currency,t.payment_id FROM public.payment_attempts t
      WHERE t.id=CASE WHEN pg_input_is_valid(p_row#>>'{payload,attemptId}','uuid') THEN (p_row#>>'{payload,attemptId}')::uuid END;
    RETURN QUERY SELECT m.merchant_id,m.currency,m.payment_id FROM public.first_capture_intent_manifests m WHERE m.outbox_id::text=p_row->>'id';
  ELSIF p_relation='audit_logs' THEN
    target:=CASE WHEN pg_input_is_valid(p_row->>'target_id','uuid') THEN (p_row->>'target_id')::uuid END;
    child:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,attemptId}','uuid') THEN (p_row#>>'{metadata,attemptId}')::uuid END;
    intent:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,intentId}','uuid') THEN (p_row#>>'{metadata,intentId}')::uuid END;
    root:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,authRootId}','uuid') THEN (p_row#>>'{metadata,authRootId}')::uuid END;
    linked_outbox:=CASE WHEN pg_input_is_valid(p_row#>>'{metadata,outboxId}','uuid') THEN (p_row#>>'{metadata,outboxId}')::uuid END;
    RETURN QUERY SELECT owners.merchant_id,owners.currency,owners.payment_id FROM public.outbox_events o
      CROSS JOIN LATERAL public.first_capture_intent_record_owners('outbox_events',to_jsonb(o)) owners WHERE o.id=linked_outbox;
    RETURN QUERY SELECT m.merchant_id,m.currency,m.payment_id FROM public.first_capture_intent_manifests m WHERE m.id=intent OR m.audit_id::text=p_row->>'id';
    RETURN QUERY SELECT r.merchant_id,r.currency,r.payment_id FROM public.financial_application_roots r WHERE r.id=root;
  END IF;
  RETURN QUERY SELECT p.merchant_id,p.currency,p.id FROM public.payments p WHERE p.id=target;
  RETURN QUERY SELECT t.merchant_id,t.currency,t.payment_id FROM public.payment_attempts t WHERE t.id=child;
  RETURN QUERY SELECT p.merchant_id,p.currency,p.id FROM public.payment_attempts t JOIN public.payments p ON p.id=t.payment_id WHERE t.id=child;
  RETURN QUERY SELECT r.merchant_id,r.currency,r.payment_id FROM public.financial_application_roots r WHERE r.operation_id=child;
  RETURN QUERY SELECT (p_row->>'merchant_id')::uuid,p_row->>'currency',target WHERE p_row->>'merchant_id' IS NOT NULL;
END $$;

CREATE FUNCTION public.check_first_capture_intent_write(p_relation text,p_operation text,p_new jsonb,p_old jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE; identity text;
BEGIN
  m:=public.current_first_capture_intent();
  identity:=CASE p_relation WHEN 'provider_command_authorities' THEN p_new->>'outbox_id'
    WHEN 'first_capture_intent_acceptances' THEN p_new->>'manifest_id' ELSE p_new->>'id' END;
  IF p_operation='DELETE' OR p_relation NOT IN ('payments','payment_attempts','outbox_events','provider_command_authorities','audit_logs','first_capture_intent_acceptances')
    OR EXISTS(SELECT 1 FROM (VALUES(p_new),(p_old)) v(body)
      CROSS JOIN LATERAL public.first_capture_intent_record_owners(p_relation,v.body) owners
      WHERE (owners.merchant_id IS NOT NULL AND owners.merchant_id IS DISTINCT FROM m.merchant_id)
        OR (owners.currency IS NOT NULL AND owners.currency IS DISTINCT FROM m.currency)
        OR (owners.payment_id IS NOT NULL AND owners.payment_id IS DISTINCT FROM m.payment_id))
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=p_relation AND x->>'id'=identity
      AND x->>'write'=p_operation AND x->'after'=p_new AND (p_operation='INSERT' OR x->'before'=p_old)) THEN
    RAISE EXCEPTION 'Exact owned SQL first capture intent write required'; END IF;
END $$;

CREATE FUNCTION public.guard_first_capture_intent_issuance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='financial_application_permits' AND to_jsonb(NEW)->>'permit_kind'='APPLICATION' THEN RETURN NEW; END IF;
  IF current_user<>'fintech_capture_intent_'||md5(current_database()) OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid() OR NEW.database_principal IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'Protected SQL capture intent issuance writer required'; END IF;
  IF TG_TABLE_NAME='financial_application_permits' THEN
    IF NEW.permit_kind IS DISTINCT FROM 'CAPTURE_INTENT' OR NEW.manifest_id IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM public.first_capture_intent_manifests m WHERE m.id=NEW.intent_manifest_id
        AND (m.transaction_id,m.backend_pid,m.database_principal)=(NEW.transaction_id,NEW.backend_pid,NEW.database_principal)) THEN
      RAISE EXCEPTION 'Exact SQL capture intent transaction permit required'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_first_capture_intent_record() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n jsonb; o jsonb; protected boolean;
BEGIN
  n:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='first_capture_intent_acceptances' THEN
    PERFORM public.check_first_capture_intent_write(TG_TABLE_NAME,TG_OP,n,o); RETURN NEW;
  END IF;
  SELECT EXISTS(SELECT 1 FROM (VALUES(n),(o)) v(body)
    CROSS JOIN LATERAL public.first_capture_intent_record_owners(TG_TABLE_NAME,v.body) owners
    WHERE public.first_capture_intent_scope_protected(owners.merchant_id,owners.currency)) INTO protected;
  IF NOT protected THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  IF TG_TABLE_NAME='audit_logs' AND n->>'action' IS DISTINCT FROM 'payment.capture_requested'
    AND NOT EXISTS(SELECT 1 FROM public.first_capture_intent_manifests m WHERE m.audit_id::text=n->>'id'
      OR m.id=CASE WHEN pg_input_is_valid(n#>>'{metadata,intentId}','uuid') THEN (n#>>'{metadata,intentId}')::uuid END) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  -- The accepted envelope is immutable; ordinary delivery bookkeeping remains usable.
  IF TG_TABLE_NAME='outbox_events' AND TG_OP='UPDATE'
    AND n-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at']
      =o-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at']
    AND EXISTS(SELECT 1 FROM public.provider_command_authorities a WHERE a.outbox_id::text=n->>'id'
      AND a.xmin::text<>pg_current_xact_id()::text) THEN RETURN NEW; END IF;
  PERFORM public.check_first_capture_intent_write(TG_TABLE_NAME,TG_OP,n,o);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE FUNCTION public.check_first_capture_intent_finality() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.first_capture_intent_manifests%ROWTYPE; actual jsonb; o jsonb; protected boolean; n jsonb:=to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME='first_capture_intent_requests' THEN
    SELECT * INTO STRICT m FROM public.first_capture_intent_manifests WHERE request_id=NEW.id;
  ELSIF TG_TABLE_NAME='first_capture_intent_manifests' THEN m:=NEW;
  ELSIF TG_TABLE_NAME='first_capture_intent_acceptances' THEN
    SELECT * INTO STRICT m FROM public.first_capture_intent_manifests WHERE id=NEW.manifest_id;
  ELSIF TG_TABLE_NAME='financial_application_permits' THEN
    IF NEW.permit_kind<>'CAPTURE_INTENT' THEN RETURN NULL; END IF;
    SELECT * INTO STRICT m FROM public.first_capture_intent_manifests WHERE id=NEW.intent_manifest_id;
  ELSE
    IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE %I=$1',TG_TABLE_NAME,
      CASE WHEN TG_TABLE_NAME='provider_command_authorities' THEN 'outbox_id' ELSE 'id' END)
      INTO actual USING CASE WHEN TG_TABLE_NAME='provider_command_authorities' THEN (n->>'outbox_id')::uuid ELSE (n->>'id')::uuid END;
    SELECT EXISTS(SELECT 1 FROM (VALUES(n),(o),(actual)) v(body)
      CROSS JOIN LATERAL public.first_capture_intent_record_owners(TG_TABLE_NAME,v.body) owners
      WHERE public.first_capture_intent_scope_protected(owners.merchant_id,owners.currency)) INTO protected;
    IF NOT protected THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME='audit_logs' AND n->>'action' IS DISTINCT FROM 'payment.capture_requested'
      AND NOT EXISTS(SELECT 1 FROM public.first_capture_intent_manifests v WHERE v.audit_id::text=n->>'id'
        OR v.id=CASE WHEN pg_input_is_valid(n#>>'{metadata,intentId}','uuid') THEN (n#>>'{metadata,intentId}')::uuid END) THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME='outbox_events' AND TG_OP='UPDATE'
      AND n-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at']
        =o-ARRAY['status','attempts','available_at','locked_at','published_at','last_error','updated_at']
      AND EXISTS(SELECT 1 FROM public.provider_command_authorities a WHERE a.outbox_id::text=n->>'id'
        AND a.xmin::text<>pg_current_xact_id()::text) THEN
      SELECT * INTO m FROM public.first_capture_intent_manifests WHERE outbox_id=NEW.id;
      IF FOUND THEN PERFORM public.check_first_capture_intent(m.id,true,true); END IF;
      RETURN NULL;
    END IF;
    m:=public.current_first_capture_intent();
  END IF;
  PERFORM public.check_first_capture_intent(m.id,true,false);
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['first_capture_intent_requests','first_capture_intent_manifests','first_capture_intent_acceptances'] LOOP
    EXECUTE format('CREATE TRIGGER first_capture_intent_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER first_capture_intent_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER first_capture_intent_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_first_capture_intent_finality()',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['first_capture_intent_requests','first_capture_intent_manifests','financial_application_permits'] LOOP
    EXECUTE format('CREATE TRIGGER first_capture_intent_issuer BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_first_capture_intent_issuance()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['outbox_events','provider_command_authorities','audit_logs','first_capture_intent_acceptances'] LOOP
    EXECUTE format('CREATE TRIGGER first_capture_intent_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_first_capture_intent_record()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['outbox_events','provider_command_authorities','audit_logs','financial_application_permits'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER first_capture_intent_complete AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_first_capture_intent_finality()',t);
  END LOOP;
END $$;

-- Narrow dispatch preserves the installed function OIDs, owners, ACL and old bodies.
DO $$ DECLARE d text; n text; branch text; BEGIN
  FOREACH n IN ARRAY ARRAY['guard_financial_application_effect','check_financial_application_effect_finality',
    'guard_manual_authorization_authority','check_manual_authorization_finality','current_financial_application_manifest'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT d FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=n;
    IF n='current_financial_application_manifest' THEN
      IF position('v.id=p.manifest_id' IN d)=0 THEN RAISE EXCEPTION 'Expected installed application permit reader'; END IF;
      d:=replace(d,'v.id=p.manifest_id','v.id=p.manifest_id AND p.permit_kind=''APPLICATION'' AND p.intent_manifest_id IS NULL');
    ELSE
      IF n='guard_manual_authorization_authority' THEN
        branch:=$b$IF TG_TABLE_NAME='financial_application_permits' AND to_jsonb(NEW)->>'permit_kind'='CAPTURE_INTENT' THEN RETURN NEW; END IF;$b$;
      ELSIF n='check_manual_authorization_finality' THEN
        branch:=$b$IF TG_TABLE_NAME='financial_application_permits' AND to_jsonb(NEW)->>'permit_kind'='CAPTURE_INTENT' THEN
          PERFORM public.check_first_capture_intent(NEW.intent_manifest_id,true,false); RETURN NULL; END IF;$b$;
      ELSIF n='guard_financial_application_effect' THEN
        branch:=$b$IF EXISTS(SELECT 1 FROM public.financial_application_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND permit_kind='CAPTURE_INTENT') THEN
          PERFORM public.check_first_capture_intent_write(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END);
          IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;$b$;
      ELSE
        branch:=$b$IF EXISTS(SELECT 1 FROM public.financial_application_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND permit_kind='CAPTURE_INTENT') THEN
          PERFORM public.check_first_capture_intent((public.current_first_capture_intent()).id,true,false); RETURN NULL; END IF;$b$;
      END IF;
      IF position(E'BEGIN\n' IN d)=0 THEN RAISE EXCEPTION 'Expected installed trigger body %',n; END IF;
      d:=overlay(d placing E'BEGIN\n  '||branch||E'\n' from position(E'BEGIN\n' IN d) for length(E'BEGIN\n'));
    END IF;
    EXECUTE d;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$ DECLARE writer text:='fintech_capture_intent_'||md5(current_database()); checker text:='fintech_capture_check_'||md5(current_database());
  admission text:='fintech_admission_'||md5(current_database()); application text:='fintech_application_'||md5(current_database());
  historian text:='fintech_manual_history_'||md5(current_database()); role_name text; f record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',role_name);
    EXECUTE format('GRANT SELECT ON public.first_capture_intent_requests,public.first_capture_intent_manifests,public.first_capture_intent_acceptances,
      public.financial_application_contracts,public.financial_application_scope_authority,public.financial_application_roots,public.financial_application_manifests,
      public.financial_applications,public.financial_application_dispositions,public.financial_application_permits,public.payment_operation_evidence,
      public.financial_evidence_accounts,public.capture_accounting_scopes,public.receipt_intake_authority,public.payments,public.payment_attempts,
      public.outbox_events,public.provider_command_authorities,public.audit_logs,public.capture_accounting_lots,public.refunds,public.disputes,public.ledger_transactions TO %I',role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.manual_authorization_history(uuid),public.manual_authorization_blocked(text,text,uuid,text,uuid,bigint,uuid),
      public.protect_financial_evidence() TO %I',role_name);
  END LOOP;
  EXECUTE format('GRANT INSERT ON public.first_capture_intent_requests,public.first_capture_intent_manifests,public.first_capture_intent_acceptances,
    public.financial_application_permits,public.payment_attempts,public.outbox_events,public.audit_logs TO %I',writer);
  EXECUTE format('GRANT UPDATE(created_at) ON public.first_capture_intent_requests,public.financial_evidence_accounts,public.capture_accounting_scopes,public.payment_attempts TO %I',writer);
  EXECUTE format('GRANT UPDATE(status,version,updated_at) ON public.payments TO %I',writer);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.accept_provider_command(uuid,text,text),public.advance_first_capture_intent_revision() TO %I',writer);
  EXECUTE format('GRANT SELECT ON public.first_capture_intent_manifests,public.first_capture_intent_acceptances,public.financial_application_permits TO %I',admission);
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'first_capture_intent_scope_protected','current_first_capture_intent','first_capture_intent_request','prepare_first_capture_intent','apply_first_capture_intent',
    'accept_first_capture_intent','check_first_capture_intent','validate_first_capture_intent','advance_first_capture_intent_revision',
    'first_capture_intent_record_owners','check_first_capture_intent_write','guard_first_capture_intent_issuance','guard_first_capture_intent_record','check_first_capture_intent_finality') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I,%I',f.signature,writer,checker);
    IF f.proname='advance_first_capture_intent_revision' THEN
      EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',admission);
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,admission);
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',admission);
    ELSE
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,CASE WHEN f.proname IN (
        'first_capture_intent_request','prepare_first_capture_intent','apply_first_capture_intent','accept_first_capture_intent') THEN writer ELSE checker END);
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_first_capture_intent(),public.check_first_capture_intent(uuid,boolean,boolean),
    public.check_first_capture_intent_write(text,text,jsonb,jsonb) TO %I,%I,%I',admission,application,historian);
  -- SECURITY INVOKER issuer needs only the manifest lookup used before insertion.
  EXECUTE format('GRANT SELECT ON public.first_capture_intent_manifests TO %I',historian);
  FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',role_name); END LOOP;
END $$;

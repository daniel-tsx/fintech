-- B2-A: transaction-local capture preparation only. No capture can COMMIT.
-- P-B/P-C/B1 remain the authority; no contract, enrollment or runtime grant.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.financial_application_roots IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.capture_preparation_issuances (
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, database_principal name NOT NULL,
  intent_manifest_id uuid NOT NULL REFERENCES public.first_capture_intent_manifests(id),
  root_id uuid NOT NULL UNIQUE REFERENCES public.financial_application_roots(id) DEFERRABLE INITIALLY DEFERRED,
  manifest_id uuid NOT NULL UNIQUE REFERENCES public.financial_application_manifests(id) DEFERRABLE INITIALLY DEFERRED,
  root_image jsonb NOT NULL, manifest_image jsonb NOT NULL,
  PRIMARY KEY(transaction_id,backend_pid)
);
CREATE TRIGGER capture_preparation_immutable BEFORE UPDATE OR DELETE ON public.capture_preparation_issuances
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence();
CREATE TRIGGER capture_preparation_truncate BEFORE TRUNCATE ON public.capture_preparation_issuances
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence();
REVOKE ALL ON public.capture_preparation_issuances FROM PUBLIC;

-- Reuse P-B's claim owner, immutable witness, issuance guard and deferred check.
-- This helper acquires a lease only; P-B's failure helper still accepts AUTH only.
CREATE FUNCTION public.claim_capture_preparation(p_inbox uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; generation integer;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Capture claim requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations o JOIN public.payment_operation_evidence e ON e.id=o.payment_operation_proof_id
    JOIN public.financial_application_scope_authority s ON (s.merchant_id,s.currency)=(e.merchant_id,e.currency)
    WHERE o.inbox_id=p_inbox AND o.disposition='AWAITING_APPLICATION' AND e.operation='payment.capture_succeeded' AND e.provider_mode='TEST'
      AND EXISTS(SELECT 1 FROM public.first_capture_intent_manifests c WHERE c.payment_id=e.payment_id AND c.attempt_id=e.attempt_id)
      AND (s.provider,s.provider_account,s.policy,s.epoch,s.admission_mode)=(e.provider,e.provider_account,'LEGACY',0,'DORMANT')) THEN
    RAISE EXCEPTION 'Bound private CAPTURE obligation required'; END IF;
  INSERT INTO public.manual_authorization_claim_writes(transaction_id,backend_pid,database_principal,inbox_id,operation,before_image,after_image)
    VALUES(pg_current_xact_id(),pg_backend_pid(),session_user,p_inbox,'CLAIM',to_jsonb(w),
      to_jsonb(w)||jsonb_build_object('status','PROCESSING','attempts',w.attempts+1,'locked_at',now(),'updated_at',now()));
  UPDATE public.webhook_events SET status='PROCESSING',attempts=attempts+1,locked_at=now(),updated_at=now()
    WHERE id=p_inbox AND attempts<8 AND available_at<=now()
      AND (status IN ('PENDING','RETRY') OR (status='PROCESSING' AND locked_at<now()-interval '2 minutes')) RETURNING attempts INTO generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capture inbox is not claimable'; END IF;
  RETURN generation;
END $$;

-- No source is cleared here. Equivalence is local to preparation, not spending.
CREATE FUNCTION public.capture_preparation_sources(e public.payment_operation_evidence) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o record; peer public.payment_operation_evidence%ROWTYPE; checked jsonb;
  receipts jsonb:='[]'; sources jsonb:='[]'; auth jsonb:='[]';
BEGIN
  FOR o IN SELECT * FROM public.receipt_admission_obligations b WHERE
    ((b.provider=e.provider AND b.provider_account=e.provider_account AND b.merchant_id IS NULL AND b.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
      OR (b.merchant_id=e.merchant_id AND b.currency=e.currency AND b.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
    ORDER BY b.inbox_id LOOP
    IF o.disposition='AWAITING_APPLICATION' AND public.manual_authorization_cause_cleared(o.inbox_id,o.obligation_revision,NULL) THEN
      auth:=auth||jsonb_build_array(to_jsonb(o)); CONTINUE; END IF;
    IF o.disposition<>'AWAITING_APPLICATION' OR o.operation IS DISTINCT FROM 'payment.capture_succeeded' OR o.payment_operation_proof_id IS NULL
      OR o.proof_revision IS NOT NULL OR o.review_id IS NOT NULL THEN RAISE EXCEPTION 'Capture preparation blocked by independent receipt'; END IF;
    peer:=public.load_effective_payment_operation_evidence(o.inbox_id,1,'payment.capture_succeeded');
    IF (peer.id,peer.payment_id,peer.merchant_id,peer.currency) IS DISTINCT FROM (o.payment_operation_proof_id,o.payment_id,o.merchant_id,o.currency)
      OR (peer.outbox_id,peer.attempt_id,peer.provider,peer.provider_account,peer.provider_mode,peer.payment_id,peer.merchant_id,peer.currency,
        peer.payment_intent_id,peer.charge_id,peer.capture_principal,peer.outcome,peer.authorization_source_id,peer.accounting_policy,peer.acceptance_epoch)
      IS DISTINCT FROM (e.outbox_id,e.attempt_id,e.provider,e.provider_account,e.provider_mode,e.payment_id,e.merchant_id,e.currency,
        e.payment_intent_id,e.charge_id,e.capture_principal,e.outcome,e.authorization_source_id,e.accounting_policy,e.acceptance_epoch)
      OR peer.facts->'final_capture' IS DISTINCT FROM e.facts->'final_capture' THEN
      RAISE EXCEPTION 'Capture preparation requires exact equivalent receipt'; END IF;
    receipts:=receipts||jsonb_build_array(jsonb_build_object('obligation',to_jsonb(o),'proof_id',peer.id,'fingerprint',encode(peer.fingerprint,'hex')));
  END LOOP;
  FOR o IN SELECT b.*,s.outbox_id,s.source_kind FROM public.provider_observation_obligations b JOIN public.provider_observation_sources s ON s.id=b.source_id WHERE
    ((b.provider=e.provider AND b.provider_account=e.provider_account AND b.merchant_id IS NULL AND b.disposition='BLOCKING_REVIEW')
      OR (b.merchant_id=e.merchant_id AND b.currency=e.currency AND b.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
    ORDER BY b.source_id LOOP
    IF o.disposition='AWAITING_APPLICATION' AND public.manual_authorization_cause_cleared(NULL,NULL,o.source_id) THEN
      auth:=auth||jsonb_build_array(to_jsonb(o)); CONTINUE; END IF;
    IF (o.outbox_id,o.source_kind,o.disposition,o.reason,o.provider,o.provider_account,o.merchant_id,o.currency)
      IS DISTINCT FROM (e.outbox_id,'COMMAND_RESULT','BLOCKING_REVIEW','CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED',e.provider,e.provider_account,e.merchant_id,e.currency) THEN
      RAISE EXCEPTION 'Capture preparation blocked by independent provider source'; END IF;
    checked:=public.checked_payment_command_source(o.source_id);
    IF checked->'object' IS DISTINCT FROM e.facts#>'{source,object}' THEN RAISE EXCEPTION 'Capture response is not equivalent'; END IF;
    sources:=sources||jsonb_build_array(jsonb_build_object('obligation',to_jsonb(o),'source',checked));
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipts) x WHERE x#>>'{obligation,inbox_id}'=e.inbox_id::text)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) x WHERE x#>>'{obligation,source_id}'=e.source_id::text)
    OR EXISTS(SELECT 1 FROM public.provider_observation_sources s JOIN public.provider_command_authorities a ON a.outbox_id=s.outbox_id
      WHERE a.provider=e.provider AND a.provider_account=e.provider_account AND a.merchant_id=e.merchant_id AND a.currency=e.currency
        AND (NOT EXISTS(SELECT 1 FROM public.provider_observation_obligations b WHERE b.source_id=s.id)
          OR (a.outbox_id=e.outbox_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) x WHERE x#>>'{obligation,source_id}'=s.id::text))))
    OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers b WHERE (b.provider=e.provider AND b.provider_account=e.provider_account AND b.merchant_id IS NULL)
      OR (b.merchant_id=e.merchant_id AND b.currency=e.currency))
    OR EXISTS(SELECT 1 FROM public.accounting_exceptions WHERE merchant_id=e.merchant_id AND currency=e.currency AND status='OPEN') THEN
    RAISE EXCEPTION 'Capture preparation has unresolved evidence or exception'; END IF;
  RETURN jsonb_build_object('receipts',receipts,'sources',sources,'authorization_causes',auth);
END $$;

CREATE FUNCTION public.prepare_capture_application(p_intent uuid,p_inbox uuid,p_proof uuid,p_generation integer,
  p_obligation bigint,p_scope bigint,p_intake bigint) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE intent public.first_capture_intent_manifests%ROWTYPE; e public.payment_operation_evidence%ROWTYPE;
  a public.provider_command_authorities%ROWTYPE; p public.payments%ROWTYPE; t public.payment_attempts%ROWTYPE; w public.webhook_events%ROWTYPE;
  o public.receipt_admission_obligations%ROWTYPE; r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE;
  auth public.financial_application_manifests%ROWTYPE; auth_proof public.payment_operation_evidence%ROWTYPE; terms public.merchants%ROWTYPE;
  sr bigint; ir bigint; gross numeric; cumulative numeric; fee numeric; net numeric; product numeric; uncapped numeric;
  stamp timestamptz:=now(); journal uuid:=gen_random_uuid(); lot uuid:=gen_random_uuid(); audit uuid:=gen_random_uuid();
  inventory jsonb; lines jsonb; effects jsonb; src jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Capture preparation requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF w.status<>'PROCESSING' OR w.attempts IS DISTINCT FROM p_generation OR p_generation<1
    OR NOT EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c WHERE c.inbox_id=p_inbox AND c.operation='CLAIM'
      AND c.database_principal=session_user AND c.after_image=to_jsonb(w)) THEN RAISE EXCEPTION 'Current genuine capture claim required'; END IF;
  SELECT * INTO STRICT intent FROM public.first_capture_intent_manifests WHERE id=p_intent;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=intent.provider AND provider_account=intent.provider_account AND provider_mode='TEST' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured TEST capture account required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(intent.merchant_id::text||':'||intent.currency,0));
  SELECT evidence_revision INTO STRICT sr FROM public.capture_accounting_scopes WHERE merchant_id=intent.merchant_id AND currency=intent.currency FOR NO KEY UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=intent.merchant_id AND currency=intent.currency
    AND (provider,provider_account,policy,epoch,admission_mode)=(intent.provider,intent.provider_account,'LEGACY',0,'DORMANT')) THEN
    RAISE EXCEPTION 'Exact DORMANT capture authority required'; END IF;
  SELECT coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=intent.provider AND provider_account=intent.provider_account),0) INTO ir;
  IF (sr,ir) IS DISTINCT FROM (p_scope,p_intake) THEN RAISE EXCEPTION 'Stale capture preparation evidence revisions'; END IF;
  PERFORM 1 FROM public.payments WHERE id=intent.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=intent.payment_id ORDER BY id FOR UPDATE;
  IF NOT public.check_first_capture_intent(intent.id,true,true) THEN RAISE EXCEPTION 'Complete accepted first capture required'; END IF;
  SELECT * INTO STRICT p FROM public.payments WHERE id=intent.payment_id;
  SELECT * INTO STRICT t FROM public.payment_attempts WHERE id=intent.attempt_id;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=intent.outbox_id;
  SELECT v.* INTO STRICT auth FROM public.financial_applications app JOIN public.financial_application_manifests v ON v.id=app.manifest_id WHERE app.root_id=intent.auth_root_id;
  SELECT * INTO STRICT auth_proof FROM public.payment_operation_evidence WHERE id=auth.payment_operation_proof_id;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='CAPTURE' AND phase='TERMINAL' AND policy='LEGACY' AND version=1
    AND prepare_function='public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure
    AND validate_function='public.validate_capture_preparation(uuid)'::regprocedure) THEN RAISE EXCEPTION 'Exact closed capture preparation contract required'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_application_permits WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()) THEN
    RAISE EXCEPTION 'One protected operation per transaction'; END IF;
  e:=public.load_effective_payment_operation_evidence(p_inbox,1,'payment.capture_succeeded');
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF (e.id,e.outbox_id,e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.provider_mode,e.capture_principal,e.accounting_policy,e.acceptance_epoch,e.outcome,e.authorization_source_id)
      IS DISTINCT FROM (p_proof,intent.outbox_id,intent.attempt_id,intent.payment_id,intent.merchant_id,intent.currency,intent.provider,intent.provider_account,'TEST',intent.amount,'LEGACY',0::bigint,'CAPTURE_SUCCEEDED',auth_proof.source_id)
    OR (e.payment_intent_id,e.charge_id,e.facts->'authorized_capacity',e.facts->'final_capture')
      IS DISTINCT FROM (auth_proof.payment_intent_id,auth_proof.charge_id,to_jsonb(intent.authorized_amount),to_jsonb(intent.variant<>'FIRST_PARTIAL'))
    OR (o.obligation_revision,o.disposition,o.payment_operation_proof_id,o.payment_id,o.merchant_id,o.currency,o.provider,o.provider_account,o.operation)
      IS DISTINCT FROM (p_obligation,'AWAITING_APPLICATION',e.id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,'payment.capture_succeeded')
    OR o.proof_revision IS NOT NULL OR o.review_id IS NOT NULL OR o.scope_evidence_revision>sr OR o.intake_evidence_revision>ir THEN
    RAISE EXCEPTION 'Exact owned capture proof and obligation required'; END IF;
  IF to_jsonb(p) IS DISTINCT FROM intent.effect_manifest#>'{0,after}' OR to_jsonb(t) IS DISTINCT FROM intent.effect_manifest#>'{1,after}'
    OR p.status<>'CAPTURE_PENDING' OR p.capture_method<>'MANUAL' OR p.captured_amount<>0 OR p.platform_fee_amount<>0 OR p.refunded_amount<>0 OR p.captured_at IS NOT NULL
    OR t.status<>'PENDING' OR (SELECT count(*) FROM public.payment_attempts WHERE payment_id=p.id)<>2
    OR (SELECT count(*) FROM public.provider_command_authorities WHERE payment_id=p.id)<>2
    OR (SELECT count(*) FROM public.financial_application_roots WHERE payment_id=p.id)<>1
    OR EXISTS(SELECT 1 FROM public.capture_accounting_lots WHERE payment_id=p.id) OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.disputes WHERE payment_id=p.id) OR EXISTS(SELECT 1 FROM public.settlement_items WHERE payment_id=p.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions j CROSS JOIN LATERAL public.financial_application_effect_owners('ledger_transactions',to_jsonb(j)) owners
      WHERE owners.merchant_id=p.merchant_id AND owners.currency=p.currency AND j.business_id IN (SELECT id FROM public.payment_attempts WHERE payment_id=p.id))
    OR (SELECT count(*) FROM public.outbox_events b WHERE EXISTS(SELECT 1 FROM public.first_capture_intent_record_owners('outbox_events',to_jsonb(b)) owners WHERE owners.payment_id=p.id))<>2
    OR (SELECT count(*) FROM public.audit_logs b WHERE b.action='payment.capture_requested' AND EXISTS(
      SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',to_jsonb(b)) owners WHERE owners.payment_id=p.id))<>1
    OR EXISTS(SELECT 1 FROM public.audit_logs b WHERE b.action='payment.capture_succeeded' AND EXISTS(
      SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',to_jsonb(b)) owners WHERE owners.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Unapplied exact first capture with no other financial history required'; END IF;
  inventory:=public.capture_preparation_sources(e);
  -- One statement snapshot preserves existing application-time merchant terms.
  SELECT * INTO STRICT terms FROM public.merchants WHERE id=p.merchant_id;
  gross:=e.capture_principal; cumulative:=p.captured_amount::numeric+gross; product:=cumulative*terms.fee_bps;
  uncapped:=floor(product/10000)+terms.fixed_fee_minor; fee:=least(cumulative,uncapped)-p.platform_fee_amount; net:=gross-fee;
  IF gross<=0 OR gross>p.authorized_amount OR p.authorized_amount>9007199254740991 OR cumulative>p.authorized_amount
    OR terms.fee_bps NOT BETWEEN 0 AND 10000 OR terms.fixed_fee_minor NOT BETWEEN 0 AND 9007199254740991 OR terms.settlement_delay_days<0
    OR product NOT BETWEEN 0 AND 9007199254740991 OR uncapped NOT BETWEEN 0 AND 9007199254740991 OR fee NOT BETWEEN 0 AND gross OR net<0 THEN
    RAISE EXCEPTION 'Capture monetary plan is outside the exact compatible range'; END IF;
  lines:=jsonb_build_array(jsonb_build_object('code','PSP_CLEARING','owner',NULL,'type','ASSET','currency',p.currency,'debit',gross,'credit',0));
  IF net>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('code','MERCHANT_PENDING','owner',p.merchant_id,'type','LIABILITY','currency',p.currency,'debit',0,'credit',net)); END IF;
  IF fee>0 THEN lines:=lines||jsonb_build_array(jsonb_build_object('code','PLATFORM_FEE_REVENUE','owner',NULL,'type','REVENUE','currency',p.currency,'debit',0,'credit',fee)); END IF;
  r.id:=gen_random_uuid(); r.family:='CAPTURE'; r.operation_id:=a.operation_id; r.phase:='TERMINAL'; r.merchant_id:=a.merchant_id; r.currency:=a.currency;
  r.provider:=a.provider; r.provider_account:=a.provider_account; r.policy:=a.accounting_policy; r.acceptance_epoch:=a.acceptance_epoch;
  r.accepted_outbox_id:=a.outbox_id; r.payment_id:=a.payment_id; r.attempt_id:=a.operation_id; r.created_at:=stamp;
  effects:=jsonb_build_array(
    jsonb_build_object('kind','journal','id',journal,'business_type','CAPTURE','business_id',t.id,'currency',p.currency,'lines',lines,'posted_at',stamp),
    jsonb_build_object('kind','lot','id',lot,'capture_attempt_id',t.id,'journal_id',journal,'origin','NEW_CAPTURE','status','UNSETTLED','allocation_revision',0,
      'gross',gross,'fee',fee,'net',net,'financial_captured_at',stamp,'eligible_at',stamp+terms.settlement_delay_days*interval '24 hours'),
    jsonb_build_object('kind','payment','id',p.id,'captured_amount',cumulative,'platform_fee_amount',p.platform_fee_amount+fee,'status','CAPTURED','version',p.version+1,'captured_at',coalesce(p.captured_at,stamp)),
    jsonb_build_object('kind','attempt','id',t.id,'status','SUCCEEDED','provider_transaction_id',e.payment_intent_id),
    jsonb_build_object('kind','audit','id',audit,'action','payment.capture_succeeded','merchant_id',p.merchant_id,'payment_id',p.id,
      'attempt_id',t.id,'proof_id',e.id,'root_id',r.id,'journal_id',journal,'lot_id',lot,'gross',gross,'fee',fee,'net',net),
    jsonb_build_object('kind','finality','inbox_id',p_inbox,'generation',p_generation,'prior_scope_revision',sr,'final_scope_revision',sr+1,'coverage',inventory));
  src:=jsonb_build_object('contract','CAPTURE_PREPARATION_V1','executable',false,'database_principal',session_user,'intent',to_jsonb(intent),'proof',to_jsonb(e),
    'command',to_jsonb(a),'root',to_jsonb(r),'obligation',to_jsonb(o),'inventory',inventory,'payment_before',to_jsonb(p),'attempt_before',to_jsonb(t),'inbox_before',to_jsonb(w),
    'terms',jsonb_build_object('fee_bps',terms.fee_bps,'fixed_fee_minor',terms.fixed_fee_minor,'settlement_delay_days',terms.settlement_delay_days),
    'money',jsonb_build_object('C0',p.captured_amount,'F0',p.platform_fee_amount,'C1',cumulative,'F1',p.platform_fee_amount+fee,'gross',gross,'fee',fee,'net',net));
  m:=jsonb_populate_record(NULL::public.financial_application_manifests,jsonb_build_object('id',gen_random_uuid(),'root_id',r.id,
    'transaction_id',pg_current_xact_id(),'backend_pid',pg_backend_pid(),'inbox_id',p_inbox,'proof_revision',1,'proof_operation','payment.capture_succeeded',
    'claim_generation',p_generation,'merchant_id',p.merchant_id,'currency',p.currency,'payment_id',p.id,'policy','LEGACY','epoch',0,
    'scope_revision',sr,'intake_revision',ir,'contract_version',1,'result','POSTED','source_manifest',src,'effect_manifest',effects,'created_at',stamp,
    'proof_kind','PAYMENT_OPERATION_V1','payment_operation_proof_id',e.id));
  INSERT INTO public.capture_preparation_issuances VALUES(pg_current_xact_id(),pg_backend_pid(),session_user,intent.id,r.id,m.id,to_jsonb(r),to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id']);
  INSERT INTO public.financial_application_roots SELECT r.*;
  INSERT INTO public.financial_application_manifests(id,root_id,transaction_id,backend_pid,inbox_id,proof_revision,proof_operation,claim_generation,
    merchant_id,currency,payment_id,policy,epoch,scope_revision,intake_revision,contract_version,result,source_manifest,effect_manifest,created_at,proof_kind,payment_operation_proof_id)
    VALUES(m.id,r.id,m.transaction_id,m.backend_pid,m.inbox_id,1,m.proof_operation,m.claim_generation,m.merchant_id,m.currency,m.payment_id,m.policy,m.epoch,
      sr,ir,1,m.result,src,effects,stamp,m.proof_kind,m.payment_operation_proof_id);
  INSERT INTO public.financial_application_permits(transaction_id,backend_pid,manifest_id) VALUES(pg_current_xact_id(),pg_backend_pid(),m.id);
  RETURN m.id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.guard_capture_preparation_issuance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user<>'fintech_capture_prepare_'||md5(current_database()) OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid() OR NEW.database_principal IS DISTINCT FROM session_user
    OR NEW.root_image->>'id' IS DISTINCT FROM NEW.root_id::text OR NEW.root_image->>'family' IS DISTINCT FROM 'CAPTURE'
    OR NEW.manifest_image->>'id' IS DISTINCT FROM NEW.manifest_id::text OR NEW.manifest_image->>'root_id' IS DISTINCT FROM NEW.root_id::text
    OR NEW.manifest_image#>>'{source_manifest,intent,id}' IS DISTINCT FROM NEW.intent_manifest_id::text
    OR NEW.manifest_image#>>'{source_manifest,contract}' IS DISTINCT FROM 'CAPTURE_PREPARATION_V1'
    OR NEW.manifest_image->>'transaction_id' IS DISTINCT FROM NEW.transaction_id::text
    OR (NEW.manifest_image->>'backend_pid')::integer IS DISTINCT FROM NEW.backend_pid
    OR NEW.manifest_image#>>'{source_manifest,database_principal}' IS DISTINCT FROM NEW.database_principal::text THEN
    RAISE EXCEPTION 'Protected SQL capture preparation issuance required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_preparation_issuer BEFORE INSERT ON public.capture_preparation_issuances
  FOR EACH ROW EXECUTE FUNCTION public.guard_capture_preparation_issuance();

CREATE FUNCTION public.check_capture_preparation_record(p_relation text,n jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE; i public.capture_preparation_issuances%ROWTYPE;
BEGIN
  IF p_relation='financial_application_roots' THEN r:=jsonb_populate_record(NULL::public.financial_application_roots,n);
  ELSIF p_relation='financial_application_permits' THEN
    IF n->>'permit_kind'<>'APPLICATION' THEN RETURN false; END IF;
    SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=(n->>'manifest_id')::uuid;
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  ELSE SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=(n->>'root_id')::uuid; END IF;
  IF r.family<>'CAPTURE' OR NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=r.merchant_id AND currency=r.currency) THEN RETURN false; END IF;
  IF p_relation NOT IN ('financial_application_roots','financial_application_manifests','financial_application_permits') THEN
    RAISE EXCEPTION 'Capture final records closed before B2-B'; END IF;
  SELECT * INTO i FROM public.capture_preparation_issuances WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND database_principal=session_user AND root_id=r.id;
  -- Without our issuance, preserve the installed P-B refusal (including its contract).
  IF NOT FOUND THEN RETURN false; END IF;
  IF i.root_image IS DISTINCT FROM to_jsonb(r) THEN RAISE EXCEPTION 'Exact issued capture root required'; END IF;
  IF p_relation='financial_application_manifests' AND n-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM i.manifest_image THEN
    RAISE EXCEPTION 'Exact issued capture manifest required'; END IF;
  IF p_relation='financial_application_permits' AND ((n->>'manifest_id')::uuid IS DISTINCT FROM i.manifest_id
    OR (n->>'transaction_id')::xid8 IS DISTINCT FROM i.transaction_id OR (n->>'backend_pid')::integer IS DISTINCT FROM i.backend_pid
    OR n->>'database_principal' IS DISTINCT FROM i.database_principal::text OR n->>'permit_kind' IS DISTINCT FROM 'APPLICATION'
    OR n->>'intent_manifest_id' IS NOT NULL OR to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM i.manifest_image) THEN
    RAISE EXCEPTION 'Exact issued capture permit required'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.read_capture_preparation() RETURNS public.financial_application_manifests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; i public.capture_preparation_issuances%ROWTYPE;
BEGIN
  SELECT v.* INTO STRICT m FROM public.financial_application_permits p JOIN public.financial_application_manifests v ON v.id=p.manifest_id
    WHERE p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.database_principal=session_user
      AND p.permit_kind='APPLICATION' AND p.intent_manifest_id IS NULL;
  SELECT * INTO STRICT i FROM public.capture_preparation_issuances WHERE manifest_id=m.id AND transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND database_principal=session_user;
  IF to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM i.manifest_image
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.id=m.root_id AND to_jsonb(r)=i.root_image)
    OR NOT EXISTS(SELECT 1 FROM public.webhook_events w WHERE w.id=m.inbox_id AND w.status='PROCESSING' AND w.attempts=m.claim_generation AND to_jsonb(w)=m.source_manifest->'inbox_before')
    OR NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes WHERE merchant_id=m.merchant_id AND currency=m.currency AND evidence_revision=m.scope_revision)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=m.merchant_id AND currency=m.currency
      AND (policy,epoch,admission_mode)=('LEGACY',0,'DORMANT'))
    OR m.intake_revision IS DISTINCT FROM coalesce((SELECT evidence_revision FROM public.receipt_intake_authority
      WHERE provider=m.source_manifest#>>'{root,provider}' AND provider_account=m.source_manifest#>>'{root,provider_account}'),0) THEN
    RAISE EXCEPTION 'Stale or unissued capture preparation'; END IF;
  RETURN m;
END $$;

CREATE FUNCTION public.validate_capture_preparation(p_manifest uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Capture preparation cannot commit before B2-B complete validators'; END $$;

CREATE FUNCTION public.reject_capture_preparation_commit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='capture_preparation_issuances' THEN PERFORM public.validate_capture_preparation(NEW.manifest_id); END IF;
  IF TG_TABLE_NAME='financial_application_roots' THEN SELECT * INTO r FROM public.financial_application_roots WHERE id=NEW.id;
  ELSIF TG_TABLE_NAME='financial_application_manifests' THEN
    SELECT * INTO r FROM public.financial_application_roots WHERE id=NEW.root_id;
  ELSE
    IF NEW.permit_kind<>'APPLICATION' THEN RETURN NULL; END IF;
    SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=NEW.manifest_id;
    SELECT * INTO r FROM public.financial_application_roots WHERE id=m.root_id;
  END IF;
  IF r.family='CAPTURE' AND (EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=r.merchant_id AND currency=r.currency)
    OR EXISTS(SELECT 1 FROM public.capture_preparation_issuances WHERE root_id=r.id)) THEN PERFORM public.validate_capture_preparation(m.id); END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['capture_preparation_issuances','financial_application_roots','financial_application_manifests','financial_application_permits'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER capture_preparation_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_capture_preparation_commit()',t);
  END LOOP;
END $$;

-- Capture leases use P-B's exact bounded witness. All terminal/source effects stay closed.
CREATE FUNCTION public.guard_capture_preparation_write() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END; o jsonb; protected boolean;
BEGIN
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='webhook_events' THEN
    SELECT EXISTS(SELECT 1 FROM public.payment_operation_evidence e JOIN public.financial_application_scope_authority s USING(merchant_id,currency)
      JOIN public.first_capture_intent_manifests c ON c.payment_id=e.payment_id AND c.attempt_id=e.attempt_id
      WHERE e.inbox_id=(n->>'id')::uuid AND e.operation='payment.capture_succeeded') INTO protected;
    IF protected AND TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c WHERE c.transaction_id=pg_current_xact_id()
      AND c.backend_pid=pg_backend_pid() AND c.database_principal=session_user AND c.inbox_id=NEW.id AND c.operation='CLAIM' AND c.before_image=o AND c.after_image=n)
      AND n-ARRAY['status','attempts','locked_at','updated_at']=o-ARRAY['status','attempts','locked_at','updated_at']
      AND NEW.status='PROCESSING' AND NEW.attempts=OLD.attempts+1 AND OLD.attempts<8 AND OLD.available_at<=now()
      AND (OLD.status IN ('PENDING','RETRY') OR (OLD.status='PROCESSING' AND OLD.locked_at<now()-interval '2 minutes'))
      AND NEW.locked_at=now() AND NEW.updated_at=now() THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='financial_application_effect_links' THEN
    SELECT EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.id=(n->>'root_id')::uuid AND r.family='CAPTURE') INTO protected;
  ELSE
    SELECT EXISTS(SELECT 1 FROM (VALUES(n),(o)) images(body) CROSS JOIN LATERAL public.first_capture_intent_record_owners('audit_logs',images.body) owners
      JOIN public.financial_application_scope_authority s ON s.merchant_id=owners.merchant_id AND (owners.currency IS NULL OR s.currency=owners.currency)
      WHERE images.body->>'action'='payment.capture_succeeded')
      OR EXISTS(SELECT 1 FROM (VALUES(n),(o)) images(body) JOIN public.payment_operation_evidence e
        ON e.id=CASE WHEN pg_input_is_valid(images.body#>>'{metadata,proofId}','uuid') THEN (images.body#>>'{metadata,proofId}')::uuid END
        JOIN public.financial_application_scope_authority s USING(merchant_id,currency) WHERE e.operation='payment.capture_succeeded')
      OR EXISTS(SELECT 1 FROM (VALUES(n),(o)) images(body) JOIN public.financial_application_roots r
        ON r.id=CASE WHEN pg_input_is_valid(images.body#>>'{metadata,rootId}','uuid') THEN (images.body#>>'{metadata,rootId}')::uuid END
        JOIN public.financial_application_scope_authority s USING(merchant_id,currency) WHERE r.family='CAPTURE') INTO protected;
  END IF;
  IF protected THEN RAISE EXCEPTION 'Capture final writes closed before B2-B'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_events','audit_logs','financial_application_effect_links'] LOOP
    EXECUTE format('CREATE TRIGGER capture_preparation_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_capture_preparation_write()',t);
  END LOOP;
END $$;

-- Preserve installed OIDs/owners/ACLs and REFUND/AUTH/intent bodies; prepend only closed CAPTURE dispatch.
DO $$ DECLARE d text; branch text; BEGIN
  SELECT pg_get_functiondef('public.guard_manual_authorization_authority()'::regprocedure) INTO d;
  branch:=$b$IF public.check_capture_preparation_record(TG_TABLE_NAME,to_jsonb(NEW)) THEN RETURN NEW; END IF;$b$;
  IF position(E'BEGIN\n' IN d)=0 OR position('Enrolled CAPTURE/VOID application authority is not installed' IN d)=0 THEN RAISE EXCEPTION 'Expected installed P-B authority guard'; END IF;
  EXECUTE overlay(d placing E'BEGIN\n  '||branch||E'\n' from position(E'BEGIN\n' IN d) for length(E'BEGIN\n'));
  SELECT pg_get_functiondef('public.current_financial_application_manifest()'::regprocedure) INTO d;
  branch:='SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;';
  IF length(d)-length(replace(d,branch,''))<>length(branch) THEN RAISE EXCEPTION 'Expected installed application reader'; END IF;
  EXECUTE replace(d,branch,branch||E'\n  IF r.family=''CAPTURE'' THEN RAISE EXCEPTION ''Capture financial consumption closed before B2-B''; END IF;');
END $$;
--> statement-breakpoint

DO $$ DECLARE writer text:='fintech_capture_prepare_'||md5(current_database()); checker text:='fintech_capture_check_'||md5(current_database());
  claimer text:='fintech_manual_claim_'||md5(current_database()); historian text:='fintech_manual_history_'||md5(current_database()); role_name text; f record;
BEGIN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',writer);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',writer);
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',checker);
  FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP
    EXECUTE format('GRANT SELECT ON public.capture_preparation_issuances,public.first_capture_intent_manifests,public.financial_application_roots,
      public.financial_application_manifests,public.financial_application_permits,public.financial_applications,public.financial_application_scope_authority,
      public.financial_application_contracts,public.financial_evidence_accounts,public.receipt_intake_authority,public.capture_accounting_scopes,
      public.payments,public.payment_attempts,public.merchants,public.payment_operation_evidence,public.receipt_admission_obligations,
      public.provider_command_authorities,public.provider_observation_sources,public.provider_observation_obligations,public.receipt_delivery_barriers,
      public.accounting_exceptions,public.webhook_events,public.manual_authorization_claim_writes,public.capture_accounting_lots,public.refunds,
      public.disputes,public.ledger_transactions,public.settlement_items,public.audit_logs,public.outbox_events TO %I',role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.check_first_capture_intent(uuid,boolean,boolean),public.first_capture_intent_record_owners(text,jsonb),
      public.manual_authorization_cause_cleared(uuid,bigint,uuid),public.load_effective_payment_operation_evidence(uuid,integer,text),
      public.checked_payment_command_source(uuid),public.provider_form(bytea),public.provider_form_component(text),public.payment_json(bytea),
      public.check_payment_json(json),public.payment_minor(jsonb,text),public.financial_application_effect_owners(text,jsonb) TO %I',role_name);
  END LOOP;
  EXECUTE format('GRANT INSERT ON public.capture_preparation_issuances,public.financial_application_roots,public.financial_application_manifests,public.financial_application_permits TO %I',writer);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts,public.capture_accounting_scopes,public.payments,public.payment_attempts TO %I',writer);
  EXECUTE format('GRANT UPDATE(updated_at) ON public.webhook_events TO %I',writer);
  EXECUTE format('GRANT SELECT ON public.first_capture_intent_manifests TO %I',claimer);
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('claim_capture_preparation','capture_preparation_sources','prepare_capture_application','guard_capture_preparation_issuance','check_capture_preparation_record',
      'read_capture_preparation','validate_capture_preparation','reject_capture_preparation_commit','guard_capture_preparation_write') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    IF f.proname='claim_capture_preparation' THEN
      EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',claimer);
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,claimer);
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',claimer);
    ELSE
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,CASE WHEN f.proname='prepare_capture_application' THEN writer ELSE checker END);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,writer);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.check_capture_preparation_record(text,jsonb) TO %I',historian);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I,%I',writer,checker);
END $$;

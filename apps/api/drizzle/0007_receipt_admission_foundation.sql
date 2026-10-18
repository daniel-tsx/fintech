-- B3.2 B.2-R0 ONLY. Drain writers; install transactionally. No runtime grants,
-- ACTIVE scopes, financial writer, proof-version opening or historical backfill.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.capture_accounting_scopes IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.capture_accounting_scopes ADD COLUMN evidence_revision bigint NOT NULL DEFAULT 0 CHECK (evidence_revision>=0);
--> statement-breakpoint
CREATE TABLE public.receipt_intake_authority (
  provider text NOT NULL, provider_account text NOT NULL,
  evidence_revision bigint NOT NULL DEFAULT 0 CHECK (evidence_revision>=0),
  PRIMARY KEY (provider,provider_account),
  FOREIGN KEY (provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account)
);
-- This immutable enrollment identifies the R1 contract. A bare B.1 receipt is
-- not an R1 admission. The future trusted publisher gets EXECUTE on the atomic
-- publisher below, never INSERT on receipts/enrollments/obligations.
CREATE TABLE public.receipt_admissions (
  inbox_id uuid PRIMARY KEY REFERENCES public.provider_financial_receipts(inbox_id),
  provider text NOT NULL, provider_account text NOT NULL,
  contract_version integer NOT NULL CHECK (contract_version=1),
  operation text NOT NULL, financially_relevant boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbox_id,provider,provider_account,operation),
  FOREIGN KEY (provider,provider_account) REFERENCES public.receipt_intake_authority(provider,provider_account)
);
CREATE TABLE public.receipt_admission_obligations (
  inbox_id uuid PRIMARY KEY, provider text NOT NULL, provider_account text NOT NULL, operation text NOT NULL,
  merchant_id uuid, currency text, payment_id uuid, proof_revision integer,
  disposition text NOT NULL CHECK (disposition IN ('AWAITING_CONFIRMATION','AWAITING_CORRELATION','AWAITING_APPLICATION','BLOCKING_REVIEW','CLEARED_APPLICATION','CLEARED_NO_EFFECT')),
  obligation_revision bigint NOT NULL DEFAULT 0 CHECK (obligation_revision>=0),
  scope_evidence_revision bigint, intake_evidence_revision bigint NOT NULL CHECK (intake_evidence_revision>=0),
  review_id uuid REFERENCES public.financial_evidence_reviews(id), resolution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  FOREIGN KEY (inbox_id,provider,provider_account,operation) REFERENCES public.receipt_admissions(inbox_id,provider,provider_account,operation),
  FOREIGN KEY (merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  FOREIGN KEY (inbox_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency),
  CHECK ((merchant_id IS NULL AND currency IS NULL AND payment_id IS NULL AND proof_revision IS NULL AND scope_evidence_revision IS NULL)
    OR (merchant_id IS NOT NULL AND currency IS NOT NULL AND payment_id IS NOT NULL AND proof_revision=1 AND scope_evidence_revision>=1) IS TRUE),
  CHECK ((disposition IN ('AWAITING_CONFIRMATION','AWAITING_CORRELATION') AND merchant_id IS NULL)
    OR disposition='BLOCKING_REVIEW' OR (disposition IN ('AWAITING_APPLICATION','CLEARED_APPLICATION','CLEARED_NO_EFFECT') AND merchant_id IS NOT NULL)),
  CHECK ((disposition IN ('CLEARED_APPLICATION','CLEARED_NO_EFFECT') AND resolved_at IS NOT NULL AND resolution_id IS NOT NULL)
    OR (disposition NOT IN ('CLEARED_APPLICATION','CLEARED_NO_EFFECT') AND resolved_at IS NULL AND resolution_id IS NULL)),
  CHECK ((disposition='BLOCKING_REVIEW')=(review_id IS NOT NULL)),
  CHECK ((operation='refund.pending' AND disposition IN ('AWAITING_CONFIRMATION','BLOCKING_REVIEW'))
    OR (operation<>'refund.pending' AND disposition<>'AWAITING_CONFIRMATION'))
);
CREATE INDEX receipt_unknown_blockers ON public.receipt_admission_obligations(provider,provider_account)
  WHERE merchant_id IS NULL AND disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW');
CREATE INDEX receipt_scope_blockers ON public.receipt_admission_obligations(merchant_id,currency)
  WHERE disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW');
CREATE TABLE public.receipt_obligation_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inbox_id uuid NOT NULL UNIQUE REFERENCES public.receipt_admission_obligations(inbox_id),
  kind text NOT NULL CHECK (kind IN ('APPLICATION','NO_EFFECT')),
  proof_revision integer NOT NULL, payment_id uuid NOT NULL, merchant_id uuid NOT NULL, currency text NOT NULL,
  operation text NOT NULL, journal_id uuid REFERENCES public.ledger_transactions(id), audit_id uuid NOT NULL REFERENCES public.audit_logs(id),
  financial_reference jsonb NOT NULL CHECK (jsonb_typeof(financial_reference)='object'),
  database_principal name NOT NULL DEFAULT session_user, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,inbox_id),
  FOREIGN KEY (inbox_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency)
);
ALTER TABLE public.receipt_admission_obligations ADD CONSTRAINT receipt_resolution_owner
  FOREIGN KEY (resolution_id,inbox_id) REFERENCES public.receipt_obligation_resolutions(id,inbox_id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION public.protect_receipt_admission_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Receipt admission authority cannot be removed'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.evidence_revision<>0 THEN RAISE EXCEPTION 'Initial evidence revision must be zero'; END IF;
  ELSE
    IF (TG_TABLE_NAME='capture_accounting_scopes' AND (to_jsonb(NEW)->'merchant_id',to_jsonb(NEW)->'currency')
          IS DISTINCT FROM (to_jsonb(OLD)->'merchant_id',to_jsonb(OLD)->'currency'))
      OR (TG_TABLE_NAME='receipt_intake_authority' AND (to_jsonb(NEW)->'provider',to_jsonb(NEW)->'provider_account')
          IS DISTINCT FROM (to_jsonb(OLD)->'provider',to_jsonb(OLD)->'provider_account')) THEN
      RAISE EXCEPTION 'Admission authority identity is immutable'; END IF;
    IF NEW.evidence_revision IS DISTINCT FROM OLD.evidence_revision AND
      (current_user<>'fintech_admission_'||md5(current_database()) OR NEW.evidence_revision<>OLD.evidence_revision+1) THEN
      RAISE EXCEPTION 'Evidence revision requires the guarded monotonic writer'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['capture_accounting_scopes','receipt_intake_authority'] LOOP
    EXECUTE format('CREATE TRIGGER receipt_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_receipt_admission_authority()',t);
    EXECUTE format('CREATE TRIGGER receipt_authority_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_receipt_admission_authority()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['receipt_admissions','receipt_obligation_resolutions'] LOOP
    EXECUTE format('CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER receipt_immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
  END LOOP;
END $$;
CREATE FUNCTION public.receipt_admission_facts(p_inbox uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE; b jsonb; o jsonb; op text;
  relevant boolean:=true; contradiction text;
BEGIN
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox;
  b:=convert_from(r.raw_body,'UTF8')::jsonb; o:=b#>'{data,object}';
  IF (r.provider,r.signature,r.headers,r.normalized_payload) IS DISTINCT FROM (w.provider,w.signature,w.headers,w.payload)
    OR b->>'id' IS DISTINCT FROM w.provider_event_id OR b->>'type' IS DISTINCT FROM w.payload->>'externalType'
    OR w.payload->>'id' IS DISTINCT FROM w.provider_event_id OR jsonb_typeof(o) IS DISTINCT FROM 'object'
    OR (b ? 'account' AND b->>'account' IS DISTINCT FROM r.provider_account) THEN RAISE EXCEPTION 'Admission must retain verified original receipt identity'; END IF;
  -- Only explicitly irrelevant customer lifecycle types are harmless here.
  -- Unclassified types retain a broad obligation; genuine pending refunds use
  -- nonblocking AWAITING_CONFIRMATION (Option A). Neither authorizes money.
  IF b->>'type' IN ('customer.created','customer.updated','customer.deleted') THEN
    IF w.payload->>'type' IS DISTINCT FROM 'provider.unsupported' OR w.payload->'data' IS DISTINCT FROM 'null'::jsonb THEN
      contradiction:='Unrelated admission classification contradicts normalized financial evidence';
      op:='provider.unclassified';
    ELSE op:='provider.unrelated'; relevant:=false; END IF;
  ELSIF b->>'type' IN ('refund.created','refund.updated','refund.failed') AND o->>'object'='refund' THEN
    op:=CASE WHEN o->>'status'='succeeded' AND b->>'type'<>'refund.failed' THEN 'refund.succeeded'
      WHEN o->>'status' IN ('failed','canceled') THEN 'refund.failed'
      WHEN o->>'status' IN ('pending','requires_action') AND b->>'type'<>'refund.failed' THEN 'refund.pending'
      ELSE 'provider.unclassified' END;
    IF b->>'type'='refund.failed' AND o->>'status' IN ('pending','requires_action','succeeded') THEN
      contradiction:='Refund failure event contradicts provider object status'; END IF;
  ELSIF b->>'type'='charge.dispute.created' AND o->>'object'='dispute' AND o->>'status' IN ('needs_response','under_review','warning_needs_response','warning_under_review') THEN op:='dispute.opened';
  ELSIF b->>'type'='charge.dispute.closed' AND o->>'object'='dispute' AND o->>'status' IN ('won','lost') THEN op:='dispute.closed';
  ELSE op:='provider.unclassified'; END IF;
  -- Check normalized claims BEFORE granting the Option A pending exemption.
  -- Confirmed outcomes reuse the sealed-evidence validator, including exact
  -- amount/currency/object and explicit owner comparisons. Validation failures
  -- become retained review evidence, never an unsupported/pending exemption.
  IF op='refund.pending' THEN
    IF w.payload->>'type' IS DISTINCT FROM 'provider.unsupported' OR w.payload->'data' IS DISTINCT FROM 'null'::jsonb THEN
      contradiction:='Pending provider outcome contradicts normalized financial evidence'; END IF;
  ELSIF op IN ('refund.succeeded','refund.failed','dispute.opened','dispute.closed') THEN
    BEGIN
      PERFORM public.financial_receipt_facts(p_inbox);
      IF (w.payload->'data') ? 'providerStatus' AND w.payload#>>'{data,providerStatus}' IS DISTINCT FROM o->>'status' THEN
        RAISE EXCEPTION 'Normalized provider status contradicts original receipt'; END IF;
    EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range THEN
      contradiction:=SQLERRM;
    END;
  END IF;
  RETURN jsonb_build_object('provider',r.provider,'provider_account',r.provider_account,'operation',op,
    'financially_relevant',relevant,'contradiction',contradiction);
END;
$$;
CREATE FUNCTION public.guard_receipt_obligation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Receipt obligations cannot be removed'; END IF;
  IF current_user<>'fintech_admission_'||md5(current_database()) THEN RAISE EXCEPTION 'Obligation mutation requires the guarded writer'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.inbox_id,NEW.provider,NEW.provider_account,NEW.operation,NEW.created_at)
      IS DISTINCT FROM (OLD.inbox_id,OLD.provider,OLD.provider_account,OLD.operation,OLD.created_at)
      OR (OLD.merchant_id IS NOT NULL AND (NEW.merchant_id,NEW.currency,NEW.payment_id,NEW.proof_revision)
          IS DISTINCT FROM (OLD.merchant_id,OLD.currency,OLD.payment_id,OLD.proof_revision))
      OR NEW.obligation_revision<>OLD.obligation_revision+1 THEN RAISE EXCEPTION 'Obligation identity or revision cannot be replaced'; END IF;
    IF NOT ((OLD.disposition='AWAITING_CORRELATION' AND NEW.disposition='AWAITING_APPLICATION')
      OR NEW.disposition='BLOCKING_REVIEW'
      OR (OLD.disposition='AWAITING_APPLICATION' AND NEW.disposition IN ('CLEARED_APPLICATION','CLEARED_NO_EFFECT'))) THEN
      RAISE EXCEPTION 'Invalid receipt obligation transition'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.receipt_admission_obligations
  FOR EACH ROW EXECUTE FUNCTION public.guard_receipt_obligation();
CREATE TRIGGER receipt_obligation_truncate BEFORE TRUNCATE ON public.receipt_admission_obligations
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_receipt_obligation();
CREATE FUNCTION public.check_receipt_admission_obligation() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.receipt_admissions%ROWTYPE; o public.receipt_admission_obligations%ROWTYPE; f jsonb; e public.webhook_financial_evidence%ROWTYPE;
BEGIN
  SELECT * INTO STRICT a FROM public.receipt_admissions WHERE inbox_id=NEW.inbox_id;
  f:=public.receipt_admission_facts(a.inbox_id);
  IF (a.provider,a.provider_account,a.operation,a.financially_relevant) IS DISTINCT FROM
    (f->>'provider',f->>'provider_account',f->>'operation',(f->>'financially_relevant')::boolean) THEN RAISE EXCEPTION 'Admission classification contradicts original receipt'; END IF;
  SELECT * INTO o FROM public.receipt_admission_obligations WHERE inbox_id=a.inbox_id;
  IF a.financially_relevant IS DISTINCT FROM FOUND THEN RAISE EXCEPTION 'R1 admission requires exactly its mandatory obligation'; END IF;
  IF f->>'contradiction' IS NOT NULL AND (o.disposition IS DISTINCT FROM 'BLOCKING_REVIEW' OR NOT EXISTS (
    SELECT 1 FROM public.financial_evidence_reviews v WHERE v.inbox_id=a.inbox_id
      AND v.review_key='receipt-admission/classification/v1' AND v.reason='CONTRADICTORY'
      AND v.observations=jsonb_build_object('classifier','receipt-admission/v1','reason',f->>'contradiction'))) THEN
    RAISE EXCEPTION 'Contradictory admission requires retained blocking review'; END IF;
  IF o.review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.financial_evidence_reviews v
    WHERE v.id=o.review_id AND v.inbox_id=a.inbox_id) THEN RAISE EXCEPTION 'Matching immutable review required'; END IF;
  IF o.merchant_id IS NOT NULL THEN
    e:=public.load_effective_financial_evidence(o.inbox_id,o.proof_revision,o.operation);
    IF (o.payment_id,o.merchant_id,o.currency,o.provider,o.provider_account) IS DISTINCT FROM
      (e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account) THEN RAISE EXCEPTION 'Obligation requires matching owned proof'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_requires_obligation AFTER INSERT ON public.receipt_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_receipt_admission_obligation();
CREATE CONSTRAINT TRIGGER receipt_obligation_consistent AFTER INSERT OR UPDATE ON public.receipt_admission_obligations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_receipt_admission_obligation();
--> statement-breakpoint
-- These entry points own their prefix. Do not call them after financial rows,
-- or upgrade an earlier intake SHARE. No network call occurs in SQL.
CREATE FUNCTION public.enroll_receipt_admission(p_inbox uuid,p_proof_revision integer DEFAULT NULL) RETURNS public.receipt_admissions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; a public.receipt_admissions%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE;
  f jsonb; ir bigint; sr bigint; review uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Receipt admission requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  f:=public.receipt_admission_facts(p_inbox);
  IF p_proof_revision IS NULL OR f->>'contradiction' IS NOT NULL THEN
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=r.provider_account FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=r.provider_account FOR SHARE;
  END IF;
  SELECT * INTO a FROM public.receipt_admissions WHERE inbox_id=p_inbox;
  IF FOUND THEN
    IF p_proof_revision IS NOT NULL AND f->>'contradiction' IS NULL THEN
      e:=public.load_effective_financial_evidence(p_inbox,p_proof_revision,a.operation);
      IF NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox AND proof_revision=e.proof_revision
        AND merchant_id=e.merchant_id AND payment_id=e.payment_id AND currency=e.currency) THEN RAISE EXCEPTION 'Existing obligation requires guarded binding'; END IF;
    END IF;
    RETURN a;
  END IF;
  INSERT INTO public.receipt_intake_authority(provider,provider_account) VALUES(r.provider,r.provider_account) ON CONFLICT DO NOTHING;
  SELECT evidence_revision INTO ir FROM public.receipt_intake_authority WHERE provider=r.provider AND provider_account=r.provider_account;
  IF (f->>'financially_relevant')::boolean AND p_proof_revision IS NOT NULL AND f->>'contradiction' IS NULL THEN
    e:=public.load_effective_financial_evidence(p_inbox,p_proof_revision,f->>'operation');
    PERFORM pg_advisory_xact_lock(hashtextextended(e.merchant_id::text||':'||e.currency,0));
    PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=e.merchant_id AND currency=e.currency FOR NO KEY UPDATE;
    e:=public.load_effective_financial_evidence(p_inbox,p_proof_revision,f->>'operation');
    UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=e.merchant_id AND currency=e.currency RETURNING evidence_revision INTO sr;
  ELSIF (f->>'financially_relevant')::boolean THEN
    UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=r.provider AND provider_account=r.provider_account RETURNING evidence_revision INTO ir;
  END IF;
  INSERT INTO public.receipt_admissions(inbox_id,provider,provider_account,contract_version,operation,financially_relevant)
    VALUES(p_inbox,r.provider,r.provider_account,1,f->>'operation',(f->>'financially_relevant')::boolean) RETURNING * INTO a;
  IF a.financially_relevant THEN
    IF f->>'contradiction' IS NOT NULL THEN
      INSERT INTO public.financial_evidence_reviews(inbox_id,review_key,reason,observations)
        VALUES(p_inbox,'receipt-admission/classification/v1','CONTRADICTORY',
          jsonb_build_object('classifier','receipt-admission/v1','reason',f->>'contradiction')) ON CONFLICT DO NOTHING;
      SELECT id INTO STRICT review FROM public.financial_evidence_reviews WHERE inbox_id=p_inbox
        AND review_key='receipt-admission/classification/v1' AND reason='CONTRADICTORY'
        AND observations=jsonb_build_object('classifier','receipt-admission/v1','reason',f->>'contradiction');
    END IF;
    INSERT INTO public.receipt_admission_obligations(inbox_id,provider,provider_account,operation,merchant_id,currency,payment_id,proof_revision,
      disposition,scope_evidence_revision,intake_evidence_revision,review_id)
      VALUES(p_inbox,r.provider,r.provider_account,a.operation,e.merchant_id,e.currency,e.payment_id,e.proof_revision,
        CASE WHEN review IS NOT NULL THEN 'BLOCKING_REVIEW' WHEN a.operation='refund.pending' THEN 'AWAITING_CONFIRMATION'
          WHEN e.inbox_id IS NULL THEN 'AWAITING_CORRELATION' ELSE 'AWAITING_APPLICATION' END,sr,ir,review);
  END IF;
  RETURN a;
END;
$$;
CREATE FUNCTION public.publish_admitted_receipt(p_inbox uuid,p_account text,p_raw bytea,p_verifier text) RETURNS public.receipt_admissions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; r public.provider_financial_receipts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  -- First publication has no sealed owner yet: choose exclusive UNKNOWN intake
  -- before the B.1 publisher's SHARE, avoiding any subsequent SHARE upgrade.
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=w.provider AND provider_account=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured provider account required'; END IF;
  SELECT * INTO r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  IF FOUND THEN
    IF (r.provider_account,r.raw_body,r.signature,r.headers,r.normalized_payload,r.verification_version) IS DISTINCT FROM
      (p_account,p_raw,w.signature,w.headers,w.payload,p_verifier) THEN RAISE EXCEPTION 'Contradictory duplicate receipt; original retained'; END IF;
  ELSE
    INSERT INTO public.provider_financial_receipts(inbox_id,provider,provider_account,raw_body,signature,headers,normalized_payload,
      normalization_version,verification_method,verification_version,received_at,verified_at)
      VALUES(p_inbox,w.provider,p_account,p_raw,w.signature,w.headers,w.payload,1,'STRIPE_SDK',p_verifier,w.created_at,now());
  END IF;
  RETURN public.enroll_receipt_admission(p_inbox,NULL);
END;
$$;
CREATE FUNCTION public.bind_receipt_obligation(p_inbox uuid,p_proof_revision integer) RETURNS public.receipt_admission_obligations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.receipt_admission_obligations%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE; ir bigint; sr bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Receipt binding requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  -- UNKNOWN transfer always chooses exclusive intake, before scope, even replay.
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR UPDATE;
  e:=public.load_effective_financial_evidence(p_inbox,p_proof_revision,o.operation);
  IF (e.provider,e.provider_account) IS DISTINCT FROM (o.provider,o.provider_account) THEN RAISE EXCEPTION 'Proof account mismatch'; END IF;
  IF o.merchant_id IS NOT NULL THEN
    IF (o.merchant_id,o.currency,o.payment_id,o.proof_revision) IS DISTINCT FROM (e.merchant_id,e.currency,e.payment_id,e.proof_revision) THEN RAISE EXCEPTION 'Obligation already bound'; END IF;
    RETURN o;
  END IF;
  IF o.disposition<>'AWAITING_CORRELATION' THEN RAISE EXCEPTION 'Blocking review requires separate reviewed recovery'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(e.merchant_id::text||':'||e.currency,0));
  PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=e.merchant_id AND currency=e.currency FOR NO KEY UPDATE;
  e:=public.load_effective_financial_evidence(p_inbox,p_proof_revision,o.operation);
  UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=e.merchant_id AND currency=e.currency RETURNING evidence_revision INTO sr;
  UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=o.provider AND provider_account=o.provider_account RETURNING evidence_revision INTO ir;
  UPDATE public.receipt_admission_obligations SET merchant_id=e.merchant_id,currency=e.currency,payment_id=e.payment_id,proof_revision=e.proof_revision,
    disposition='AWAITING_APPLICATION',obligation_revision=obligation_revision+1,scope_evidence_revision=sr,intake_evidence_revision=ir WHERE inbox_id=p_inbox RETURNING * INTO o;
  RETURN o;
END;
$$;
CREATE FUNCTION public.review_receipt_obligation(p_inbox uuid,p_review uuid) RETURNS public.receipt_admission_obligations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.receipt_admission_obligations%ROWTYPE; sr bigint; ir bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Receipt review requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF NOT EXISTS (SELECT 1 FROM public.financial_evidence_reviews WHERE id=p_review AND inbox_id=p_inbox) THEN RAISE EXCEPTION 'Matching immutable review required'; END IF;
  IF o.merchant_id IS NULL THEN
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR SHARE;
    PERFORM pg_advisory_xact_lock(hashtextextended(o.merchant_id::text||':'||o.currency,0));
    PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=o.merchant_id AND currency=o.currency FOR NO KEY UPDATE;
  END IF;
  IF o.review_id=p_review THEN RETURN o; END IF;
  IF o.merchant_id IS NULL THEN
    UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=o.provider AND provider_account=o.provider_account RETURNING evidence_revision INTO ir;
  ELSE
    UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=o.merchant_id AND currency=o.currency RETURNING evidence_revision INTO sr;
  END IF;
  UPDATE public.receipt_admission_obligations SET disposition='BLOCKING_REVIEW',review_id=p_review,resolution_id=NULL,resolved_at=NULL,
    obligation_revision=obligation_revision+1,scope_evidence_revision=coalesce(sr,scope_evidence_revision),intake_evidence_revision=coalesce(ir,intake_evidence_revision)
    WHERE inbox_id=p_inbox RETURNING * INTO o;
  RETURN o;
END;
$$;
--> statement-breakpoint
-- R0 resolution acknowledges an ALREADY committed matching financial fact. It
-- never posts money, upgrades version0 evidence, marks an inbox PROCESSED, clears
-- an accounting exception, or authorizes a new-policy financial application.
-- The first supported no-effect fact is a confirmed failed/refused refund with
-- released reservations and immutable audit; notes/absence of a journal alone
-- are not sufficient. Other no-effect policies stay blocked for reviewed R2.
CREATE FUNCTION public.resolve_receipt_obligation(p_inbox uuid,p_kind text,p_journal uuid DEFAULT NULL) RETURNS public.receipt_obligation_resolutions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.receipt_admission_obligations%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE;
  result public.receipt_obligation_resolutions%ROWTYPE; r public.refunds%ROWTYPE; a record; audit uuid; snapshot jsonb; sr bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Receipt resolution requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF o.merchant_id IS NULL THEN RAISE EXCEPTION 'Owned proof required before resolution'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(o.merchant_id::text||':'||o.currency,0));
  PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=o.merchant_id AND currency=o.currency FOR NO KEY UPDATE;
  IF o.disposition='BLOCKING_REVIEW' THEN RAISE EXCEPTION 'Blocking review requires separately reviewed recovery'; END IF;
  SELECT * INTO result FROM public.receipt_obligation_resolutions WHERE inbox_id=p_inbox;
  IF FOUND THEN
    IF (result.kind,result.journal_id) IS DISTINCT FROM (p_kind,p_journal) THEN RAISE EXCEPTION 'Conflicting resolution; original evidence retained'; END IF;
    RETURN result;
  END IF;
  e:=public.load_effective_financial_evidence(p_inbox,o.proof_revision,o.operation);
  IF e.refund_id IS NULL THEN RAISE EXCEPTION 'Dispute application linkage requires the coordinated R2 contract'; END IF;
  PERFORM 1 FROM public.payments WHERE id=e.payment_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT r FROM public.refunds WHERE id=e.refund_id FOR UPDATE;
  PERFORM 1 FROM public.capture_accounting_lots WHERE payment_id=e.payment_id ORDER BY capture_attempt_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.refund_capture_allocations WHERE refund_id=e.refund_id ORDER BY capture_lot_id FOR NO KEY UPDATE;
  IF (r.payment_id,r.merchant_id,r.currency,r.amount,r.provider_transaction_id) IS DISTINCT FROM
    (e.payment_id,e.merchant_id,e.currency,e.amount,e.provider_object_id) THEN RAISE EXCEPTION 'Financial completion owner or amount mismatch'; END IF;
  SELECT count(*) AS count,sum(reserved_gross) AS gross,min(journal_id::text)::uuid AS journal,
    bool_and(provider_event_id IS NOT DISTINCT FROM p_inbox) AS same_event,
    bool_and((status='CONFIRMED' AND confirmed_gross=reserved_gross AND journal_id=p_journal) IS TRUE) AS applied,
    bool_and((status='RELEASED' AND release_reason='CONFIRMED_PROVIDER_FAILURE' AND journal_id IS NULL) IS TRUE) AS no_effect,
    jsonb_agg(jsonb_build_object('allocation_id',id,'capture_lot_id',capture_lot_id,'gross',reserved_gross::text,'fee',confirmed_fee::text) ORDER BY capture_lot_id) AS refs
    INTO a FROM public.refund_capture_allocations WHERE refund_id=e.refund_id;
  IF a.count=0 OR a.gross IS DISTINCT FROM e.amount::numeric OR a.same_event IS DISTINCT FROM true
    OR EXISTS (SELECT capture_lot_id FROM public.refund_capture_allocations WHERE refund_id=e.refund_id
      EXCEPT SELECT (s->>'lot_id')::uuid FROM jsonb_array_elements(e.capture_sources) s)
    OR EXISTS (SELECT (s->>'lot_id')::uuid FROM jsonb_array_elements(e.capture_sources) s
      EXCEPT SELECT capture_lot_id FROM public.refund_capture_allocations WHERE refund_id=e.refund_id) THEN RAISE EXCEPTION 'Matching complete frozen allocation evidence required'; END IF;
  IF p_kind='APPLICATION' AND e.operation='refund.succeeded' AND r.status='SUCCEEDED' AND a.applied IS TRUE AND p_journal IS NOT NULL THEN
    PERFORM public.require_accounting_journal(p_journal,'REFUND',e.refund_id,e.merchant_id,e.currency);
  ELSIF p_kind='NO_EFFECT' AND e.operation='refund.failed' AND r.status='FAILED' AND a.no_effect IS TRUE AND p_journal IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.ledger_transactions WHERE business_type='REFUND' AND business_id=e.refund_id) THEN NULL;
  ELSE RAISE EXCEPTION 'Matching verified application or no-effect evidence required'; END IF;
  SELECT id INTO audit FROM public.audit_logs WHERE merchant_id=e.merchant_id AND target_type='payment' AND target_id=e.payment_id::text
    AND action=e.operation AND metadata->>'refundId'=e.refund_id::text ORDER BY created_at,id LIMIT 1;
  IF audit IS NULL THEN RAISE EXCEPTION 'Matching immutable financial audit required'; END IF;
  snapshot:=jsonb_build_object('refund_id',e.refund_id,'amount',e.amount::text,'allocations',a.refs);
  INSERT INTO public.receipt_obligation_resolutions(inbox_id,kind,proof_revision,payment_id,merchant_id,currency,operation,journal_id,audit_id,financial_reference)
    VALUES(p_inbox,p_kind,e.proof_revision,e.payment_id,e.merchant_id,e.currency,e.operation,p_journal,audit,snapshot) RETURNING * INTO result;
  UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=o.merchant_id AND currency=o.currency RETURNING evidence_revision INTO sr;
  UPDATE public.receipt_admission_obligations SET disposition=CASE WHEN p_kind='APPLICATION' THEN 'CLEARED_APPLICATION' ELSE 'CLEARED_NO_EFFECT' END,
    resolution_id=result.id,resolved_at=result.created_at,obligation_revision=obligation_revision+1,scope_evidence_revision=sr WHERE inbox_id=p_inbox;
  RETURN result;
END;
$$;
CREATE FUNCTION public.inspect_receipt_admission(p_provider text,p_account text,p_merchant uuid,p_currency text,
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
  IF (p_scope_revision IS NOT NULL AND p_scope_revision<>scope_revision) OR (p_intake_revision IS NOT NULL AND p_intake_revision<>intake_revision) THEN
    RAISE EXCEPTION 'Stale receipt clearance revision'; END IF;
  IF EXISTS (SELECT 1 FROM public.receipt_admission_obligations o WHERE o.provider=p_provider AND o.provider_account=p_account
      AND o.merchant_id IS NULL AND o.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
    OR EXISTS (SELECT 1 FROM public.receipt_admission_obligations o WHERE o.merchant_id=p_merchant AND o.currency=p_currency
      AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW'))
    OR EXISTS (SELECT 1 FROM public.accounting_exceptions x WHERE x.merchant_id=p_merchant AND x.currency=p_currency AND x.status='OPEN') THEN
    RAISE EXCEPTION 'Receipt admission blocked by unresolved evidence or exception'; END IF;
  -- Inspection of staged receipt authority ONLY, never a policy/financial permit.
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Separate non-login capability; no existing login, membership or credential is
-- changed. Ordinary workers/publishers receive no grants in this migration.
DO $$ DECLARE owner_name text:='fintech_admission_'||md5(current_database()); f record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=owner_name) THEN RAISE EXCEPTION 'Admission owner already exists; inspect installation'; END IF;
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.financial_evidence_accounts,public.provider_financial_receipts,public.provider_financial_observations,
    public.provider_financial_object_owners,public.webhook_financial_evidence,public.webhook_events,public.capture_accounting_scopes,
    public.capture_accounting_lots,public.payments,public.refunds,public.disputes,public.refund_capture_allocations,public.ledger_transactions,
    public.ledger_entries,public.ledger_accounts,public.audit_logs,public.financial_evidence_reviews,public.accounting_exceptions,
    public.receipt_intake_authority,public.receipt_admissions,public.receipt_admission_obligations,public.receipt_obligation_resolutions TO %I',owner_name);
  EXECUTE format('GRANT INSERT ON public.provider_financial_receipts,public.receipt_intake_authority,public.receipt_admissions,
    public.receipt_admission_obligations,public.receipt_obligation_resolutions,public.financial_evidence_reviews TO %I',owner_name);
  EXECUTE format('GRANT UPDATE ON public.receipt_admission_obligations TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(evidence_revision) ON public.capture_accounting_scopes,public.receipt_intake_authority TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts,public.capture_accounting_lots,public.refund_capture_allocations TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(updated_at) ON public.webhook_events,public.payments,public.refunds TO %I',owner_name);
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('financial_external_reference','financial_receipt_facts','load_effective_financial_evidence','require_accounting_journal') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,owner_name);
  END LOOP;
  FOR f IN SELECT oid::regprocedure AS signature,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('protect_receipt_admission_authority','receipt_admission_facts','guard_receipt_obligation','check_receipt_admission_obligation',
     'enroll_receipt_admission','publish_admitted_receipt','bind_receipt_obligation','review_receipt_obligation','resolve_receipt_obligation','inspect_receipt_admission') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,owner_name);
    IF f.prosecdef THEN EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,owner_name); END IF;
  END LOOP;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END $$;
REVOKE ALL ON public.receipt_intake_authority,public.receipt_admissions,public.receipt_admission_obligations,public.receipt_obligation_resolutions FROM PUBLIC;

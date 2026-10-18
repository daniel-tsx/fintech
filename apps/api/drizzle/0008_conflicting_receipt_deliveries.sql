-- R0.2 only: drain receipt writers and install transactionally. No runtime grants,
-- history backfill, financial application, resolution or ACTIVE scope opening.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE TABLE public.receipt_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_inbox_id uuid NOT NULL REFERENCES public.receipt_admissions(inbox_id),
  provider text NOT NULL CHECK (provider='STRIPE'), provider_event_id text NOT NULL,
  original_account text NOT NULL, provider_account text NOT NULL,
  delivery_key bytea NOT NULL CHECK (octet_length(delivery_key)=32),
  raw_body bytea NOT NULL CHECK (octet_length(raw_body)>0), signature text NOT NULL CHECK (length(signature)>0),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers)='object'),
  normalized_payload jsonb NOT NULL CHECK (jsonb_typeof(normalized_payload)='object'),
  normalization_version integer NOT NULL CHECK (normalization_version=1),
  verification_method text NOT NULL CHECK (verification_method='STRIPE_SDK'),
  verification_version text NOT NULL CHECK (length(verification_version)>0),
  original_proof_revision integer CHECK (original_proof_revision=1),
  classification text NOT NULL CHECK (classification IN ('EQUIVALENT','CONFLICT')),
  reason text NOT NULL, operation text NOT NULL, financially_relevant boolean NOT NULL,
  review_id uuid REFERENCES public.financial_evidence_reviews(id),
  received_at timestamptz NOT NULL DEFAULT now(), database_principal name NOT NULL DEFAULT session_user,
  UNIQUE (original_inbox_id,delivery_key),
  FOREIGN KEY (provider,original_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY (provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  CHECK ((classification='CONFLICT')=(review_id IS NOT NULL))
);
CREATE TABLE public.receipt_delivery_barriers (
  delivery_id uuid NOT NULL REFERENCES public.receipt_delivery_attempts(id), barrier_key text NOT NULL,
  provider text NOT NULL, provider_account text NOT NULL, merchant_id uuid, currency text,
  disposition text NOT NULL DEFAULT 'BLOCKING_REVIEW' CHECK (disposition='BLOCKING_REVIEW'),
  review_id uuid NOT NULL REFERENCES public.financial_evidence_reviews(id),
  scope_evidence_revision bigint, intake_evidence_revision bigint NOT NULL CHECK (intake_evidence_revision>=0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (delivery_id,barrier_key),
  FOREIGN KEY (provider,provider_account) REFERENCES public.receipt_intake_authority(provider,provider_account),
  FOREIGN KEY (merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  CHECK ((merchant_id IS NULL AND currency IS NULL AND scope_evidence_revision IS NULL AND intake_evidence_revision>=1)
    OR (merchant_id IS NOT NULL AND currency IS NOT NULL AND scope_evidence_revision>=1) IS TRUE)
);
CREATE INDEX receipt_delivery_account_barriers ON public.receipt_delivery_barriers(provider,provider_account) WHERE merchant_id IS NULL;
CREATE INDEX receipt_delivery_scope_barriers ON public.receipt_delivery_barriers(merchant_id,currency) WHERE merchant_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['receipt_delivery_attempts','receipt_delivery_barriers'] LOOP
    EXECUTE format('CREATE TRIGGER delivery_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER delivery_immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Shared SQL derivation for publication and deferred validation. Frozen NULL
-- proof selection stays unknown even if correlation is established later.
CREATE FUNCTION public.receipt_delivery_facts(p_inbox uuid,p_account text,p_raw bytea,p_normalized jsonb,p_proof integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE;
  a public.receipt_admissions%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE;
  b jsonb; obj jsonb; d jsonb; meta jsonb; old_f jsonb; op text; reason text; equivalent boolean;
  relevant boolean; known boolean:=false; k text; expected text; account text; m uuid; cur text;
  sides jsonb:='[]'; barriers jsonb:='[]'; side jsonb;
BEGIN
  SELECT * INTO STRICT a FROM public.receipt_admissions WHERE inbox_id=p_inbox;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox;
  old_f:=public.receipt_admission_facts(p_inbox);
  b:=convert_from(p_raw,'UTF8')::jsonb; obj:=b#>'{data,object}'; d:=p_normalized->'data'; meta:=obj->'metadata';
  IF p_account IS NULL OR NOT EXISTS(SELECT 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=p_account)
    OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(obj) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_normalized) IS DISTINCT FROM 'object'
    OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string' OR b->>'id' IS DISTINCT FROM w.provider_event_id
    OR p_normalized->>'id' IS DISTINCT FROM w.provider_event_id
    OR jsonb_typeof(b->'type') IS DISTINCT FROM 'string' OR p_normalized->>'externalType' IS DISTINCT FROM b->>'type'
    OR (b ? 'account' AND (jsonb_typeof(b->'account') IS DISTINCT FROM 'string' OR b->>'account' IS DISTINCT FROM p_account)) THEN
    RAISE EXCEPTION 'Verified delivery requires original event identity and trusted configured account context'; END IF;
  equivalent:=p_account=r.provider_account AND b=convert_from(r.raw_body,'UTF8')::jsonb AND p_normalized=r.normalized_payload;
  relevant:=NOT (b->>'type' IN ('customer.created','customer.updated','customer.deleted')
    AND p_normalized->>'type' IS NOT DISTINCT FROM 'provider.unsupported' AND d IS NOT DISTINCT FROM 'null'::jsonb);
  op:=CASE
    WHEN b->>'type' IN ('refund.created','refund.updated','refund.failed') AND obj->>'object'='refund' THEN
      CASE WHEN obj->>'status'='succeeded' AND b->>'type'<>'refund.failed' THEN 'refund.succeeded'
        WHEN obj->>'status' IN ('failed','canceled') THEN 'refund.failed'
        WHEN obj->>'status' IN ('pending','requires_action') AND b->>'type'<>'refund.failed' THEN 'refund.pending'
        ELSE 'provider.unclassified' END
    WHEN b->>'type'='charge.dispute.created' AND obj->>'object'='dispute'
      AND obj->>'status' IN ('needs_response','under_review','warning_needs_response','warning_under_review') THEN 'dispute.opened'
    WHEN b->>'type'='charge.dispute.closed' AND obj->>'object'='dispute' AND obj->>'status' IN ('won','lost') THEN 'dispute.closed'
    WHEN NOT relevant THEN 'provider.unrelated' ELSE 'provider.unclassified' END;
  IF relevant AND NOT ((op='refund.pending' OR op='provider.unclassified') OR
    (p_normalized->>'type'=op AND jsonb_typeof(d)='object') OR (p_normalized->>'type'='provider.unsupported' AND d='null'::jsonb)) THEN
    op:='provider.unclassified'; END IF;
  reason:=CASE WHEN equivalent THEN 'EQUIVALENT_EVENT_FACTS' WHEN p_account<>r.provider_account THEN 'PROVIDER_ACCOUNT_CONFLICT'
    WHEN b=convert_from(r.raw_body,'UTF8')::jsonb THEN 'NORMALIZATION_CONFLICT' ELSE 'SIGNED_EVENT_CONFLICT' END;
  IF NOT equivalent THEN
    IF p_proof IS NOT NULL THEN
      e:=public.load_effective_financial_evidence(p_inbox,p_proof,a.operation);
      BEGIN
        known:=e.provider_account=p_account AND obj->>'object'=split_part(e.operation,'.',1)
          AND obj->>'id'=e.provider_object_id AND jsonb_typeof(obj->'amount')='number'
          AND (obj->>'amount')::numeric=e.amount AND upper(obj->>'currency')=e.currency
          AND ((p_normalized->>'type'=op AND jsonb_typeof(d)='object')
            OR (p_normalized->>'type'='provider.unsupported' AND d='null'::jsonb));
        FOREACH k IN ARRAY ARRAY['merchantId','paymentId','refundId'] LOOP
          expected:=CASE k WHEN 'merchantId' THEN e.merchant_id::text WHEN 'paymentId' THEN e.payment_id::text ELSE e.refund_id::text END;
          IF (meta ? k AND meta->k<>'null'::jsonb AND (jsonb_typeof(meta->k)<>'string' OR meta->>k IS DISTINCT FROM expected))
            OR (d ? k AND d->k<>'null'::jsonb AND (jsonb_typeof(d->k)<>'string' OR d->>k IS DISTINCT FROM expected)) THEN known:=false; END IF;
        END LOOP;
        IF (meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object')
          OR (d ? 'amount' AND (jsonb_typeof(d->'amount') IS DISTINCT FROM 'number' OR (d->>'amount')::numeric IS DISTINCT FROM e.amount::numeric))
          OR (d ? 'currency' AND upper(d->>'currency') IS DISTINCT FROM e.currency)
          OR (d ? 'providerTransactionId' AND d->>'providerTransactionId' IS DISTINCT FROM e.provider_object_id)
          OR (d ? 'providerDisputeId' AND d->>'providerDisputeId' IS DISTINCT FROM e.provider_dispute_id)
          OR (d ? 'providerStatus' AND d->>'providerStatus' IS DISTINCT FROM obj->>'status')
          OR (obj ? 'payment_intent' AND obj->'payment_intent'<>'null'::jsonb AND public.financial_external_reference(obj->'payment_intent') IS DISTINCT FROM e.payment_intent_id)
          OR (obj ? 'charge' AND obj->'charge'<>'null'::jsonb AND public.financial_external_reference(obj->'charge') IS DISTINCT FROM e.charge_id)
          OR (d ? 'paymentIntentId' AND d->>'paymentIntentId' IS DISTINCT FROM e.payment_intent_id)
          OR (d ? 'chargeId' AND d->>'chargeId' IS DISTINCT FROM e.charge_id) THEN known:=false; END IF;
      EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range THEN known:=false;
      END;
    END IF;
    IF (old_f->>'financially_relevant')::boolean THEN
      sides:=sides||jsonb_build_array(jsonb_build_object('account',r.provider_account,'merchant',e.merchant_id,'currency',e.currency)); END IF;
    IF relevant THEN
      sides:=sides||jsonb_build_array(jsonb_build_object('account',p_account,
        'merchant',CASE WHEN known IS TRUE THEN e.merchant_id END,'currency',CASE WHEN known IS TRUE THEN e.currency END)); END IF;
    FOR account IN SELECT DISTINCT value->>'account' FROM jsonb_array_elements(sides) ORDER BY 1 LOOP
      m:=NULL; cur:=NULL;
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sides) s WHERE s->>'account'=account AND s->>'merchant' IS NULL) THEN
        SELECT value INTO STRICT side FROM jsonb_array_elements(sides) WHERE value->>'account'=account LIMIT 1;
        m:=(side->>'merchant')::uuid; cur:=side->>'currency';
      END IF;
      barriers:=barriers||jsonb_build_array(jsonb_build_object('key',jsonb_build_array(account,m,cur)::text,
        'account',account,'merchant',m,'currency',cur));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('provider',r.provider,'event',w.provider_event_id,'original_account',r.provider_account,
    'classification',CASE WHEN equivalent THEN 'EQUIVALENT' ELSE 'CONFLICT' END,'reason',reason,'operation',op,
    'relevant',relevant,'barriers',barriers);
END;
$$;
CREATE FUNCTION public.check_receipt_delivery_barriers() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.receipt_delivery_attempts%ROWTYPE; f jsonb; expected jsonb; actual jsonb; b record;
BEGIN
  SELECT * INTO STRICT d FROM public.receipt_delivery_attempts
    WHERE id=coalesce((to_jsonb(NEW)->>'delivery_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
  f:=public.receipt_delivery_facts(d.original_inbox_id,d.provider_account,d.raw_body,d.normalized_payload,d.original_proof_revision);
  IF (d.provider,d.provider_event_id,d.original_account,d.classification,d.reason,d.operation,d.financially_relevant) IS DISTINCT FROM
    (f->>'provider',f->>'event',f->>'original_account',f->>'classification',f->>'reason',f->>'operation',(f->>'relevant')::boolean)
    OR d.delivery_key IS DISTINCT FROM sha256(convert_to(jsonb_build_array(d.provider_account,encode(d.raw_body,'hex'),d.signature,
      d.headers,d.normalized_payload,d.normalization_version,d.verification_version)::text,'UTF8'))
    OR (d.headers ? 'stripe-signature' AND d.headers->>'stripe-signature' IS DISTINCT FROM d.signature) THEN
    RAISE EXCEPTION 'Delivery classification or verified source identity mismatch'; END IF;
  IF d.classification='CONFLICT' AND NOT EXISTS(SELECT 1 FROM public.financial_evidence_reviews v WHERE v.id=d.review_id
    AND v.inbox_id=d.original_inbox_id AND v.review_key='receipt-delivery/'||d.id::text AND v.reason='CONTRADICTORY'
    AND v.observations=jsonb_build_object('contract','R0_2','delivery_id',d.id,'reason',d.reason,
      'original_account',d.original_account,'delivery_account',d.provider_account)) THEN
    RAISE EXCEPTION 'Matching immutable delivery review required'; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'key'),'[]'::jsonb) INTO expected FROM jsonb_array_elements(f->'barriers');
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',barrier_key,'account',provider_account,'merchant',merchant_id,'currency',currency)
    ORDER BY barrier_key),'[]'::jsonb) INTO actual FROM public.receipt_delivery_barriers WHERE delivery_id=d.id;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Verified conflict requires its exact atomic barrier set'; END IF;
  FOR b IN SELECT * FROM public.receipt_delivery_barriers WHERE delivery_id=d.id LOOP
    IF b.provider IS DISTINCT FROM d.provider OR b.review_id IS DISTINCT FROM d.review_id
      OR b.intake_evidence_revision>(SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=b.provider AND provider_account=b.provider_account)
      OR (b.merchant_id IS NOT NULL AND b.scope_evidence_revision>(SELECT evidence_revision FROM public.capture_accounting_scopes WHERE merchant_id=b.merchant_id AND currency=b.currency)) THEN
      RAISE EXCEPTION 'Delivery barrier review or authority revision mismatch'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER delivery_requires_barriers AFTER INSERT ON public.receipt_delivery_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_receipt_delivery_barriers();
CREATE CONSTRAINT TRIGGER delivery_barrier_consistent AFTER INSERT ON public.receipt_delivery_barriers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_receipt_delivery_barriers();
--> statement-breakpoint
-- EXECUTE is a future SDK-verifying publisher capability, not a public endpoint.
-- SQL validates original lineage/configured context; it cannot verify Stripe HMAC.
CREATE FUNCTION public.publish_verified_receipt_delivery(p_inbox uuid,p_account text,p_raw bytea,p_signature text,
  p_headers jsonb,p_normalized jsonb,p_verifier text) RETURNS public.receipt_delivery_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; d public.receipt_delivery_attempts%ROWTYPE;
  f jsonb; locked_f jsonb; key bytea; proof integer; delivery uuid:=gen_random_uuid(); review uuid; account text; s record; b jsonb; ir bigint; sr bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Delivery publication requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  IF p_signature IS NULL OR length(p_signature)=0 OR p_verifier IS NULL OR length(p_verifier)=0
    OR jsonb_typeof(p_headers) IS DISTINCT FROM 'object'
    OR (p_headers ? 'stripe-signature' AND p_headers->>'stripe-signature' IS DISTINCT FROM p_signature) THEN
    RAISE EXCEPTION 'Verified delivery signature, headers and verifier attestation required'; END IF;
  FOR account IN SELECT DISTINCT unnest(ARRAY[r.provider_account,p_account]) ORDER BY 1 LOOP
    PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Trusted configured account required'; END IF;
  END LOOP;
  key:=sha256(convert_to(jsonb_build_array(p_account,encode(p_raw,'hex'),p_signature,p_headers,p_normalized,1,p_verifier)::text,'UTF8'));
  SELECT * INTO d FROM public.receipt_delivery_attempts WHERE original_inbox_id=p_inbox AND delivery_key=key;
  IF FOUND THEN
    IF (d.provider_account,d.raw_body,d.signature,d.headers,d.normalized_payload,d.verification_version)
      IS DISTINCT FROM (p_account,p_raw,p_signature,p_headers,p_normalized,p_verifier) THEN RAISE EXCEPTION 'Delivery key collision; original retained'; END IF;
    RETURN d;
  END IF;
  SELECT proof_revision INTO proof FROM public.webhook_financial_evidence WHERE inbox_id=p_inbox;
  f:=public.receipt_delivery_facts(p_inbox,p_account,p_raw,p_normalized,proof);
  FOR s IN SELECT DISTINCT (value->>'merchant')::uuid AS merchant,value->>'currency' AS currency
    FROM jsonb_array_elements(f->'barriers') WHERE value->>'merchant' IS NOT NULL ORDER BY merchant,currency LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(s.merchant::text||':'||s.currency,0));
    PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=s.merchant AND currency=s.currency FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical delivery scope required'; END IF;
  END LOOP;
  locked_f:=public.receipt_delivery_facts(p_inbox,p_account,p_raw,p_normalized,proof);
  IF locked_f IS DISTINCT FROM f THEN RAISE EXCEPTION 'Delivery provenance changed during authoritative locking'; END IF;
  IF f->>'classification'='CONFLICT' THEN
    INSERT INTO public.financial_evidence_reviews(inbox_id,review_key,reason,observations)
      VALUES(p_inbox,'receipt-delivery/'||delivery::text,'CONTRADICTORY',jsonb_build_object('contract','R0_2','delivery_id',delivery,
        'reason',f->>'reason','original_account',r.provider_account,'delivery_account',p_account)) RETURNING financial_evidence_reviews.id INTO review;
  END IF;
  INSERT INTO public.receipt_delivery_attempts(id,original_inbox_id,provider,provider_event_id,original_account,provider_account,
    delivery_key,raw_body,signature,headers,normalized_payload,normalization_version,verification_method,verification_version,
    original_proof_revision,classification,reason,operation,financially_relevant,review_id)
    VALUES(delivery,p_inbox,r.provider,f->>'event',r.provider_account,p_account,key,p_raw,p_signature,p_headers,p_normalized,1,'STRIPE_SDK',p_verifier,
      proof,f->>'classification',f->>'reason',f->>'operation',(f->>'relevant')::boolean,review) RETURNING * INTO d;
  FOR b IN SELECT value FROM jsonb_array_elements(f->'barriers') ORDER BY value->>'key' LOOP
    INSERT INTO public.receipt_intake_authority(provider,provider_account) VALUES(r.provider,b->>'account') ON CONFLICT DO NOTHING;
    SELECT evidence_revision INTO ir FROM public.receipt_intake_authority WHERE provider=r.provider AND provider_account=b->>'account';
    sr:=NULL;
    IF b->>'merchant' IS NULL THEN
      UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1
        WHERE provider=r.provider AND provider_account=b->>'account' RETURNING evidence_revision INTO ir;
    ELSE
      UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1
        WHERE merchant_id=(b->>'merchant')::uuid AND currency=b->>'currency' RETURNING evidence_revision INTO sr;
    END IF;
    INSERT INTO public.receipt_delivery_barriers(delivery_id,barrier_key,provider,provider_account,merchant_id,currency,
      review_id,scope_evidence_revision,intake_evidence_revision)
      VALUES(delivery,b->>'key',r.provider,b->>'account',(b->>'merchant')::uuid,b->>'currency',review,sr,ir);
  END LOOP;
  RETURN d;
END;
$$;
-- Preserve all R0 predicates/locks; add immutable conflict barriers to that same
-- staged reader. This reader is still not a policy/claim/financial permit.
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
  IF (p_scope_revision IS NOT NULL AND p_scope_revision<>scope_revision) OR (p_intake_revision IS NOT NULL AND p_intake_revision<>intake_revision) THEN
    RAISE EXCEPTION 'Stale receipt clearance revision'; END IF;
  IF EXISTS (SELECT 1 FROM public.receipt_admission_obligations o WHERE o.provider=p_provider AND o.provider_account=p_account
      AND o.merchant_id IS NULL AND o.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
    OR EXISTS (SELECT 1 FROM public.receipt_admission_obligations o WHERE o.merchant_id=p_merchant AND o.currency=p_currency
      AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW'))
    OR EXISTS (SELECT 1 FROM public.receipt_delivery_barriers b WHERE b.provider=p_provider AND b.provider_account=p_account AND b.merchant_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.receipt_delivery_barriers b WHERE b.merchant_id=p_merchant AND b.currency=p_currency)
    OR EXISTS (SELECT 1 FROM public.accounting_exceptions x WHERE x.merchant_id=p_merchant AND x.currency=p_currency AND x.status='OPEN') THEN
    RAISE EXCEPTION 'Receipt admission blocked by unresolved evidence or exception'; END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
DO $$ DECLARE owner_name text:='fintech_admission_'||md5(current_database()); f record;
BEGIN
  EXECUTE format('GRANT SELECT,INSERT ON public.receipt_delivery_attempts,public.receipt_delivery_barriers TO %I',owner_name);
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',owner_name);
  FOR f IN SELECT oid::regprocedure AS signature,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('receipt_delivery_facts','check_receipt_delivery_barriers','publish_verified_receipt_delivery') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,owner_name);
    IF f.prosecdef THEN EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,owner_name); END IF;
  END LOOP;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END $$;
REVOKE ALL ON public.receipt_delivery_attempts,public.receipt_delivery_barriers FROM PUBLIC;

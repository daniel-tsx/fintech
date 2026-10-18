-- B3.2 B.1: evidence foundation ONLY. Drain writers; install transactionally.
-- Existing allocation validators remain unchanged until the coordinated B.2 floor.
-- ACCESS EXCLUSIVE below covers additive columns/FKs and bounds the upgrade scan.
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog, pg_temp;
LOCK TABLE public.webhook_events, public.refund_capture_allocations,
  public.dispute_capture_allocations, public.dispute_hold_effects IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE public.financial_evidence_accounts (
  provider text NOT NULL CHECK (provider='STRIPE'),
  provider_account text NOT NULL CHECK (length(provider_account)>0),
  runtime_enforcement text NOT NULL DEFAULT 'UNINSTALLED' CHECK (runtime_enforcement='UNINSTALLED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,provider_account)
);
-- No configured account, verification attestation, proof or ACTIVE scope is backfilled.
CREATE TABLE public.provider_financial_receipts (
  inbox_id uuid PRIMARY KEY REFERENCES public.webhook_events(id),
  provider text NOT NULL,
  provider_account text NOT NULL,
  raw_body bytea NOT NULL CHECK (octet_length(raw_body)>0),
  signature text NOT NULL CHECK (length(signature)>0),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers)='object'),
  normalized_payload jsonb NOT NULL CHECK (jsonb_typeof(normalized_payload)='object'),
  normalization_version integer NOT NULL CHECK (normalization_version=1),
  verification_method text NOT NULL CHECK (verification_method='STRIPE_SDK'),
  verification_version text NOT NULL CHECK (length(verification_version)>0),
  received_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  FOREIGN KEY (provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account)
);
CREATE INDEX financial_receipts_account ON public.provider_financial_receipts(provider,provider_account);
CREATE TABLE public.provider_financial_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_account text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('COMMAND_RESULT','PROVIDER_LOOKUP')),
  source_key text NOT NULL CHECK (length(source_key)>0),
  object_kind text NOT NULL CHECK (object_kind IN ('REFUND','CAPTURE','DISPUTE')),
  provider_object_id text NOT NULL CHECK (length(provider_object_id)>0),
  payment_id uuid,
  merchant_id uuid,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  amount bigint CHECK (amount>0),
  outbox_id uuid REFERENCES public.outbox_events(id),
  command_key text,
  command_payload jsonb,
  refund_id uuid REFERENCES public.refunds(id),
  capture_attempt_id uuid REFERENCES public.payment_attempts(id),
  payment_intent_id text,
  charge_id text,
  provider_status text NOT NULL CHECK (length(provider_status)>0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  observed_at timestamptz NOT NULL,
  publisher_version text NOT NULL CHECK (length(publisher_version)>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,provider_account,source_kind,source_key),
  FOREIGN KEY (provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY (payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency),
  CHECK (source_kind<>'COMMAND_RESULT' OR
    (payment_id IS NOT NULL AND merchant_id IS NOT NULL AND currency IS NOT NULL AND amount IS NOT NULL
      AND outbox_id IS NOT NULL AND command_key IS NOT NULL AND command_payload IS NOT NULL
      AND ((object_kind='REFUND' AND refund_id IS NOT NULL AND capture_attempt_id IS NULL)
        OR (object_kind='CAPTURE' AND capture_attempt_id IS NOT NULL AND refund_id IS NULL))))
);
CREATE INDEX financial_observations_object ON public.provider_financial_observations(provider,provider_account,object_kind,provider_object_id);
CREATE INDEX financial_observations_outbox ON public.provider_financial_observations(outbox_id);
CREATE INDEX financial_observations_refund ON public.provider_financial_observations(refund_id);
CREATE INDEX financial_observations_capture ON public.provider_financial_observations(capture_attempt_id);
CREATE INDEX financial_observations_payment ON public.provider_financial_observations(payment_id,merchant_id,currency);
CREATE TABLE public.provider_financial_object_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_account text NOT NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('REFUND','DISPUTE')),
  provider_object_id text NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount>0),
  refund_id uuid,
  provider_dispute_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,provider_account,object_kind,provider_object_id),
  UNIQUE (id,payment_id,merchant_id,currency),
  FOREIGN KEY (provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY (payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency),
  FOREIGN KEY (refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency),
  CHECK (((object_kind='REFUND' AND starts_with(provider_object_id,'re_') AND refund_id IS NOT NULL AND provider_dispute_id IS NULL)
    OR (object_kind='DISPUTE' AND starts_with(provider_object_id,'dp_') AND provider_dispute_id=provider_object_id AND refund_id IS NULL)) IS TRUE)
);
CREATE INDEX financial_object_owner_payment ON public.provider_financial_object_owners(payment_id,merchant_id,currency);
CREATE INDEX financial_object_owner_refund ON public.provider_financial_object_owners(refund_id);
CREATE TABLE public.webhook_financial_evidence (
  inbox_id uuid PRIMARY KEY REFERENCES public.provider_financial_receipts(inbox_id),
  proof_revision integer NOT NULL CHECK (proof_revision=1),
  contract_version integer NOT NULL CHECK (contract_version=1),
  owner_binding_id uuid NOT NULL,
  provider text NOT NULL,
  provider_account text NOT NULL,
  provider_event_id text NOT NULL,
  external_type text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('refund.succeeded','refund.failed','dispute.opened','dispute.closed')),
  provider_object_id text NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL CHECK (amount>0 AND amount<=9007199254740991),
  refund_id uuid,
  provider_dispute_id text,
  dispute_id uuid REFERENCES public.disputes(id),
  payment_intent_id text NOT NULL CHECK (starts_with(payment_intent_id,'pi_')),
  charge_id text,
  outcome text,
  refund_observation_id uuid REFERENCES public.provider_financial_observations(id),
  -- Generated by the checked SQL builder. Every source is independently checked
  -- against protected observation/lot/original-journal records, not a caller label.
  capture_sources jsonb NOT NULL CHECK (jsonb_typeof(capture_sources)='array' AND jsonb_array_length(capture_sources)>0),
  attempt_revision integer NOT NULL CHECK (attempt_revision>=0),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  validator_version text NOT NULL CHECK (validator_version='B3_2_EVIDENCE_V1'),
  CHECK (((operation IN ('refund.succeeded','refund.failed') AND refund_id IS NOT NULL AND provider_dispute_id IS NULL AND dispute_id IS NULL AND outcome IS NULL)
    OR (operation IN ('dispute.opened','dispute.closed') AND refund_id IS NULL AND provider_dispute_id=provider_object_id
      AND ((operation='dispute.opened' AND outcome IS NULL) OR (operation='dispute.closed' AND outcome IN ('MERCHANT_WON','MERCHANT_LOST'))))) IS TRUE),
  UNIQUE (inbox_id,proof_revision,payment_id,merchant_id,currency),
  FOREIGN KEY (owner_binding_id,payment_id,merchant_id,currency) REFERENCES public.provider_financial_object_owners(id,payment_id,merchant_id,currency),
  FOREIGN KEY (refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency)
);
CREATE INDEX financial_evidence_binding ON public.webhook_financial_evidence(owner_binding_id);
CREATE INDEX financial_evidence_refund ON public.webhook_financial_evidence(refund_id);
CREATE INDEX financial_evidence_dispute ON public.webhook_financial_evidence(dispute_id);
CREATE INDEX financial_evidence_observation ON public.webhook_financial_evidence(refund_observation_id);
CREATE TABLE public.financial_evidence_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES public.webhook_events(id),
  review_key text NOT NULL CHECK (length(review_key)>0),
  reason text NOT NULL CHECK (reason IN ('UNRESOLVED','CONTRADICTORY','UNSUPPORTED')),
  observations jsonb NOT NULL CHECK (jsonb_typeof(observations)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbox_id,review_key)
);
--> statement-breakpoint
CREATE FUNCTION public.protect_financial_evidence() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Financial receipt, provenance, proof, owner and review evidence is immutable';
END;
$$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['financial_evidence_accounts','provider_financial_receipts','provider_financial_observations',
    'provider_financial_object_owners','webhook_financial_evidence','financial_evidence_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER immutable_evidence_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
  END LOOP;
END $$;
-- Leave the original payload trigger unchanged. A separate narrow header guard
-- does not require legacy status-only writers to read new private receipt data.
CREATE FUNCTION public.protect_receipted_webhook_headers() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.headers IS DISTINCT FROM OLD.headers AND EXISTS
      (SELECT 1 FROM public.provider_financial_receipts WHERE inbox_id=OLD.id) THEN
    RAISE EXCEPTION 'Webhook evidence fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipted_headers_immutable BEFORE UPDATE OF headers ON public.webhook_events
FOR EACH ROW EXECUTE FUNCTION public.protect_receipted_webhook_headers();
--> statement-breakpoint
CREATE FUNCTION public.financial_external_reference(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;
BEGIN
  IF value IS NULL OR value='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(value)='string' THEN result:=value#>>'{}';
  ELSIF jsonb_typeof(value)='object' AND jsonb_typeof(value->'id')='string' THEN result:=value->>'id';
  ELSE RAISE EXCEPTION 'Malformed provider reference'; END IF;
  IF result IS NULL OR length(result)=0 THEN RAISE EXCEPTION 'Empty provider reference'; END IF;
  RETURN result;
END;
$$;
CREATE FUNCTION public.financial_receipt_facts(p_inbox uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE;
  body jsonb; obj jsonb; d jsonb; meta jsonb; op text; kind text; result jsonb; k text; v text; n numeric;
BEGIN
  SELECT * INTO r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  IF NOT FOUND THEN RAISE EXCEPTION 'Verified original receipt unavailable'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox;
  body:=convert_from(r.raw_body,'UTF8')::jsonb; obj:=body#>'{data,object}'; meta:=obj->'metadata'; d:=w.payload->'data';
  IF meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object' THEN RAISE EXCEPTION 'Malformed original metadata'; END IF;
  IF r.provider IS DISTINCT FROM w.provider OR r.signature IS DISTINCT FROM w.signature
    OR r.normalized_payload IS DISTINCT FROM w.payload OR r.headers IS DISTINCT FROM w.headers
    OR body->>'id' IS DISTINCT FROM w.provider_event_id OR w.payload->>'id' IS DISTINCT FROM w.provider_event_id
    OR body->>'type' IS DISTINCT FROM w.payload->>'externalType' OR jsonb_typeof(obj) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Original signed and normalized receipt identity disagree';
  END IF;
  IF body ? 'account' AND (jsonb_typeof(body->'account') IS DISTINCT FROM 'string' OR body->>'account' IS DISTINCT FROM r.provider_account) THEN
    RAISE EXCEPTION 'Signed provider account contradicts configured receipt account'; END IF;
  IF body->>'type' IN ('refund.created','refund.updated','refund.failed') AND obj->>'object'='refund' THEN
    kind:='REFUND';
    IF obj->>'status'='succeeded' AND body->>'type'<>'refund.failed' THEN op:='refund.succeeded';
    ELSIF obj->>'status' IN ('failed','canceled') THEN op:='refund.failed'; END IF;
  ELSIF body->>'type'='charge.dispute.created' AND obj->>'object'='dispute'
    AND obj->>'status' IN ('needs_response','under_review','warning_needs_response','warning_under_review') THEN
    kind:='DISPUTE'; op:='dispute.opened';
  ELSIF body->>'type'='charge.dispute.closed' AND obj->>'object'='dispute' AND obj->>'status' IN ('won','lost') THEN
    kind:='DISPUTE'; op:='dispute.closed';
  END IF;
  IF op IS NULL THEN RAISE EXCEPTION 'Unsupported or unconfirmed financial outcome'; END IF;
  IF jsonb_typeof(obj->'amount') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Exact provider amount required'; END IF;
  n:=(obj->>'amount')::numeric;
  IF n<=0 OR n<>trunc(n) OR n>9007199254740991 OR (obj->>'currency') !~ '^[A-Za-z]{3}$'
    OR obj->>'currency' IS NULL OR obj->>'id' IS NULL THEN RAISE EXCEPTION 'Invalid financial amount, currency or object'; END IF;
  result:=jsonb_build_object('operation',op,'object_kind',kind,'provider_object_id',obj->>'id','amount',n::bigint,
    'currency',upper(obj->>'currency'),'payment_intent_id',public.financial_external_reference(obj->'payment_intent'),
    'charge_id',public.financial_external_reference(obj->'charge'),'outcome',CASE WHEN op='dispute.closed'
      THEN CASE WHEN obj->>'status'='won' THEN 'MERCHANT_WON' ELSE 'MERCHANT_LOST' END END);
  FOREACH k IN ARRAY ARRAY['merchantId','paymentId','refundId'] LOOP
    v:=meta->>k;
    IF meta ? k THEN
      IF v IS NULL OR length(v)=0 OR jsonb_typeof(meta->k)<>'string' THEN RAISE EXCEPTION 'Malformed original owner metadata'; END IF;
      PERFORM v::uuid;
    END IF;
    result:=result||jsonb_build_object(k,v);
  END LOOP;
  IF w.payload->>'type' IS DISTINCT FROM op AND w.payload->>'type' IS DISTINCT FROM 'provider.unsupported' THEN
    RAISE EXCEPTION 'Normalized financial operation contradicts original receipt';
  END IF;
  IF w.payload->>'type'='provider.unsupported' AND d IS NOT NULL AND d<>'null'::jsonb THEN
    RAISE EXCEPTION 'Unsupported normalized receipt has unexpected data';
  END IF;
  IF w.payload->>'type'=op AND jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Normalized evidence data required'; END IF;
  FOREACH k IN ARRAY ARRAY['merchantId','paymentId','refundId'] LOOP
    IF d ? k AND d->k<>'null'::jsonb AND (d->>k IS DISTINCT FROM result->>k OR length(d->>k)=0) THEN
      RAISE EXCEPTION 'Normalized owner disagrees with signed original';
    END IF;
  END LOOP;
  IF (d ? 'amount' AND (jsonb_typeof(d->'amount') IS DISTINCT FROM 'number' OR (d->>'amount')::numeric IS DISTINCT FROM n))
    OR (d ? 'currency' AND upper(d->>'currency') IS DISTINCT FROM result->>'currency')
    OR (d ? 'providerTransactionId' AND d->>'providerTransactionId' IS DISTINCT FROM result->>'provider_object_id')
    OR (d ? 'providerDisputeId' AND d->>'providerDisputeId' IS DISTINCT FROM (CASE WHEN kind='DISPUTE' THEN result->>'provider_object_id' END))
    OR (d ? 'paymentIntentId' AND d->>'paymentIntentId' IS DISTINCT FROM result->>'payment_intent_id')
    OR (d ? 'chargeId' AND d->>'chargeId' IS DISTINCT FROM result->>'charge_id')
    OR (d ? 'outcome' AND d->>'outcome' IS DISTINCT FROM result->>'outcome') THEN
    RAISE EXCEPTION 'Normalized financial facts contradict signed original';
  END IF;
  RETURN result;
END;
$$;
CREATE FUNCTION public.validate_financial_publisher_input() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; command public.outbox_events%ROWTYPE;
  child record; expected_key text;
BEGIN
  IF TG_TABLE_NAME='provider_financial_receipts' THEN
    -- One private inbox precedes the account intake lock, including FK waits.
    SELECT * INTO STRICT w FROM public.webhook_events WHERE id=NEW.inbox_id FOR UPDATE;
    -- Change the MVCC row version without altering evidence/timestamps. A stale
    -- RR header writer must abort rather than miss this receipt in its snapshot.
    UPDATE public.webhook_events SET updated_at=updated_at WHERE id=NEW.inbox_id;
  END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=NEW.provider AND provider_account=NEW.provider_account FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured evidence account required'; END IF;
  IF TG_TABLE_NAME='provider_financial_receipts' THEN
    IF (NEW.provider,NEW.signature,NEW.headers,NEW.normalized_payload)
      IS DISTINCT FROM (w.provider,w.signature,w.headers,w.payload) THEN RAISE EXCEPTION 'Receipt must preserve original inbox evidence'; END IF;
    -- Full mapping is checked by financial_receipt_facts after INSERT/sealing.
    RETURN NEW;
  END IF;
  IF NEW.source_kind='COMMAND_RESULT' THEN
    SELECT * INTO STRICT command FROM public.outbox_events WHERE id=NEW.outbox_id;
    IF NEW.object_kind='REFUND' THEN
      SELECT id,payment_id,merchant_id,currency,amount INTO STRICT child FROM public.refunds WHERE id=NEW.refund_id;
      expected_key:='refund:'||child.id::text;
    ELSE
      SELECT id,payment_id,merchant_id,currency,amount INTO STRICT child FROM public.payment_attempts WHERE id=NEW.capture_attempt_id AND kind='CAPTURE';
      expected_key:='capture:'||child.id::text;
    END IF;
    IF (NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.amount) IS DISTINCT FROM (child.payment_id,child.merchant_id,child.currency,child.amount)
      OR NEW.command_key IS DISTINCT FROM expected_key OR NEW.command_payload IS DISTINCT FROM command.payload
      OR command.aggregate_id IS DISTINCT FROM child.id
      OR command.event_type IS DISTINCT FROM (CASE WHEN NEW.object_kind='REFUND' THEN 'provider.refund.requested' ELSE 'provider.capture.requested' END)
      OR command.payload->>'idempotencyKey' IS DISTINCT FROM expected_key
      OR command.payload->>'paymentId' IS DISTINCT FROM NEW.payment_id::text
      OR command.payload->>'merchantId' IS DISTINCT FROM NEW.merchant_id::text
      OR command.payload->>'currency' IS DISTINCT FROM NEW.currency
      OR (command.payload->>'amount')::numeric IS DISTINCT FROM NEW.amount::numeric
      OR command.payload->>(CASE WHEN NEW.object_kind='REFUND' THEN 'refundId' ELSE 'attemptId' END) IS DISTINCT FROM child.id::text
      OR NEW.payment_intent_id IS NULL OR NOT starts_with(NEW.payment_intent_id,'pi_')
      OR command.payload->>'providerPaymentId' IS DISTINCT FROM NEW.payment_intent_id
      OR (NEW.object_kind='CAPTURE' AND NEW.provider_object_id IS DISTINCT FROM NEW.payment_intent_id) THEN
      RAISE EXCEPTION 'Trusted observation contradicts accepted owned command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_original BEFORE INSERT ON public.provider_financial_receipts FOR EACH ROW EXECUTE FUNCTION public.validate_financial_publisher_input();
CREATE TRIGGER observation_original BEFORE INSERT ON public.provider_financial_observations FOR EACH ROW EXECUTE FUNCTION public.validate_financial_publisher_input();
--> statement-breakpoint
-- This is the single interpretation used by both sealer and reader. It derives
-- identity from immutable receipts/observations and protected original captures.
CREATE FUNCTION public.build_financial_evidence(p_inbox uuid,p_observation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE f jsonb; r public.provider_financial_receipts%ROWTYPE; ref public.refunds%ROWTYPE;
  observation public.provider_financial_observations%ROWTYPE; p uuid; m uuid; cur text;
  pi text; object_id text; sources jsonb:='[]'::jsonb; lot record; obs record; command record;
  ids uuid[]; source_ids uuid[]; owners integer; dispute_uuid uuid; found_amount numeric;
BEGIN
  f:=public.financial_receipt_facts(p_inbox);
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  object_id:=f->>'provider_object_id';
  IF f->>'object_kind'='REFUND' THEN
    IF NOT starts_with(object_id,'re_') THEN RAISE EXCEPTION 'Refund object identity required'; END IF;
    IF p_observation IS NOT NULL THEN
      SELECT * INTO STRICT observation FROM public.provider_financial_observations WHERE id=p_observation
        AND provider=r.provider AND provider_account=r.provider_account AND source_kind='COMMAND_RESULT'
        AND object_kind='REFUND' AND provider_object_id=object_id;
    END IF;
    IF f->>'refundId' IS NULL AND observation.id IS NULL THEN RAISE EXCEPTION 'Unresolved refund: immutable owned command-result witness required'; END IF;
    SELECT * INTO STRICT ref FROM public.refunds WHERE id=coalesce((f->>'refundId')::uuid,observation.refund_id);
    IF observation.id IS NOT NULL AND observation.refund_id IS DISTINCT FROM ref.id THEN RAISE EXCEPTION 'Contradictory refund observation'; END IF;
    IF observation.id IS NOT NULL AND (observation.payment_id,observation.merchant_id,observation.currency,observation.amount)
      IS DISTINCT FROM (ref.payment_id,ref.merchant_id,ref.currency,ref.amount) THEN RAISE EXCEPTION 'Refund observation ownership or amount changed'; END IF;
    IF EXISTS (SELECT 1 FROM public.provider_financial_observations o WHERE o.provider=r.provider AND o.provider_account=r.provider_account
      AND o.source_kind='COMMAND_RESULT' AND o.object_kind='REFUND' AND o.provider_object_id=object_id AND o.refund_id IS DISTINCT FROM ref.id) THEN
      RAISE EXCEPTION 'Multiple provider-object owner candidates';
    END IF;
    p:=ref.payment_id; m:=ref.merchant_id; cur:=ref.currency;
    IF (ref.status='SUCCEEDED' AND f->>'operation'<>'refund.succeeded') OR (ref.status='FAILED' AND f->>'operation'<>'refund.failed') THEN
      RAISE EXCEPTION 'Confirmed outcome contradicts terminal refund evidence'; END IF;
    IF ref.amount::numeric IS DISTINCT FROM (f->>'amount')::numeric OR ref.currency IS DISTINCT FROM f->>'currency'
      OR (ref.provider_transaction_id IS NOT NULL AND ref.provider_transaction_id IS DISTINCT FROM object_id) THEN
      RAISE EXCEPTION 'Receipt contradicts accepted refund amount, currency or object'; END IF;
    SELECT * INTO STRICT command FROM public.outbox_events WHERE aggregate_id=ref.id AND event_type='provider.refund.requested'
      AND payload->>'idempotencyKey'='refund:'||ref.id::text;
    IF NOT FOUND OR command.payload->>'refundId' IS DISTINCT FROM ref.id::text OR command.payload->>'paymentId' IS DISTINCT FROM p::text
      OR command.payload->>'merchantId' IS DISTINCT FROM m::text OR command.payload->>'currency' IS DISTINCT FROM cur
      OR (command.payload->>'amount')::numeric IS DISTINCT FROM ref.amount::numeric THEN RAISE EXCEPTION 'Accepted refund command evidence unavailable'; END IF;
    SELECT array_agg(a.capture_lot_id ORDER BY a.capture_lot_id),sum(a.reserved_gross) INTO ids,found_amount
      FROM public.refund_capture_allocations a WHERE a.refund_id=ref.id;
    IF found_amount IS DISTINCT FROM ref.amount::numeric THEN RAISE EXCEPTION 'Trustworthy frozen refund attribution required'; END IF;
    pi:=command.payload->>'providerPaymentId';
  ELSE
    IF NOT starts_with(object_id,'dp_') THEN RAISE EXCEPTION 'Dispute object identity required'; END IF;
    IF p_observation IS NOT NULL THEN RAISE EXCEPTION 'Dispute ownership uses original captures, not a refund witness'; END IF;
    SELECT count(DISTINCT l.payment_id),min(l.payment_id::text)::uuid INTO owners,p FROM public.capture_accounting_lots l
      JOIN public.provider_financial_observations o ON o.capture_attempt_id=l.capture_attempt_id AND o.source_kind='COMMAND_RESULT' AND o.object_kind='CAPTURE'
      WHERE o.provider=r.provider AND o.provider_account=r.provider_account AND o.provider_status IN ('succeeded','requires_capture')
        AND ((f->>'payment_intent_id' IS NOT NULL AND o.payment_intent_id=f->>'payment_intent_id')
          OR (f->>'payment_intent_id' IS NULL AND f->>'charge_id' IS NOT NULL AND o.charge_id=f->>'charge_id'));
    IF owners<>1 THEN RAISE EXCEPTION 'Unresolved or ambiguous dispute capture ownership'; END IF;
    SELECT merchant_id,currency INTO STRICT m,cur FROM public.payments WHERE id=p;
    SELECT array_agg(DISTINCT l.id ORDER BY l.id) INTO ids FROM public.capture_accounting_lots l
      JOIN public.provider_financial_observations o ON o.capture_attempt_id=l.capture_attempt_id AND o.source_kind='COMMAND_RESULT' AND o.object_kind='CAPTURE'
      WHERE l.payment_id=p AND o.provider=r.provider AND o.provider_account=r.provider_account AND o.provider_status IN ('succeeded','requires_capture')
        AND ((f->>'payment_intent_id' IS NOT NULL AND o.payment_intent_id=f->>'payment_intent_id')
          OR (f->>'payment_intent_id' IS NULL AND f->>'charge_id' IS NOT NULL AND o.charge_id=f->>'charge_id'));
    SELECT id INTO dispute_uuid FROM public.disputes WHERE provider_dispute_id=object_id;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM public.disputes WHERE id=dispute_uuid AND payment_id=p AND merchant_id=m AND currency=cur AND amount=(f->>'amount')::bigint) THEN
      RAISE EXCEPTION 'Recorded dispute owner or principal contradicts receipt'; END IF;
    IF f->>'operation'='dispute.closed' AND EXISTS (SELECT 1 FROM public.disputes WHERE id=dispute_uuid AND status='CLOSED' AND outcome IS DISTINCT FROM f->>'outcome') THEN
      RAISE EXCEPTION 'Confirmed outcome contradicts terminal dispute evidence'; END IF;
    pi:=f->>'payment_intent_id';
  END IF;
  IF (f->>'paymentId' IS NOT NULL AND (f->>'paymentId')::uuid<>p)
    OR (f->>'merchantId' IS NOT NULL AND (f->>'merchantId')::uuid<>m) OR cur IS DISTINCT FROM f->>'currency' THEN
    RAISE EXCEPTION 'Explicit original ownership contradicts canonical financial owner'; END IF;
  IF ids IS NULL OR cardinality(ids)=0 THEN RAISE EXCEPTION 'Original capture evidence required'; END IF;
  FOREACH p_observation IN ARRAY ids LOOP
    SELECT l.*,a.provider_transaction_id,a.status AS attempt_status,v.original_valid,v.journal_id AS verified_journal
      INTO STRICT lot FROM public.capture_accounting_lots l JOIN public.payment_attempts a ON a.id=l.capture_attempt_id
      JOIN public.capture_accounting_legacy_inventory v ON v.capture_attempt_id=l.capture_attempt_id WHERE l.id=p_observation;
    IF lot.payment_id<>p OR lot.merchant_id<>m OR lot.currency<>cur OR NOT lot.original_valid
      OR lot.verified_journal IS DISTINCT FROM lot.capture_journal_id OR lot.attempt_status<>'SUCCEEDED' THEN
      RAISE EXCEPTION 'Invalid original capture ownership or immutable journal'; END IF;
    SELECT array_agg(o.id ORDER BY o.id) INTO source_ids FROM public.provider_financial_observations o
      WHERE o.capture_attempt_id=lot.capture_attempt_id AND o.provider=r.provider AND o.provider_account=r.provider_account
        AND o.source_kind='COMMAND_RESULT' AND o.object_kind='CAPTURE' AND o.provider_status IN ('succeeded','requires_capture');
    IF source_ids IS NULL THEN RAISE EXCEPTION 'Trusted original capture command result required'; END IF;
    FOREACH p_observation IN ARRAY source_ids LOOP
      SELECT * INTO STRICT obs FROM public.provider_financial_observations WHERE id=p_observation;
      IF (obs.payment_id,obs.merchant_id,obs.currency,obs.amount) IS DISTINCT FROM (p,m,cur,lot.original_gross)
        OR obs.payment_intent_id IS DISTINCT FROM lot.provider_transaction_id
        OR (pi IS NOT NULL AND obs.payment_intent_id IS DISTINCT FROM pi)
        OR (f->>'payment_intent_id' IS NOT NULL AND obs.payment_intent_id IS DISTINCT FROM f->>'payment_intent_id')
        OR (f->>'charge_id' IS NOT NULL AND obs.charge_id IS NOT NULL AND obs.charge_id IS DISTINCT FROM f->>'charge_id')
        OR (f->>'payment_intent_id' IS NULL AND f->>'object_kind'='DISPUTE' AND obs.charge_id IS DISTINCT FROM f->>'charge_id') THEN
        RAISE EXCEPTION 'Capture provider provenance contradicts original PI, Charge or owner'; END IF;
      pi:=obs.payment_intent_id;
    END LOOP;
    sources:=sources||jsonb_build_array(jsonb_build_object('lot_id',lot.id,'attempt_id',lot.capture_attempt_id,
      'journal_id',lot.capture_journal_id,'gross',lot.original_gross::text,'fee',lot.original_fee::text,'net',lot.original_net::text,
      'captured_at',lot.financial_captured_at,'observation_ids',source_ids));
  END LOOP;
  IF pi IS NULL OR NOT starts_with(pi,'pi_') THEN RAISE EXCEPTION 'Canonical captured PaymentIntent required'; END IF;
  IF f->>'object_kind'='REFUND' AND observation.id IS NOT NULL AND observation.payment_intent_id IS DISTINCT FROM pi THEN
    RAISE EXCEPTION 'Refund command result contradicts frozen captures'; END IF;
  -- Validate current owned mirror facts before any caller can synchronize them.
  IF EXISTS (SELECT 1 FROM public.provider_transactions t WHERE t.provider=r.provider
    AND ((ref.id IS NOT NULL AND t.operation='REFUND' AND t.refund_id=ref.id AND t.provider_idempotency_key='refund:'||ref.id::text)
      OR (t.operation='CAPTURE' AND t.payment_attempt_id IN (SELECT capture_attempt_id FROM public.capture_accounting_lots WHERE id=ANY(ids))
        AND t.provider_idempotency_key='capture:'||t.payment_attempt_id::text))
    AND (t.payment_id IS DISTINCT FROM p OR t.merchant_id IS DISTINCT FROM m OR t.currency IS DISTINCT FROM cur
      OR (t.payment_intent_id IS NOT NULL AND t.payment_intent_id IS DISTINCT FROM pi)
      OR (f->>'charge_id' IS NOT NULL AND t.charge_id IS NOT NULL AND t.charge_id IS DISTINCT FROM f->>'charge_id')
      OR (t.operation='REFUND' AND (t.provider_transaction_id IS DISTINCT FROM object_id OR t.amount IS DISTINCT FROM ref.amount))
      OR (t.operation='CAPTURE' AND (t.provider_transaction_id IS DISTINCT FROM pi OR t.amount IS DISTINCT FROM
        (SELECT original_gross FROM public.capture_accounting_lots WHERE capture_attempt_id=t.payment_attempt_id))))) THEN
    RAISE EXCEPTION 'Owned provider mirror contradicts immutable evidence'; END IF;
  RETURN f||jsonb_build_object('payment_id',p,'merchant_id',m,'refund_id',ref.id,'dispute_id',dispute_uuid,
    'provider_dispute_id',CASE WHEN f->>'object_kind'='DISPUTE' THEN object_id END,'payment_intent_id',pi,
    'capture_sources',sources,'refund_observation_id',observation.id);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.load_effective_financial_evidence(p_inbox uuid,p_revision integer,p_operation text)
RETURNS public.webhook_financial_evidence
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.webhook_financial_evidence%ROWTYPE; b public.provider_financial_object_owners%ROWTYPE;
  r public.provider_financial_receipts%ROWTYPE; f jsonb; s jsonb; o uuid; l public.capture_accounting_lots%ROWTYPE;
BEGIN
  IF p_inbox IS NULL OR p_revision IS NULL OR p_operation IS NULL THEN RAISE EXCEPTION 'Exact inbox, proof revision and operation required'; END IF;
  SELECT * INTO e FROM public.webhook_financial_evidence WHERE inbox_id=p_inbox AND proof_revision=p_revision AND operation=p_operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing or incompatible sealed proof revision/operation'; END IF;
  SELECT * INTO STRICT b FROM public.provider_financial_object_owners WHERE id=e.owner_binding_id;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  f:=public.financial_receipt_facts(p_inbox);
  IF (e.provider,e.provider_account,e.provider_event_id,e.external_type,e.provider_object_id,e.amount,e.currency,e.operation,e.outcome)
    IS DISTINCT FROM (r.provider,r.provider_account,r.normalized_payload->>'id',r.normalized_payload->>'externalType',
      f->>'provider_object_id',(f->>'amount')::bigint,f->>'currency',f->>'operation',f->>'outcome')
    OR (e.payment_id,e.merchant_id,e.currency,e.amount,e.refund_id,e.provider_dispute_id)
      IS DISTINCT FROM (b.payment_id,b.merchant_id,b.currency,b.amount,b.refund_id,b.provider_dispute_id)
    OR (e.provider,e.provider_account,e.provider_object_id) IS DISTINCT FROM (b.provider,b.provider_account,b.provider_object_id)
    OR b.object_kind IS DISTINCT FROM f->>'object_kind'
    OR (f->>'paymentId' IS NOT NULL AND (f->>'paymentId')::uuid<>e.payment_id)
    OR (f->>'merchantId' IS NOT NULL AND (f->>'merchantId')::uuid<>e.merchant_id)
    OR (f->>'refundId' IS NOT NULL AND (f->>'refundId')::uuid IS DISTINCT FROM e.refund_id)
    OR (f->>'payment_intent_id' IS NOT NULL AND f->>'payment_intent_id' IS DISTINCT FROM e.payment_intent_id)
    OR f->>'charge_id' IS DISTINCT FROM e.charge_id THEN RAISE EXCEPTION 'Sealed proof contradicts original receipt or owned binding'; END IF;
  IF f->>'object_kind'='REFUND' AND f->>'refundId' IS NULL AND NOT EXISTS
    (SELECT 1 FROM public.provider_financial_observations WHERE id=e.refund_observation_id AND source_kind='COMMAND_RESULT'
      AND object_kind='REFUND' AND refund_id=e.refund_id AND provider=e.provider AND provider_account=e.provider_account
      AND provider_object_id=e.provider_object_id AND payment_id=e.payment_id AND merchant_id=e.merchant_id AND currency=e.currency AND amount=e.amount) THEN
    RAISE EXCEPTION 'Immutable refund witness missing'; END IF;
  IF e.dispute_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.disputes WHERE id=e.dispute_id AND payment_id=e.payment_id
    AND merchant_id=e.merchant_id AND currency=e.currency AND amount=e.amount AND provider_dispute_id=e.provider_dispute_id) THEN
    RAISE EXCEPTION 'Sealed internal dispute identity disagrees'; END IF;
  -- Read frozen provenance, never reinterpret historical proof from today's mirrors.
  FOR s IN SELECT value FROM jsonb_array_elements(e.capture_sources) LOOP
    SELECT * INTO STRICT l FROM public.capture_accounting_lots WHERE id=(s->>'lot_id')::uuid;
    IF (l.payment_id,l.merchant_id,l.currency,l.capture_attempt_id,l.capture_journal_id,l.original_gross,l.original_fee,l.original_net)
      IS DISTINCT FROM (e.payment_id,e.merchant_id,e.currency,(s->>'attempt_id')::uuid,(s->>'journal_id')::uuid,
        (s->>'gross')::bigint,(s->>'fee')::bigint,(s->>'net')::bigint)
      OR l.financial_captured_at IS DISTINCT FROM (s->>'captured_at')::timestamptz
      OR NOT EXISTS (SELECT 1 FROM public.ledger_transactions WHERE id=l.capture_journal_id AND status='POSTED'
        AND business_type='CAPTURE' AND business_id=l.capture_attempt_id AND merchant_id=e.merchant_id AND currency=e.currency) THEN
      RAISE EXCEPTION 'Frozen capture source or original journal disagrees'; END IF;
    IF jsonb_typeof(s->'observation_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'observation_ids')=0 THEN RAISE EXCEPTION 'Capture provenance required'; END IF;
    FOR o IN SELECT value::uuid FROM jsonb_array_elements_text(s->'observation_ids') LOOP
      IF NOT EXISTS (SELECT 1 FROM public.provider_financial_observations WHERE id=o AND provider=e.provider AND provider_account=e.provider_account
        AND object_kind='CAPTURE' AND source_kind='COMMAND_RESULT' AND capture_attempt_id=l.capture_attempt_id
        AND payment_id=e.payment_id AND merchant_id=e.merchant_id AND currency=e.currency AND amount=l.original_gross
        AND payment_intent_id=e.payment_intent_id AND provider_status IN ('succeeded','requires_capture')
        AND (e.charge_id IS NULL OR charge_id IS NULL OR charge_id=e.charge_id)
        AND (f->>'object_kind'<>'DISPUTE' OR f->>'payment_intent_id' IS NOT NULL OR charge_id=e.charge_id)) THEN
        RAISE EXCEPTION 'Frozen trusted capture observation missing'; END IF;
    END LOOP;
  END LOOP;
  RETURN e;
END;
$$;
CREATE FUNCTION public.seal_financial_correlation(p_inbox uuid,p_attempt_revision integer,p_observation uuid DEFAULT NULL)
RETURNS public.webhook_financial_evidence
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; r public.provider_financial_receipts%ROWTYPE; f jsonb;
  b public.provider_financial_object_owners%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE; p uuid; m uuid;
BEGIN
  IF p_inbox IS NULL OR p_attempt_revision IS NULL THEN RAISE EXCEPTION 'Inbox and expected attempt revision required'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Evidence sealing requires READ COMMITTED authoritative rereads'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF w.attempts<>p_attempt_revision THEN RAISE EXCEPTION 'Correlation attempt revision changed'; END IF;
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  -- B.1's narrow intake serialization is not settlement/payout admission.
  -- B.2 must join the reviewed intake/permit prefix before financial application.
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=r.provider_account FOR UPDATE;
  SELECT * INTO e FROM public.webhook_financial_evidence WHERE inbox_id=p_inbox;
  IF FOUND THEN
    IF p_observation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.provider_financial_observations WHERE id=p_observation
      AND source_kind='COMMAND_RESULT' AND object_kind='REFUND' AND refund_id=e.refund_id AND provider=e.provider AND provider_account=e.provider_account
      AND provider_object_id=e.provider_object_id AND payment_id=e.payment_id AND merchant_id=e.merchant_id AND currency=e.currency AND amount=e.amount
      AND payment_intent_id=e.payment_intent_id) THEN RAISE EXCEPTION 'Replay observation contradicts original sealed proof'; END IF;
    RETURN public.load_effective_financial_evidence(p_inbox,e.proof_revision,e.operation);
  END IF;
  f:=public.build_financial_evidence(p_inbox,p_observation); p:=(f->>'payment_id')::uuid; m:=(f->>'merchant_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended(m::text||':'||(f->>'currency'),0));
  PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=m AND currency=f->>'currency' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned accounting scope required'; END IF;
  PERFORM 1 FROM public.payments WHERE id=p AND merchant_id=m FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=p AND kind='CAPTURE' ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.refunds WHERE payment_id=p ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.disputes WHERE payment_id=p ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.capture_accounting_lots WHERE payment_id=p ORDER BY capture_attempt_id FOR UPDATE;
  PERFORM 1 FROM public.dispute_capture_allocations WHERE payment_id=p ORDER BY capture_lot_id,id FOR UPDATE;
  PERFORM 1 FROM public.refund_capture_allocations WHERE payment_id=p ORDER BY capture_lot_id,id FOR UPDATE;
  f:=public.build_financial_evidence(p_inbox,p_observation);
  IF p IS DISTINCT FROM (f->>'payment_id')::uuid OR m IS DISTINCT FROM (f->>'merchant_id')::uuid THEN RAISE EXCEPTION 'Owner changed during locked revalidation'; END IF;
  INSERT INTO public.provider_financial_object_owners (provider,provider_account,object_kind,provider_object_id,payment_id,merchant_id,currency,amount,refund_id,provider_dispute_id)
    VALUES (r.provider,r.provider_account,f->>'object_kind',f->>'provider_object_id',p,m,f->>'currency',(f->>'amount')::bigint,(f->>'refund_id')::uuid,f->>'provider_dispute_id')
    ON CONFLICT (provider,provider_account,object_kind,provider_object_id) DO NOTHING;
  SELECT * INTO STRICT b FROM public.provider_financial_object_owners WHERE provider=r.provider AND provider_account=r.provider_account
    AND object_kind=f->>'object_kind' AND provider_object_id=f->>'provider_object_id';
  IF (b.payment_id,b.merchant_id,b.currency,b.amount,b.refund_id,b.provider_dispute_id)
    IS DISTINCT FROM (p,m,f->>'currency',(f->>'amount')::bigint,(f->>'refund_id')::uuid,f->>'provider_dispute_id') THEN
    RAISE EXCEPTION 'Provider object already bound to another financial owner'; END IF;
  INSERT INTO public.webhook_financial_evidence (inbox_id,proof_revision,contract_version,owner_binding_id,provider,provider_account,provider_event_id,
    external_type,operation,provider_object_id,payment_id,merchant_id,currency,amount,refund_id,provider_dispute_id,dispute_id,payment_intent_id,charge_id,
    outcome,refund_observation_id,capture_sources,attempt_revision,validator_version)
    VALUES (p_inbox,1,1,b.id,r.provider,r.provider_account,w.provider_event_id,w.payload->>'externalType',f->>'operation',f->>'provider_object_id',p,m,
      f->>'currency',(f->>'amount')::bigint,(f->>'refund_id')::uuid,f->>'provider_dispute_id',(f->>'dispute_id')::uuid,f->>'payment_intent_id',
      f->>'charge_id',f->>'outcome',(f->>'refund_observation_id')::uuid,f->'capture_sources',p_attempt_revision,'B3_2_EVIDENCE_V1');
  RETURN public.load_effective_financial_evidence(p_inbox,1,f->>'operation');
END;
$$;
--> statement-breakpoint
-- Required future financial references are present, but deliberately cannot be
-- used before the B.2 SQL/service/disposition floor. This is a DDL gate, not a flag.
ALTER TABLE public.refund_capture_allocations
  ADD COLUMN evidence_contract_version integer NOT NULL DEFAULT 0,
  ADD COLUMN proof_revision integer,
  ADD CONSTRAINT refund_evidence_floor_closed CHECK (evidence_contract_version=0 AND proof_revision IS NULL),
  ADD CONSTRAINT refund_sealed_proof FOREIGN KEY (provider_event_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency);
ALTER TABLE public.dispute_capture_allocations
  ADD COLUMN evidence_contract_version integer NOT NULL DEFAULT 0,
  ADD COLUMN open_inbox_id uuid,
  ADD COLUMN open_proof_revision integer,
  ADD COLUMN close_inbox_id uuid,
  ADD COLUMN close_proof_revision integer,
  ADD CONSTRAINT dispute_evidence_floor_closed CHECK (evidence_contract_version=0 AND open_inbox_id IS NULL AND open_proof_revision IS NULL AND close_inbox_id IS NULL AND close_proof_revision IS NULL),
  ADD CONSTRAINT dispute_open_sealed_proof FOREIGN KEY (open_inbox_id,open_proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency),
  ADD CONSTRAINT dispute_close_sealed_proof FOREIGN KEY (close_inbox_id,close_proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency);
ALTER TABLE public.dispute_hold_effects
  ADD COLUMN evidence_contract_version integer NOT NULL DEFAULT 0,
  ADD COLUMN proof_revision integer,
  ADD CONSTRAINT hold_evidence_floor_closed CHECK (evidence_contract_version=0 AND proof_revision IS NULL),
  ADD CONSTRAINT hold_sealed_proof FOREIGN KEY (provider_event_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency);
CREATE INDEX refund_proof_reference ON public.refund_capture_allocations(provider_event_id,proof_revision);
CREATE INDEX dispute_open_proof_reference ON public.dispute_capture_allocations(open_inbox_id,open_proof_revision);
CREATE INDEX dispute_close_proof_reference ON public.dispute_capture_allocations(close_inbox_id,close_proof_revision);
CREATE INDEX hold_proof_reference ON public.dispute_hold_effects(provider_event_id,proof_revision);
CREATE FUNCTION public.assert_financial_evidence_runtime_ready() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Financial evidence runtime enforcement is UNINSTALLED; reviewed B.2 forward migration and adapters required'; END;
$$;
--> statement-breakpoint
-- Dedicated per-database non-login function owner. No password, membership or
-- existing login/session is modified. Installation needs CREATEROLE and function
-- ownership authority. Do not grant this owner role to application workers.
DO $$ DECLARE owner_name text:='fintech_evidence_'||md5(current_database()); f record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=owner_name) THEN
    RAISE EXCEPTION 'Evidence sealer owner already exists; inspect incomplete installation before retry';
  END IF;
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.financial_evidence_accounts, public.provider_financial_receipts, public.provider_financial_observations,
    public.provider_financial_object_owners, public.webhook_financial_evidence, public.webhook_events, public.outbox_events,
    public.payments, public.payment_attempts, public.refunds, public.disputes, public.capture_accounting_scopes, public.capture_accounting_lots,
    public.refund_capture_allocations, public.dispute_capture_allocations, public.provider_transactions,
    public.capture_accounting_legacy_inventory, public.ledger_transactions, public.ledger_entries, public.ledger_accounts TO %I',owner_name);
  -- PostgreSQL row-locking SELECT needs UPDATE permission on at least one column.
  -- Grant only nonfinancial columns; protected accounts/lots still reject UPDATE.
  EXECUTE format('GRANT UPDATE (created_at) ON public.financial_evidence_accounts, public.capture_accounting_lots, public.refund_capture_allocations, public.dispute_capture_allocations TO %I',owner_name);
  EXECUTE format('GRANT UPDATE (updated_at) ON public.webhook_events, public.payments, public.payment_attempts, public.refunds, public.disputes TO %I',owner_name);
  EXECUTE format('GRANT UPDATE (created_at) ON public.capture_accounting_scopes TO %I',owner_name);
  EXECUTE format('GRANT INSERT ON public.provider_financial_object_owners, public.webhook_financial_evidence TO %I',owner_name);
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('protect_financial_evidence','protect_receipted_webhook_headers','financial_external_reference','financial_receipt_facts','validate_financial_publisher_input',
     'build_financial_evidence','load_effective_financial_evidence','seal_financial_correlation','assert_financial_evidence_runtime_ready') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,owner_name);
  END LOOP;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('ALTER FUNCTION public.seal_financial_correlation(uuid,integer,uuid) OWNER TO %I',owner_name);
  EXECUTE format('ALTER FUNCTION public.protect_receipted_webhook_headers() OWNER TO %I',owner_name);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
  -- Original migration owner can exercise/review the API. Ordinary worker and
  -- receipt/result publisher grants are deliberately not installed by B.1.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.seal_financial_correlation(uuid,integer,uuid) TO %I',current_user);
END $$;
REVOKE ALL ON public.financial_evidence_accounts, public.provider_financial_receipts, public.provider_financial_observations,
  public.provider_financial_object_owners, public.webhook_financial_evidence, public.financial_evidence_reviews FROM PUBLIC;

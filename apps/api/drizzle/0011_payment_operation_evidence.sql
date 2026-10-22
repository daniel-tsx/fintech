-- R2-B1 only: dormant pre-lot evidence. No financial contract, enrollment,
-- workflow finalization, runtime LOGIN grant, historical backfill or activation.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;

CREATE TABLE public.payment_operation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inbox_id uuid NOT NULL REFERENCES public.receipt_admissions(inbox_id),
  proof_version integer NOT NULL CHECK(proof_version=1),
  operation text NOT NULL, outcome text NOT NULL,
  provider text NOT NULL CHECK(provider='STRIPE'), provider_account text NOT NULL,
  provider_mode text NOT NULL CHECK(provider_mode IN ('TEST','LIVE')),
  attempt_id uuid NOT NULL, payment_id uuid NOT NULL, merchant_id uuid NOT NULL, currency text NOT NULL,
  outbox_id uuid NOT NULL REFERENCES public.provider_command_authorities(outbox_id),
  source_id uuid NOT NULL, execution_id uuid NOT NULL, authorization_source_id uuid,
  payment_intent_id text NOT NULL, charge_id text NOT NULL,
  capture_principal bigint, authorized_principal bigint,
  accounting_policy text NOT NULL CHECK(accounting_policy='LEGACY'), acceptance_epoch bigint NOT NULL CHECK(acceptance_epoch=0),
  receipt_revision bigint NOT NULL CHECK(receipt_revision>=0), attempt_generation integer NOT NULL CHECK(attempt_generation>=0),
  scope_revision bigint NOT NULL CHECK(scope_revision>=0), intake_revision bigint NOT NULL CHECK(intake_revision>=0),
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'), fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  validator_version text NOT NULL CHECK(validator_version='PAYMENT_OPERATION_V1'),
  sealed_at timestamptz NOT NULL DEFAULT now(), database_principal name NOT NULL DEFAULT session_user,
  UNIQUE(inbox_id,proof_version), UNIQUE(inbox_id,id,payment_id,merchant_id,currency),
  FOREIGN KEY(provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY(attempt_id,payment_id,merchant_id,currency) REFERENCES public.payment_attempts(id,payment_id,merchant_id,currency),
  FOREIGN KEY(source_id,outbox_id) REFERENCES public.provider_observation_sources(id,outbox_id),
  FOREIGN KEY(execution_id,outbox_id) REFERENCES public.provider_command_executions(id,outbox_id),
  FOREIGN KEY(authorization_source_id) REFERENCES public.provider_observation_sources(id),
  CHECK(((outcome='CAPTURE_SUCCEEDED' AND operation='payment.capture_succeeded' AND capture_principal>0 AND authorized_principal IS NULL AND authorization_source_id IS NOT NULL)
    OR (outcome='AUTHORIZE_SUCCEEDED' AND operation='payment.authorized' AND authorized_principal>0 AND capture_principal IS NULL AND authorization_source_id IS NULL)
    OR (outcome='VOID_SUCCEEDED' AND operation='payment.cancelled' AND capture_principal IS NULL AND authorized_principal IS NULL AND authorization_source_id IS NOT NULL)
    OR (outcome='CAPTURE_FAILED' AND operation='payment.capture_failed' AND capture_principal IS NULL AND authorized_principal IS NULL)
    OR (outcome='AUTHORIZE_FAILED' AND operation='payment.authorization_failed' AND capture_principal IS NULL AND authorized_principal IS NULL)) IS TRUE),
  CHECK((capture_principal IS NULL OR capture_principal<=9007199254740991) AND (authorized_principal IS NULL OR authorized_principal<=9007199254740991))
);
CREATE INDEX payment_operation_attempt ON public.payment_operation_evidence(attempt_id);
CREATE INDEX payment_operation_provider_object ON public.payment_operation_evidence(provider,provider_account,payment_intent_id);
CREATE TRIGGER payment_operation_immutable BEFORE UPDATE OR DELETE ON public.payment_operation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence();
CREATE TRIGGER payment_operation_truncate BEFORE TRUNCATE ON public.payment_operation_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence();
REVOKE ALL ON public.payment_operation_evidence FROM PUBLIC;

ALTER TABLE public.receipt_admissions DROP CONSTRAINT receipt_admissions_contract_version_check;
ALTER TABLE public.receipt_admissions ADD CONSTRAINT receipt_admissions_contract_version_check CHECK(contract_version IN (1,2));
ALTER TABLE public.receipt_admission_obligations ADD COLUMN payment_operation_proof_id uuid;
-- Identify the old unnamed owner CHECK by its exact columns, not a generated ordinal.
DO $$ DECLARE c record; n integer:=0; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.receipt_admission_obligations'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%proof_revision = 1%' AND pg_get_constraintdef(oid) LIKE '%scope_evidence_revision%' LOOP
    EXECUTE format('ALTER TABLE public.receipt_admission_obligations DROP CONSTRAINT %I',c.conname); n:=n+1;
  END LOOP;
  IF n<>1 THEN RAISE EXCEPTION 'Expected exactly the installed R0 owner constraint'; END IF;
END $$;
ALTER TABLE public.receipt_admission_obligations ADD CONSTRAINT receipt_obligation_typed_owner CHECK(
  ((merchant_id IS NULL AND currency IS NULL AND payment_id IS NULL AND proof_revision IS NULL AND payment_operation_proof_id IS NULL AND scope_evidence_revision IS NULL)
    OR (merchant_id IS NOT NULL AND currency IS NOT NULL AND payment_id IS NOT NULL AND scope_evidence_revision>=1
      AND ((proof_revision=1 AND payment_operation_proof_id IS NULL) OR (proof_revision IS NULL AND payment_operation_proof_id IS NOT NULL)))) IS TRUE);
ALTER TABLE public.receipt_admission_obligations ADD CONSTRAINT receipt_payment_operation_owner
  FOREIGN KEY(inbox_id,payment_operation_proof_id,payment_id,merchant_id,currency)
  REFERENCES public.payment_operation_evidence(inbox_id,id,payment_id,merchant_id,currency);
--> statement-breakpoint

-- json preserves duplicate keys; jsonb would silently discard the ambiguity.
CREATE FUNCTION public.check_payment_json(p json) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v json;
BEGIN
  IF json_typeof(p)='object' THEN
    IF EXISTS(SELECT key FROM json_each(p) GROUP BY key HAVING count(*)>1) THEN RAISE EXCEPTION 'Ambiguous duplicate provider JSON key'; END IF;
    FOR v IN SELECT value FROM json_each(p) LOOP PERFORM public.check_payment_json(v); END LOOP;
  ELSIF json_typeof(p)='array' THEN
    FOR v IN SELECT value FROM json_array_elements(p) LOOP PERFORM public.check_payment_json(v); END LOOP;
  END IF;
END $$;
CREATE FUNCTION public.payment_json(p bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE j json;
BEGIN
  IF p IS NULL OR octet_length(p)=0 OR octet_length(p)>1048576 THEN RAISE EXCEPTION 'Complete bounded provider JSON required'; END IF;
  j:=convert_from(p,'UTF8')::json; PERFORM public.check_payment_json(j);
  IF json_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Provider object required'; END IF;
  RETURN j::jsonb;
END $$;
-- Inspect only causal identity before applying the strict payment parser.
-- json_each retains duplicate/escaped keys; jsonb must not select a last value.
CREATE FUNCTION public.payment_receipt_causation(p bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE j json; request json; k text;
BEGIN
  j:=convert_from(p,'UTF8')::json;
  IF json_typeof(j) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Receipt causal object required'; END IF;
  IF EXISTS(SELECT key FROM json_each(j) WHERE key IN ('id','account','request') GROUP BY key HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Ambiguous duplicate receipt causal identity'; END IF;
  request:=j->'request';
  IF request IS NULL OR json_typeof(request)='null' THEN RETURN jsonb_build_object('request_id',NULL,'command_key',NULL); END IF;
  -- A scalar ID can establish relevance, never a positive financial witness.
  IF json_typeof(request)='string' THEN RETURN jsonb_build_object('request_id',request#>>'{}','command_key',NULL); END IF;
  IF json_typeof(request) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported receipt causal identity'; END IF;
  IF EXISTS(SELECT key FROM json_each(request) WHERE key IN ('id','idempotency_key') GROUP BY key HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Ambiguous duplicate receipt causal identity'; END IF;
  FOREACH k IN ARRAY ARRAY['id','idempotency_key'] LOOP
    IF request->k IS NOT NULL AND json_typeof(request->k) NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Unsupported receipt causal identity'; END IF;
  END LOOP;
  RETURN jsonb_build_object('request_id',request->>'id','command_key',request->>'idempotency_key');
END $$;
CREATE FUNCTION public.payment_minor(p jsonb,k text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE n numeric;
BEGIN
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Exact provider monetary field required'; END IF;
  n:=(p->>k)::numeric;
  IF n<>trunc(n) OR n<0 OR n>9007199254740991 THEN RAISE EXCEPTION 'Provider monetary field outside supported range'; END IF;
  RETURN n::bigint;
END $$;

CREATE FUNCTION public.payment_operation_receipt_facts(p_inbox uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE; b jsonb; o jsonb;
  op text:='provider.unclassified'; contradiction text;
BEGIN
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox;
  BEGIN
    b:=public.payment_json(r.raw_body); o:=b#>'{data,object}';
    IF (r.provider,r.signature,r.headers,r.normalized_payload) IS DISTINCT FROM (w.provider,w.signature,w.headers,w.payload)
      OR b->>'id' IS DISTINCT FROM w.provider_event_id OR b->>'type' IS DISTINCT FROM w.payload->>'externalType'
      OR w.payload->>'id' IS DISTINCT FROM w.provider_event_id OR o->>'object' IS DISTINCT FROM 'payment_intent'
      OR (b?'account' AND b->>'account' IS DISTINCT FROM r.provider_account) THEN RAISE EXCEPTION 'Original payment receipt identity mismatch'; END IF;
    op:=CASE
      WHEN b->>'type'='payment_intent.succeeded' AND o->>'status'='succeeded' THEN 'payment.capture_succeeded'
      WHEN b->>'type'='payment_intent.amount_capturable_updated' AND o->>'status'='requires_capture' THEN
        CASE WHEN w.payload->>'type'='payment.capture_succeeded' THEN 'payment.capture_succeeded' ELSE 'payment.authorized' END
      WHEN b->>'type'='payment_intent.canceled' AND o->>'status'='canceled' THEN 'payment.cancelled'
      WHEN b->>'type'='payment_intent.payment_failed' THEN
        CASE WHEN w.payload->>'type'='payment.capture_failed' THEN 'payment.capture_failed' ELSE 'payment.authorization_failed' END
      ELSE 'provider.unclassified' END;
    IF w.payload->>'type' NOT IN (op,'provider.unsupported') THEN RAISE EXCEPTION 'Normalized payment phase contradicts original receipt'; END IF;
  EXCEPTION WHEN raise_exception OR invalid_text_representation OR character_not_in_repertoire OR numeric_value_out_of_range THEN contradiction:=SQLERRM;
  END;
  RETURN jsonb_build_object('provider',r.provider,'provider_account',r.provider_account,'operation',op,'financially_relevant',true,'contradiction',contradiction);
END $$;

-- This reader checks the original D02 wire source, never its lossy mirror/projection.
CREATE FUNCTION public.checked_payment_command_source(p_source uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.provider_observation_sources%ROWTYPE; a public.provider_command_authorities%ROWTYPE; b jsonb; params jsonb; expected text;
BEGIN
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=p_source;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=s.outbox_id;
  IF s.source_kind IS DISTINCT FROM 'COMMAND_RESULT' OR s.execution_id IS NULL OR s.body_completeness IS DISTINCT FROM 'COMPLETE'
    OR (s.http_status BETWEEN 200 AND 299) IS NOT TRUE OR s.observation_kind IS DISTINCT FROM 'RETURNED_OBJECT'
    OR s.sdk_version IS DISTINCT FROM '22.6.2' OR s.normalization_version IS DISTINCT FROM 'D02_A_V1'
    OR s.request_headers->>'stripe-version' IS DISTINCT FROM '2026-08-26.dahlia'
    OR s.request_headers->>'stripe-account' IS DISTINCT FROM a.provider_account
    OR s.request_headers->>'idempotency-key' IS DISTINCT FROM a.command_key
    OR coalesce(s.response_headers->>'request-id','')='' OR s.request_method IS DISTINCT FROM 'POST'
    OR s.normalized_outcome->>'reason' NOT IN ('CONFIRMED_PROVIDER_RESULT','CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED') THEN
    RAISE EXCEPTION 'Complete owned command result and supported version required'; END IF;
  expected:=CASE a.operation WHEN 'AUTHORIZE' THEN '/v1/payment_intents' WHEN 'CAPTURE' THEN '/v1/payment_intents/'||(a.command_payload->>'providerPaymentId')||'/capture'
    WHEN 'VOID' THEN '/v1/payment_intents/'||(a.command_payload->>'providerPaymentId')||'/cancel' END;
  IF expected IS NULL OR s.request_path IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Payment command path mismatch'; END IF;
  params:=public.provider_form(s.request_body); b:=public.payment_json(s.response_body);
  IF s.request_parameters IS DISTINCT FROM params OR s.normalized_outcome->'actual' IS DISTINCT FROM b
    OR b->>'object' IS DISTINCT FROM 'payment_intent' OR (b->>'id' LIKE 'pi\_%' ESCAPE '\') IS NOT TRUE
    OR jsonb_typeof(b->'livemode') IS DISTINCT FROM 'boolean' OR b->'livemode' IS DISTINCT FROM to_jsonb(a.provider_mode='LIVE')
    OR upper(b->>'currency') IS DISTINCT FROM a.currency
    OR (a.operation<>'AUTHORIZE' AND b->>'id' IS DISTINCT FROM a.command_payload->>'providerPaymentId') THEN
    RAISE EXCEPTION 'Payment command result ownership or raw facts mismatch'; END IF;
  IF (a.operation='AUTHORIZE' AND (params->>'amount' IS DISTINCT FROM a.amount::text OR params->>'capture_method' IS DISTINCT FROM 'manual'
      OR params->>'payment_method_types[0]' IS DISTINCT FROM 'card' OR params->>'confirm' IS DISTINCT FROM 'true' OR upper(params->>'currency') IS DISTINCT FROM a.currency))
    OR (a.operation='CAPTURE' AND (params->>'amount_to_capture' IS DISTINCT FROM a.amount::text
      OR params->>'final_capture' IS DISTINCT FROM coalesce(a.command_payload->>'finalCapture','true')))
    OR (a.operation='VOID' AND (a.amount<>0 OR params->>'cancellation_reason' IS DISTINCT FROM 'requested_by_customer')) THEN
    RAISE EXCEPTION 'Actual payment parameters contradict accepted operation'; END IF;
  PERFORM public.payment_minor(b,'amount'); PERFORM public.payment_minor(b,'amount_received'); PERFORM public.payment_minor(b,'amount_capturable');
  RETURN jsonb_build_object('object',b,'parameters',params,'source_fingerprint',encode(s.fingerprint,'hex'),'source_id',s.id,
    'outbox_id',a.outbox_id,'execution_id',s.execution_id,'request_id',s.response_headers->>'request-id');
END $$;

CREATE FUNCTION public.payment_operation_facts(p_inbox uuid,p_source uuid,p_authorization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE; adm public.receipt_admissions%ROWTYPE;
  a public.provider_command_authorities%ROWTYPE; auth public.provider_command_authorities%ROWTYPE; related public.provider_command_authorities%ROWTYPE; child public.payment_attempts%ROWTYPE;
  payment public.payments%ROWTYPE; s public.provider_observation_sources%ROWTYPE;
  b jsonb; obj jsonb; response jsonb; auth_response jsonb; checked jsonb; baseline jsonb; d jsonb; meta jsonb; fact jsonb; candidate jsonb;
  signed_event jsonb; signed_object jsonb; signed_response jsonb; signed_data jsonb; signed_operation text; causation jsonb;
  op text; proof_outcome text; pi text; charge text; amount bigint; h bigint; final_capture boolean; k text; expected text; other record;
BEGIN
  SELECT * INTO STRICT r FROM public.provider_financial_receipts WHERE inbox_id=p_inbox;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox;
  SELECT * INTO STRICT adm FROM public.receipt_admissions WHERE inbox_id=p_inbox AND contract_version=2;
  fact:=public.payment_operation_receipt_facts(p_inbox);
  IF fact->>'contradiction' IS NOT NULL THEN RAISE EXCEPTION 'Contradictory payment receipt'; END IF;
  op:=fact->>'operation';
  IF op IN ('payment.capture_failed','payment.authorization_failed') THEN RAISE EXCEPTION 'Definitive payment failure interpretation is not installed'; END IF;
  IF op NOT IN ('payment.capture_succeeded','payment.authorized','payment.cancelled') THEN RAISE EXCEPTION 'Unsupported payment operation'; END IF;
  checked:=public.checked_payment_command_source(p_source); response:=checked->'object';
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=p_source;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=s.outbox_id;
  SELECT * INTO STRICT child FROM public.payment_attempts WHERE id=a.operation_id;
  SELECT * INTO STRICT payment FROM public.payments WHERE id=a.payment_id;
  IF a.operation IS DISTINCT FROM (CASE op WHEN 'payment.capture_succeeded' THEN 'CAPTURE' WHEN 'payment.authorized' THEN 'AUTHORIZE' ELSE 'VOID' END)
    OR (child.kind,child.payment_id,child.merchant_id,child.currency,child.amount) IS DISTINCT FROM (a.operation,a.payment_id,a.merchant_id,a.currency,a.amount)
    OR (payment.merchant_id,payment.currency) IS DISTINCT FROM (a.merchant_id,a.currency)
    OR (r.provider,r.provider_account) IS DISTINCT FROM (a.provider,a.provider_account)
    OR child.status='FAILED' THEN RAISE EXCEPTION 'Accepted payment operation or terminal owner mismatch'; END IF;
  b:=public.payment_json(r.raw_body); obj:=b#>'{data,object}'; d:=r.normalized_payload->'data'; pi:=response->>'id';
  charge:=public.financial_external_reference(response->'latest_charge'); amount:=a.amount;
  IF coalesce(charge,'') NOT LIKE 'ch\_%' ESCAPE '\' OR b->>'api_version' IS DISTINCT FROM '2026-08-26.dahlia'
    OR b->'livemode' IS DISTINCT FROM to_jsonb(a.provider_mode='LIVE') OR obj->'livemode' IS DISTINCT FROM to_jsonb(a.provider_mode='LIVE')
    OR (obj->>'id',upper(obj->>'currency'),public.financial_external_reference(obj->'latest_charge')) IS DISTINCT FROM (pi,a.currency,charge)
    OR b#>>'{request,idempotency_key}' IS DISTINCT FROM a.command_key OR b#>>'{request,id}' IS DISTINCT FROM checked->>'request_id'
    OR obj->>'status' IS DISTINCT FROM response->>'status'
    OR public.payment_minor(obj,'amount') IS DISTINCT FROM public.payment_minor(response,'amount')
    OR public.payment_minor(obj,'amount_received') IS DISTINCT FROM public.payment_minor(response,'amount_received')
    OR public.payment_minor(obj,'amount_capturable') IS DISTINCT FROM public.payment_minor(response,'amount_capturable') THEN
    RAISE EXCEPTION 'Signed request causation, identity or monetary witness mismatch'; END IF;
  IF a.operation='AUTHORIZE' THEN
    IF p_authorization IS NOT NULL OR amount<=0 OR public.payment_minor(response,'amount')<>amount
      OR public.payment_minor(response,'amount_received')<>0 OR public.payment_minor(response,'amount_capturable')<>amount
      OR response->>'capture_method' IS DISTINCT FROM 'manual' OR response->>'status' IS DISTINCT FROM 'requires_capture'
      OR b->>'type' IS DISTINCT FROM 'payment_intent.amount_capturable_updated' THEN RAISE EXCEPTION 'Exact manual authorization witness required'; END IF;
    proof_outcome:='AUTHORIZE_SUCCEEDED'; h:=amount;
    -- Use the same historical authorization comparison for its own proof and
    -- when it supplies a capture/void baseline; keep selected facts unchanged.
    auth:=a; auth_response:=response;
  ELSE
    baseline:=public.checked_payment_command_source(p_authorization); auth_response:=baseline->'object';
    SELECT c.* INTO STRICT auth FROM public.provider_command_authorities c JOIN public.provider_observation_sources v ON v.outbox_id=c.outbox_id WHERE v.id=p_authorization;
    h:=public.payment_minor(auth_response,'amount_capturable');
    IF auth.operation IS DISTINCT FROM 'AUTHORIZE' OR (auth.provider,auth.provider_account,auth.provider_mode,auth.payment_id,auth.merchant_id,auth.currency)
      IS DISTINCT FROM (a.provider,a.provider_account,a.provider_mode,a.payment_id,a.merchant_id,a.currency)
      OR (auth_response->>'id',public.financial_external_reference(auth_response->'latest_charge')) IS DISTINCT FROM (pi,charge)
      OR auth_response->>'capture_method' IS DISTINCT FROM 'manual' OR auth_response->>'status' IS DISTINCT FROM 'requires_capture'
      OR public.payment_minor(auth_response,'amount_received')<>0 OR h<=0 OR h<>auth.amount
      OR public.payment_minor(auth_response,'amount')<>h OR public.payment_minor(response,'amount')<>h THEN
      RAISE EXCEPTION 'Owned independent zero-captured authorization required'; END IF;
    IF a.operation='CAPTURE' THEN
      final_capture:=coalesce(a.command_payload->>'finalCapture','true')='true';
      IF amount<=0 OR amount>h OR public.payment_minor(response,'amount_received')<>amount
        OR (final_capture AND (response->>'status' IS DISTINCT FROM 'succeeded' OR public.payment_minor(response,'amount_capturable')<>0 OR b->>'type' IS DISTINCT FROM 'payment_intent.succeeded'))
        OR (NOT final_capture AND (amount>=h OR response->>'status' IS DISTINCT FROM 'requires_capture' OR public.payment_minor(response,'amount_capturable')<>h-amount
          OR b->>'type' IS DISTINCT FROM 'payment_intent.amount_capturable_updated' OR public.payment_minor(b#>'{data,previous_attributes}','amount_capturable')<>h)) THEN
        RAISE EXCEPTION 'Exact first-capture principal witness required'; END IF;
      proof_outcome:='CAPTURE_SUCCEEDED';
    ELSE
      IF public.payment_minor(response,'amount_received')<>0 OR public.payment_minor(response,'amount_capturable')<>0
        OR response->>'status' IS DISTINCT FROM 'canceled' OR response->>'cancellation_reason' IS DISTINCT FROM 'requested_by_customer'
        OR obj->>'cancellation_reason' IS DISTINCT FROM 'requested_by_customer' OR b->>'type' IS DISTINCT FROM 'payment_intent.canceled' THEN
        RAISE EXCEPTION 'Explicit zero-captured void witness required'; END IF;
      proof_outcome:='VOID_SUCCEEDED';
    END IF;
  END IF;
  -- Owner metadata is only a contradiction check, never an ownership source.
  FOREACH meta IN ARRAY ARRAY[obj->'metadata',response->'metadata',auth_response->'metadata'] LOOP
    IF meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object' THEN RAISE EXCEPTION 'Malformed payment metadata'; END IF;
    FOREACH k IN ARRAY ARRAY['merchantId','paymentId','captureAttemptId','authorizeAttemptId','captureAmount','currency'] LOOP
      expected:=CASE k WHEN 'merchantId' THEN a.merchant_id::text WHEN 'paymentId' THEN a.payment_id::text
        WHEN 'captureAttemptId' THEN CASE WHEN a.operation='CAPTURE' THEN a.operation_id::text END
        WHEN 'authorizeAttemptId' THEN CASE WHEN a.operation='AUTHORIZE' THEN a.operation_id::text ELSE auth.operation_id::text END
        WHEN 'captureAmount' THEN CASE WHEN a.operation='CAPTURE' THEN amount::text END ELSE a.currency END;
      IF meta?k AND expected IS NOT NULL AND (jsonb_typeof(meta->k) IS DISTINCT FROM 'string' OR meta->>k IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'Explicit payment metadata contradiction'; END IF;
    END LOOP;
  END LOOP;
  IF r.normalized_payload->>'type'='provider.unsupported' THEN
    IF d IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unsupported normalization data mismatch'; END IF;
  ELSE
    IF r.normalized_payload->>'type' IS DISTINCT FROM op OR jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Normalized payment phase mismatch'; END IF;
    FOREACH k IN ARRAY ARRAY['merchantId','paymentId','attemptId','currency','providerTransactionId','paymentIntentId','chargeId','providerStatus'] LOOP
      expected:=CASE k WHEN 'merchantId' THEN a.merchant_id::text WHEN 'paymentId' THEN a.payment_id::text WHEN 'attemptId' THEN a.operation_id::text
        WHEN 'currency' THEN a.currency WHEN 'chargeId' THEN charge WHEN 'providerStatus' THEN obj->>'status' ELSE pi END;
      IF d?k AND d->>k IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Normalized payment identity mismatch'; END IF;
    END LOOP;
    IF d?'amount' AND public.payment_minor(d,'amount') IS DISTINCT FROM amount THEN RAISE EXCEPTION 'Normalized operation principal mismatch'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.provider_observation_sources v WHERE v.outbox_id IN (a.outbox_id,auth.outbox_id)
    AND v.normalized_outcome->>'disposition'='BLOCKING_REVIEW' AND v.normalized_outcome->>'reason'<>'CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED')
    OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers WHERE delivery_id IN (SELECT id FROM public.receipt_delivery_attempts WHERE original_inbox_id=p_inbox))
    OR EXISTS(SELECT 1 FROM public.provider_observation_sources v JOIN public.provider_command_authorities c ON c.outbox_id=v.outbox_id
      WHERE c.provider=a.provider AND c.provider_account=a.provider_account AND v.normalized_outcome->>'payment_intent_id'=pi
      AND (c.payment_id,c.merchant_id,c.currency) IS DISTINCT FROM (a.payment_id,a.merchant_id,a.currency)) THEN
    RAISE EXCEPTION 'Contradictory immutable payment sources'; END IF;
  FOR other IN SELECT * FROM public.provider_observation_sources WHERE outbox_id=a.outbox_id AND id<>p_source AND observation_kind='RETURNED_OBJECT'
    AND a.operation<>'AUTHORIZE' LOOP
    IF other.source_kind='COMMAND_RESULT' THEN
      IF public.checked_payment_command_source(other.id)->'object' IS DISTINCT FROM response THEN RAISE EXCEPTION 'Contradictory same-command payment response'; END IF;
    ELSIF public.payment_json(other.response_body) IS DISTINCT FROM response THEN
      RAISE EXCEPTION 'Contradictory payment lookup remains blocking';
    END IF;
  END LOOP;
  -- The zero baseline is historical COMMAND_RESULT evidence. A later lookup
  -- observes current PI state and must not be compared as another authorization.
  FOR other IN SELECT * FROM public.provider_observation_sources WHERE outbox_id=auth.outbox_id
    AND id<>coalesce(p_authorization,p_source) AND source_kind='COMMAND_RESULT' AND observation_kind='RETURNED_OBJECT' LOOP
    candidate:=public.checked_payment_command_source(other.id)->'object';
    FOREACH k IN ARRAY ARRAY['object','id','livemode','status','capture_method'] LOOP
      IF candidate->k IS DISTINCT FROM auth_response->k THEN RAISE EXCEPTION 'Contradictory same-command authorization response'; END IF;
    END LOOP;
    IF (upper(candidate->>'currency'),public.financial_external_reference(candidate->'latest_charge'),
        public.payment_minor(candidate,'amount'),public.payment_minor(candidate,'amount_received'),public.payment_minor(candidate,'amount_capturable'))
      IS DISTINCT FROM (upper(auth_response->>'currency'),public.financial_external_reference(auth_response->'latest_charge'),
        public.payment_minor(auth_response,'amount'),public.payment_minor(auth_response,'amount_received'),public.payment_minor(auth_response,'amount_capturable')) THEN
      RAISE EXCEPTION 'Contradictory same-command authorization response'; END IF;
    meta:=candidate->'metadata';
    IF meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object' THEN RAISE EXCEPTION 'Malformed payment metadata'; END IF;
    FOREACH k IN ARRAY ARRAY['merchantId','paymentId','authorizeAttemptId','currency'] LOOP
      expected:=CASE k WHEN 'merchantId' THEN auth.merchant_id::text WHEN 'paymentId' THEN auth.payment_id::text
        WHEN 'authorizeAttemptId' THEN auth.operation_id::text ELSE auth.currency END;
      IF meta?k AND (jsonb_typeof(meta->k) IS DISTINCT FROM 'string' OR meta->>k IS DISTINCT FROM expected) THEN
        RAISE EXCEPTION 'Explicit authorization metadata contradiction'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.payment_operation_evidence e WHERE e.provider=a.provider AND e.provider_account=a.provider_account AND e.payment_intent_id=pi
    AND e.outcome='CAPTURE_SUCCEEDED' AND e.outbox_id<>a.outbox_id)
    OR EXISTS(SELECT 1 FROM public.payment_attempts t WHERE t.payment_id=a.payment_id AND t.kind='CAPTURE' AND t.status='SUCCEEDED' AND t.id<>a.operation_id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions j JOIN public.payment_attempts t ON t.id=j.business_id
      WHERE t.payment_id=a.payment_id AND j.business_type='CAPTURE' AND t.id<>a.operation_id)
    OR (payment.captured_amount<>0 AND NOT EXISTS(SELECT 1 FROM public.payment_operation_evidence WHERE outbox_id=a.outbox_id AND outcome='CAPTURE_SUCCEEDED'))
    OR (a.operation='CAPTURE' AND child.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM public.payment_operation_evidence WHERE outbox_id=a.outbox_id)) THEN
    RAISE EXCEPTION 'Subsequent or unexplained recognized capture is unsupported'; END IF;
  -- Event IDs identify retained sources, not operations. Compare every signed
  -- original/later delivery naming either accepted command; PI alone is not causation.
  FOR other IN
    SELECT v.raw_body,v.normalized_payload,NULL::text classification FROM public.provider_financial_receipts v
      WHERE v.provider=a.provider AND v.provider_account=a.provider_account
    UNION ALL
    SELECT v.raw_body,v.normalized_payload,v.classification FROM public.receipt_delivery_attempts v
      WHERE v.provider=a.provider AND v.provider_account=a.provider_account
  LOOP
    causation:=public.payment_receipt_causation(other.raw_body);
    FOR related IN SELECT c.* FROM public.provider_command_authorities c WHERE c.outbox_id IN (a.outbox_id,auth.outbox_id) LOOP
      IF causation->>'command_key' IS DISTINCT FROM related.command_key AND NOT EXISTS (
        SELECT 1 FROM public.provider_observation_sources v WHERE v.outbox_id=related.outbox_id AND v.source_kind='COMMAND_RESULT'
          AND v.response_headers->>'request-id'=causation->>'request_id') THEN CONTINUE; END IF;
      signed_event:=public.payment_json(other.raw_body);
      IF signed_event->>'type'='payment_intent.payment_failed' THEN RAISE EXCEPTION 'Reordered contradictory payment failure evidence'; END IF;
      signed_object:=signed_event#>'{data,object}'; signed_data:=other.normalized_payload->'data';
      signed_response:=CASE WHEN related.outbox_id=a.outbox_id THEN response ELSE auth_response END;
      signed_operation:=CASE WHEN related.outbox_id=a.outbox_id THEN op ELSE 'payment.authorized' END;
      IF other.classification='CONFLICT' OR signed_event->>'api_version' IS DISTINCT FROM '2026-08-26.dahlia'
        OR (signed_event?'account' AND signed_event->>'account' IS DISTINCT FROM related.provider_account)
        OR signed_event->'livemode' IS DISTINCT FROM to_jsonb(related.provider_mode='LIVE')
        OR signed_event#>>'{request,idempotency_key}' IS DISTINCT FROM related.command_key
        OR NOT EXISTS(SELECT 1 FROM public.provider_observation_sources v WHERE v.outbox_id=related.outbox_id
          AND v.source_kind='COMMAND_RESULT' AND v.observation_kind='RETURNED_OBJECT'
          AND v.response_headers->>'request-id'=signed_event#>>'{request,id}')
        OR signed_event->>'type' IS DISTINCT FROM (CASE WHEN related.outbox_id=a.outbox_id THEN b->>'type' ELSE 'payment_intent.amount_capturable_updated' END)
        OR (signed_object->>'object',signed_object->>'id',upper(signed_object->>'currency'),public.financial_external_reference(signed_object->'latest_charge'),
          signed_object->'livemode',signed_object->>'status',public.payment_minor(signed_object,'amount'),
          public.payment_minor(signed_object,'amount_received'),public.payment_minor(signed_object,'amount_capturable'))
          IS DISTINCT FROM (signed_response->>'object',pi,related.currency,charge,to_jsonb(related.provider_mode='LIVE'),signed_response->>'status',
            public.payment_minor(signed_response,'amount'),public.payment_minor(signed_response,'amount_received'),public.payment_minor(signed_response,'amount_capturable'))
        OR (signed_object?'capture_method' AND signed_object->'capture_method' IS DISTINCT FROM signed_response->'capture_method')
        OR (related.operation='VOID' AND signed_object->>'cancellation_reason' IS DISTINCT FROM 'requested_by_customer')
        OR (related.operation='CAPTURE' AND NOT final_capture AND public.payment_minor(signed_event#>'{data,previous_attributes}','amount_capturable')<>h) THEN
        RAISE EXCEPTION 'Contradictory causally related signed payment evidence'; END IF;
      meta:=signed_object->'metadata';
      IF meta IS NOT NULL AND meta<>'null'::jsonb AND jsonb_typeof(meta)<>'object' THEN RAISE EXCEPTION 'Malformed payment metadata'; END IF;
      FOREACH k IN ARRAY ARRAY['merchantId','paymentId','captureAttemptId','authorizeAttemptId','captureAmount','currency'] LOOP
        expected:=CASE k WHEN 'merchantId' THEN related.merchant_id::text WHEN 'paymentId' THEN related.payment_id::text
          WHEN 'captureAttemptId' THEN CASE WHEN related.operation='CAPTURE' THEN related.operation_id::text END
          WHEN 'authorizeAttemptId' THEN CASE WHEN related.operation='AUTHORIZE' THEN related.operation_id::text ELSE auth.operation_id::text END
          WHEN 'captureAmount' THEN CASE WHEN related.operation='CAPTURE' THEN related.amount::text END ELSE related.currency END;
        IF meta?k AND expected IS NOT NULL AND (jsonb_typeof(meta->k) IS DISTINCT FROM 'string' OR meta->>k IS DISTINCT FROM expected) THEN
          RAISE EXCEPTION 'Explicit payment metadata contradiction'; END IF;
      END LOOP;
      IF other.normalized_payload->>'type'='provider.unsupported' THEN
        IF signed_data IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unsupported normalization data mismatch'; END IF;
      ELSE
        IF other.normalized_payload->>'type' IS DISTINCT FROM signed_operation OR jsonb_typeof(signed_data) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Normalized payment phase mismatch'; END IF;
        FOREACH k IN ARRAY ARRAY['merchantId','paymentId','attemptId','currency','providerTransactionId','paymentIntentId','chargeId','providerStatus'] LOOP
          expected:=CASE k WHEN 'merchantId' THEN related.merchant_id::text WHEN 'paymentId' THEN related.payment_id::text WHEN 'attemptId' THEN related.operation_id::text
            WHEN 'currency' THEN related.currency WHEN 'chargeId' THEN charge WHEN 'providerStatus' THEN signed_object->>'status' ELSE pi END;
          IF signed_data?k AND signed_data->>k IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Normalized payment identity mismatch'; END IF;
        END LOOP;
        IF signed_data?'amount' AND public.payment_minor(signed_data,'amount') IS DISTINCT FROM related.amount THEN RAISE EXCEPTION 'Normalized operation principal mismatch'; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('validator','PAYMENT_OPERATION_V1','interpretation',CASE a.operation WHEN 'CAPTURE' THEN 'STRIPE_FIRST_CAPTURE_V1' ELSE 'STRIPE_PAYMENT_WORKFLOW_V1' END,
    'operation',op,'outcome',proof_outcome,'provider',a.provider,'provider_account',a.provider_account,'provider_mode',a.provider_mode,
    'attempt_id',a.operation_id,'payment_id',a.payment_id,'merchant_id',a.merchant_id,'currency',a.currency,'outbox_id',a.outbox_id,'command_key',a.command_key,
    'command_hash',encode(sha256(convert_to(a.command_payload::text,'UTF8')),'hex'),'accounting_policy',a.accounting_policy,'acceptance_epoch',a.acceptance_epoch,
    'source',checked,'authorization',baseline,'payment_intent_id',pi,'charge_id',charge,'capture_principal',CASE WHEN a.operation='CAPTURE' THEN amount END,
    'authorized_principal',CASE WHEN a.operation='AUTHORIZE' THEN amount END,'zero_received_baseline',0,'authorized_capacity',h,'final_capture',final_capture,
    'event_id',b->>'id','event_api_version',b->>'api_version','receipt_hash',encode(sha256(r.raw_body),'hex'),'verifier',r.verification_version,'normalization_version',r.normalization_version);
END $$;
--> statement-breakpoint

CREATE FUNCTION public.load_effective_payment_operation_evidence(p_inbox uuid,p_version integer,p_operation text)
RETURNS public.payment_operation_evidence LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.payment_operation_evidence%ROWTYPE; f jsonb; o public.receipt_admission_obligations%ROWTYPE;
BEGIN
  IF p_version IS DISTINCT FROM 1 OR p_operation IS NULL THEN RAISE EXCEPTION 'Exact payment proof selector required'; END IF;
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE inbox_id=p_inbox AND proof_version=p_version AND operation=p_operation;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF o.disposition NOT IN ('AWAITING_CORRELATION','AWAITING_APPLICATION') OR o.obligation_revision<e.receipt_revision
    OR (o.merchant_id IS NOT NULL AND o.payment_operation_proof_id IS DISTINCT FROM e.id) THEN RAISE EXCEPTION 'Payment proof obligation is stale or blocked'; END IF;
  f:=public.payment_operation_facts(p_inbox,e.source_id,e.authorization_source_id);
  IF e.facts IS DISTINCT FROM f OR e.fingerprint IS DISTINCT FROM sha256(convert_to(f::text,'UTF8')) THEN RAISE EXCEPTION 'Sealed payment source facts changed'; END IF;
  RETURN e;
END $$;

CREATE FUNCTION public.seal_payment_operation_evidence(p_inbox uuid,p_generation integer,p_revision bigint,p_source uuid,p_authorization uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; o public.receipt_admission_obligations%ROWTYPE; a public.provider_command_authorities%ROWTYPE;
  e public.payment_operation_evidence%ROWTYPE; f jsonb; sr bigint; ir bigint; review uuid; refusal_reason text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Payment sealing requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF w.attempts IS DISTINCT FROM p_generation OR o.obligation_revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Stale payment receipt generation or revision'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR UPDATE;
  IF o.disposition='BLOCKING_REVIEW' THEN
    RETURN jsonb_build_object('state','BLOCKING_REVIEW','reason','Existing payment evidence review requires separate recovery');
  END IF;
  BEGIN
    SELECT c.* INTO STRICT a FROM public.provider_command_authorities c JOIN public.provider_observation_sources s ON s.outbox_id=c.outbox_id WHERE s.id=p_source;
    IF (a.provider,a.provider_account) IS DISTINCT FROM (o.provider,o.provider_account) THEN RAISE EXCEPTION 'Payment source account mismatch'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(a.merchant_id::text||':'||a.currency,0));
    SELECT evidence_revision INTO STRICT sr FROM public.capture_accounting_scopes WHERE merchant_id=a.merchant_id AND currency=a.currency FOR NO KEY UPDATE;
    PERFORM 1 FROM public.payments WHERE id=a.payment_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.payment_attempts WHERE payment_id=a.payment_id ORDER BY id FOR UPDATE;
    f:=public.payment_operation_facts(p_inbox,p_source,p_authorization);
    SELECT * INTO e FROM public.payment_operation_evidence WHERE inbox_id=p_inbox AND proof_version=1;
    IF FOUND THEN
      IF e.facts IS DISTINCT FROM f THEN RAISE EXCEPTION 'Payment proof selector already sealed with different sources'; END IF;
      PERFORM public.load_effective_payment_operation_evidence(p_inbox,1,e.operation);
      RETURN jsonb_build_object('state','SEALED','proof_id',e.id,'operation',e.operation);
    END IF;
    SELECT evidence_revision INTO STRICT ir FROM public.receipt_intake_authority WHERE provider=o.provider AND provider_account=o.provider_account;
    INSERT INTO public.payment_operation_evidence(inbox_id,proof_version,operation,outcome,provider,provider_account,provider_mode,attempt_id,payment_id,merchant_id,currency,
      outbox_id,source_id,execution_id,authorization_source_id,payment_intent_id,charge_id,capture_principal,authorized_principal,accounting_policy,acceptance_epoch,
      receipt_revision,attempt_generation,scope_revision,intake_revision,facts,fingerprint,validator_version)
      VALUES(p_inbox,1,f->>'operation',f->>'outcome',a.provider,a.provider_account,a.provider_mode,a.operation_id,a.payment_id,a.merchant_id,a.currency,
        a.outbox_id,p_source,(f#>>'{source,execution_id}')::uuid,p_authorization,f->>'payment_intent_id',f->>'charge_id',(f->>'capture_principal')::bigint,(f->>'authorized_principal')::bigint,
        a.accounting_policy,a.acceptance_epoch,o.obligation_revision,w.attempts,sr,ir,f,sha256(convert_to(f::text,'UTF8')),'PAYMENT_OPERATION_V1') RETURNING * INTO e;
    RETURN jsonb_build_object('state','SEALED','proof_id',e.id,'operation',e.operation);
  EXCEPTION WHEN raise_exception OR no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range OR character_not_in_repertoire THEN
    refusal_reason:=SQLERRM;
    INSERT INTO public.financial_evidence_reviews(inbox_id,review_key,reason,observations)
      VALUES(p_inbox,'payment-operation/v1/'||encode(sha256(convert_to(jsonb_build_array(p_source,p_authorization,refusal_reason)::text,'UTF8')),'hex'),'UNRESOLVED',jsonb_build_object('contract','PAYMENT_OPERATION_V1','reason',refusal_reason))
      ON CONFLICT(inbox_id,review_key) DO NOTHING;
    SELECT id INTO STRICT review FROM public.financial_evidence_reviews WHERE inbox_id=p_inbox
      AND review_key='payment-operation/v1/'||encode(sha256(convert_to(jsonb_build_array(p_source,p_authorization,refusal_reason)::text,'UTF8')),'hex');
    PERFORM public.review_receipt_obligation(p_inbox,review);
    RETURN jsonb_build_object('state','BLOCKING_REVIEW','reason',refusal_reason);
  END;
END $$;

CREATE FUNCTION public.bind_payment_operation_obligation(p_inbox uuid,p_proof uuid,p_revision bigint)
RETURNS public.receipt_admission_obligations LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.receipt_admission_obligations%ROWTYPE; e public.payment_operation_evidence%ROWTYPE; sr bigint; ir bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Payment binding requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox;
  IF o.obligation_revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Stale payment binding revision'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=o.provider AND provider_account=o.provider_account FOR UPDATE;
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE id=p_proof AND inbox_id=p_inbox;
  PERFORM pg_advisory_xact_lock(hashtextextended(e.merchant_id::text||':'||e.currency,0));
  PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=e.merchant_id AND currency=e.currency FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payments WHERE id=e.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.payment_attempts WHERE payment_id=e.payment_id ORDER BY id FOR UPDATE;
  e:=public.load_effective_payment_operation_evidence(p_inbox,1,e.operation);
  IF o.payment_operation_proof_id=e.id AND o.disposition='AWAITING_APPLICATION' THEN RETURN o; END IF;
  IF o.disposition<>'AWAITING_CORRELATION' OR o.operation IS DISTINCT FROM e.operation OR o.proof_revision IS NOT NULL THEN RAISE EXCEPTION 'Exact unbound payment obligation required'; END IF;
  UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=e.merchant_id AND currency=e.currency RETURNING evidence_revision INTO sr;
  UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=o.provider AND provider_account=o.provider_account RETURNING evidence_revision INTO ir;
  UPDATE public.receipt_admission_obligations SET merchant_id=e.merchant_id,currency=e.currency,payment_id=e.payment_id,payment_operation_proof_id=e.id,
    disposition='AWAITING_APPLICATION',obligation_revision=obligation_revision+1,scope_evidence_revision=sr,intake_evidence_revision=ir WHERE inbox_id=p_inbox RETURNING * INTO o;
  RETURN o;
END $$;

CREATE FUNCTION public.publish_admitted_payment_receipt(p_inbox uuid,p_account text,p_raw bytea,p_verifier text)
RETURNS public.receipt_admissions LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.webhook_events%ROWTYPE; a public.receipt_admissions%ROWTYPE; f jsonb; ir bigint; review uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Payment admission requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF coalesce(convert_from(p_raw,'UTF8')::jsonb->>'type','') NOT IN ('payment_intent.succeeded','payment_intent.amount_capturable_updated','payment_intent.payment_failed','payment_intent.canceled') THEN
    RETURN public.publish_admitted_receipt(p_inbox,p_account,p_raw,p_verifier);
  END IF;
  IF EXISTS(SELECT 1 FROM public.provider_financial_receipts WHERE inbox_id=p_inbox) THEN RAISE EXCEPTION 'Only prospective payment receipt publication is supported'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=w.provider AND provider_account=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configured payment account required'; END IF;
  INSERT INTO public.provider_financial_receipts(inbox_id,provider,provider_account,raw_body,signature,headers,normalized_payload,normalization_version,verification_method,verification_version,received_at,verified_at)
    VALUES(p_inbox,w.provider,p_account,p_raw,w.signature,w.headers,w.payload,1,'STRIPE_SDK',p_verifier,w.created_at,now());
  f:=public.payment_operation_receipt_facts(p_inbox);
  INSERT INTO public.receipt_intake_authority(provider,provider_account) VALUES(w.provider,p_account) ON CONFLICT DO NOTHING;
  UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=w.provider AND provider_account=p_account RETURNING evidence_revision INTO ir;
  IF f->>'contradiction' IS NOT NULL THEN
    INSERT INTO public.financial_evidence_reviews(inbox_id,review_key,reason,observations) VALUES(p_inbox,'receipt-admission/classification/v2','CONTRADICTORY',f) RETURNING id INTO review;
  END IF;
  INSERT INTO public.receipt_admissions(inbox_id,provider,provider_account,contract_version,operation,financially_relevant)
    VALUES(p_inbox,w.provider,p_account,2,f->>'operation',true) RETURNING * INTO a;
  INSERT INTO public.receipt_admission_obligations(inbox_id,provider,provider_account,operation,disposition,intake_evidence_revision,review_id)
    VALUES(p_inbox,w.provider,p_account,a.operation,CASE WHEN review IS NULL THEN 'AWAITING_CORRELATION' ELSE 'BLOCKING_REVIEW' END,ir,review);
  RETURN a;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.receipt_admission_facts(p_inbox uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.provider_financial_receipts%ROWTYPE; w public.webhook_events%ROWTYPE; b jsonb; o jsonb; op text;
  relevant boolean:=true; contradiction text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.receipt_admissions WHERE inbox_id=p_inbox AND contract_version=2) THEN
    RETURN public.payment_operation_receipt_facts(p_inbox);
  END IF;
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
CREATE OR REPLACE FUNCTION public.guard_receipt_obligation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Receipt obligations cannot be removed'; END IF;
  IF current_user<>'fintech_admission_'||md5(current_database()) THEN RAISE EXCEPTION 'Obligation mutation requires the guarded writer'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.inbox_id,NEW.provider,NEW.provider_account,NEW.operation,NEW.created_at)
      IS DISTINCT FROM (OLD.inbox_id,OLD.provider,OLD.provider_account,OLD.operation,OLD.created_at)
      OR (OLD.merchant_id IS NOT NULL AND (NEW.merchant_id,NEW.currency,NEW.payment_id,NEW.proof_revision,NEW.payment_operation_proof_id)
          IS DISTINCT FROM (OLD.merchant_id,OLD.currency,OLD.payment_id,OLD.proof_revision,OLD.payment_operation_proof_id))
      OR NEW.obligation_revision<>OLD.obligation_revision+1 THEN RAISE EXCEPTION 'Obligation identity or revision cannot be replaced'; END IF;
    IF NOT ((OLD.disposition='AWAITING_CORRELATION' AND NEW.disposition='AWAITING_APPLICATION')
      OR NEW.disposition='BLOCKING_REVIEW'
      OR (OLD.disposition='AWAITING_APPLICATION' AND NEW.disposition IN ('CLEARED_APPLICATION','CLEARED_NO_EFFECT'))) THEN
      RAISE EXCEPTION 'Invalid receipt obligation transition'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.check_receipt_admission_obligation() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.receipt_admissions%ROWTYPE; o public.receipt_admission_obligations%ROWTYPE; f jsonb; e public.webhook_financial_evidence%ROWTYPE; pe public.payment_operation_evidence%ROWTYPE;
BEGIN
  SELECT * INTO STRICT a FROM public.receipt_admissions WHERE inbox_id=NEW.inbox_id;
  IF a.contract_version=2 THEN
    f:=public.payment_operation_receipt_facts(a.inbox_id);
    SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=a.inbox_id;
    IF (a.provider,a.provider_account,a.operation,a.financially_relevant) IS DISTINCT FROM
      (f->>'provider',f->>'provider_account',f->>'operation',true)
      OR o.proof_revision IS NOT NULL OR o.disposition NOT IN ('AWAITING_CORRELATION','AWAITING_APPLICATION','BLOCKING_REVIEW') THEN
      RAISE EXCEPTION 'Payment admission classification or closed finality mismatch'; END IF;
    IF f->>'contradiction' IS NOT NULL AND (o.disposition IS DISTINCT FROM 'BLOCKING_REVIEW' OR NOT EXISTS(
      SELECT 1 FROM public.financial_evidence_reviews WHERE id=o.review_id AND inbox_id=a.inbox_id
        AND review_key='receipt-admission/classification/v2' AND reason='CONTRADICTORY' AND observations=f)) THEN
      RAISE EXCEPTION 'Payment admission contradiction requires retained review'; END IF;
    IF o.review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.financial_evidence_reviews WHERE id=o.review_id AND inbox_id=a.inbox_id) THEN
      RAISE EXCEPTION 'Matching payment review required'; END IF;
    IF o.merchant_id IS NOT NULL THEN
      SELECT * INTO STRICT pe FROM public.payment_operation_evidence WHERE id=o.payment_operation_proof_id AND inbox_id=a.inbox_id;
      IF (o.payment_id,o.merchant_id,o.currency,o.provider,o.provider_account,o.operation) IS DISTINCT FROM
        (pe.payment_id,pe.merchant_id,pe.currency,pe.provider,pe.provider_account,pe.operation) THEN RAISE EXCEPTION 'Payment obligation proof owner mismatch'; END IF;
      -- BLOCKING_REVIEW may retain an old immutable proof whose dynamic reader
      -- now refuses the new contradiction. Never require successful clearance.
      IF o.disposition='AWAITING_APPLICATION' THEN PERFORM public.load_effective_payment_operation_evidence(a.inbox_id,1,a.operation); END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM public.receipt_admission_obligations WHERE inbox_id=a.inbox_id AND payment_operation_proof_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Contract1 cannot adopt a payment-operation proof'; END IF;
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

CREATE FUNCTION public.validate_payment_operation_seal() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.payment_operation_evidence%ROWTYPE;
BEGIN
  e:=public.load_effective_payment_operation_evidence(NEW.inbox_id,NEW.proof_version,NEW.operation);
  IF (e.operation,e.outcome,e.provider,e.provider_account,e.provider_mode,e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.outbox_id,e.execution_id,
      e.payment_intent_id,e.charge_id,e.capture_principal,e.authorized_principal,e.accounting_policy,e.acceptance_epoch)
    IS DISTINCT FROM (e.facts->>'operation',e.facts->>'outcome',e.facts->>'provider',e.facts->>'provider_account',e.facts->>'provider_mode',
      (e.facts->>'attempt_id')::uuid,(e.facts->>'payment_id')::uuid,(e.facts->>'merchant_id')::uuid,e.facts->>'currency',(e.facts->>'outbox_id')::uuid,(e.facts#>>'{source,execution_id}')::uuid,
      e.facts->>'payment_intent_id',e.facts->>'charge_id',(e.facts->>'capture_principal')::bigint,(e.facts->>'authorized_principal')::bigint,e.facts->>'accounting_policy',(e.facts->>'acceptance_epoch')::bigint) THEN
    RAISE EXCEPTION 'Payment proof projection disagrees with checked SQL facts'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_operation_complete AFTER INSERT ON public.payment_operation_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_payment_operation_seal();

-- Only NOLOGIN capability owners. All authenticated composition grants remain
-- explicit test setup; no existing application LOGIN or role membership changes.
DO $$ DECLARE owner_name text:='fintech_payment_evidence_'||md5(current_database()); admission text:='fintech_admission_'||md5(current_database()); f record;
BEGIN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.payment_operation_evidence,public.provider_command_authorities,public.provider_command_executions,
    public.provider_observation_sources,public.provider_observation_obligations,public.provider_financial_receipts,public.receipt_admissions,
    public.receipt_admission_obligations,public.financial_evidence_accounts,public.capture_accounting_scopes,public.receipt_intake_authority,
    public.payments,public.payment_attempts,public.ledger_transactions,public.receipt_delivery_attempts,public.receipt_delivery_barriers,public.financial_evidence_reviews,public.webhook_events TO %I',owner_name);
  EXECUTE format('GRANT INSERT ON public.payment_operation_evidence,public.financial_evidence_reviews TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts,public.capture_accounting_scopes TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(updated_at) ON public.payments,public.payment_attempts,public.webhook_events TO %I',owner_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.provider_form(bytea),public.provider_form_component(text),public.financial_external_reference(jsonb),public.review_receipt_obligation(uuid,uuid) TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.payment_operation_evidence,public.payment_attempts TO %I',admission);
  EXECUTE format('GRANT UPDATE(updated_at) ON public.payment_attempts TO %I',admission);
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',admission);
  FOR f IN SELECT oid::regprocedure signature,proname,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('check_payment_json','payment_json','payment_receipt_causation','payment_minor','payment_operation_receipt_facts','checked_payment_command_source','payment_operation_facts',
     'load_effective_payment_operation_evidence','seal_payment_operation_evidence','bind_payment_operation_obligation','publish_admitted_payment_receipt','validate_payment_operation_seal') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I,%I',f.signature,owner_name,admission);
    IF f.prosecdef THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,CASE WHEN f.proname IN ('bind_payment_operation_obligation','publish_admitted_payment_receipt') THEN admission ELSE owner_name END);
    END IF;
  END LOOP;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I,%I',owner_name,admission);
END $$;

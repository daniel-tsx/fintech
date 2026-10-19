-- D02-A: dormant, prospective provider evidence only. Drain evidence writers;
-- install transactionally. No runtime LOGIN grants, backfill, money or activation.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
ALTER TABLE public.financial_evidence_accounts ADD COLUMN provider_mode text
  CHECK (provider_mode IN ('TEST','LIVE'));
-- NULL on old accounts is intentionally not retrospectively attested.
CREATE TABLE public.provider_command_authorities (
  outbox_id uuid PRIMARY KEY REFERENCES public.outbox_events(id),
  provider text NOT NULL CHECK(provider='STRIPE'), provider_account text NOT NULL,
  provider_mode text NOT NULL CHECK(provider_mode IN ('TEST','LIVE')),
  operation text NOT NULL CHECK(operation IN ('AUTHORIZE','CAPTURE','REFUND','VOID')),
  operation_id uuid NOT NULL, payment_id uuid NOT NULL, merchant_id uuid NOT NULL, currency text NOT NULL,
  amount bigint NOT NULL CHECK(amount>=0 AND amount<=9007199254740991),
  command_key text NOT NULL, command_payload jsonb NOT NULL,
  -- Current accepted scope has no runtime policy/epoch. Only prospective LEGACY
  -- acceptance is representable here; never stamp old commands with today's policy.
  accounting_policy text NOT NULL CHECK(accounting_policy='LEGACY'), acceptance_epoch bigint NOT NULL CHECK(acceptance_epoch=0),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_account,command_key),
  CONSTRAINT provider_authority_operation_unique UNIQUE(operation,operation_id),
  FOREIGN KEY(provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY(payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency)
);
CREATE INDEX provider_authority_operation ON public.provider_command_authorities(operation_id);
CREATE INDEX provider_authority_payment ON public.provider_command_authorities(payment_id);
CREATE TABLE public.provider_command_executions (
  id uuid PRIMARY KEY, outbox_id uuid NOT NULL REFERENCES public.provider_command_authorities(outbox_id),
  prepared_at timestamptz NOT NULL DEFAULT now(), database_principal name NOT NULL DEFAULT session_user,
  UNIQUE(id,outbox_id)
);
CREATE INDEX provider_execution_command ON public.provider_command_executions(outbox_id,prepared_at);
CREATE TABLE public.provider_observation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  outbox_id uuid NOT NULL REFERENCES public.provider_command_authorities(outbox_id),
  source_kind text NOT NULL CHECK(source_kind IN ('COMMAND_RESULT','PROVIDER_LOOKUP')),
  source_key text NOT NULL CHECK(length(source_key)>0), execution_id uuid,
  prior_source_id uuid, lookup_object_id text, reconciliation_run_id uuid REFERENCES public.reconciliation_runs(id),
  lookup_actor text, observation_kind text NOT NULL CHECK(observation_kind IN ('RETURNED_OBJECT','RETURNED_ERROR','UNKNOWN_OUTCOME')),
  request_method text NOT NULL, request_path text NOT NULL, request_host text NOT NULL CHECK(request_host='api.stripe.com'),
  request_protocol text NOT NULL CHECK(request_protocol='https'), request_headers jsonb NOT NULL,
  request_body bytea NOT NULL, request_parameters jsonb NOT NULL,
  response_body bytea, body_completeness text NOT NULL CHECK(body_completeness IN ('COMPLETE','PARTIAL','ABSENT')),
  http_status integer CHECK(http_status BETWEEN 100 AND 599), response_headers jsonb NOT NULL,
  transport_error text, sdk_version text NOT NULL, normalization_version text NOT NULL CHECK(normalization_version='D02_A_V1'),
  normalized_outcome jsonb NOT NULL, observed_at timestamptz NOT NULL, fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  created_at timestamptz NOT NULL DEFAULT now(), database_principal name NOT NULL DEFAULT session_user,
  UNIQUE(source_kind,source_key,fingerprint), UNIQUE(id,outbox_id),
  FOREIGN KEY(execution_id,outbox_id) REFERENCES public.provider_command_executions(id,outbox_id),
  FOREIGN KEY(prior_source_id,outbox_id) REFERENCES public.provider_observation_sources(id,outbox_id),
  CHECK(((source_kind='COMMAND_RESULT' AND execution_id IS NOT NULL AND lookup_object_id IS NULL AND reconciliation_run_id IS NULL AND lookup_actor IS NULL)
    OR (source_kind='PROVIDER_LOOKUP' AND execution_id IS NULL AND lookup_object_id IS NOT NULL AND reconciliation_run_id IS NOT NULL AND length(lookup_actor)>0)) IS TRUE),
  CHECK((body_completeness='ABSENT' AND response_body IS NULL) OR (body_completeness<>'ABSENT' AND response_body IS NOT NULL)),
  CHECK(octet_length(request_body)<=1048576 AND (response_body IS NULL OR octet_length(response_body)<=1048576))
);
CREATE INDEX provider_source_command ON public.provider_observation_sources(outbox_id,source_order);
CREATE INDEX provider_source_prior ON public.provider_observation_sources(prior_source_id);
CREATE TABLE public.provider_observation_obligations (
  source_id uuid PRIMARY KEY REFERENCES public.provider_observation_sources(id),
  provider text NOT NULL, provider_account text NOT NULL, merchant_id uuid, currency text,
  disposition text NOT NULL CHECK(disposition IN ('AWAITING_CONFIRMATION','AWAITING_APPLICATION','BLOCKING_REVIEW')),
  reason text NOT NULL, scope_evidence_revision bigint, intake_evidence_revision bigint NOT NULL,
  FOREIGN KEY(provider,provider_account) REFERENCES public.receipt_intake_authority(provider,provider_account),
  FOREIGN KEY(merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  CHECK((merchant_id IS NULL AND currency IS NULL AND scope_evidence_revision IS NULL)
    OR (merchant_id IS NOT NULL AND currency IS NOT NULL AND scope_evidence_revision>=1))
);
CREATE INDEX provider_unknown_obligations ON public.provider_observation_obligations(provider,provider_account)
  WHERE merchant_id IS NULL AND disposition='BLOCKING_REVIEW';
CREATE INDEX provider_scoped_obligations ON public.provider_observation_obligations(merchant_id,currency)
  WHERE disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW');
CREATE TABLE public.provider_observation_projections (
  source_id uuid PRIMARY KEY REFERENCES public.provider_observation_sources(id),
  observation_id uuid NOT NULL UNIQUE REFERENCES public.provider_financial_observations(id)
);
-- Original format remains immutable and legal to the accepted fixture/legacy
-- capabilities. D02 gets no direct INSERT, and only publishes linked sources.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['provider_command_authorities','provider_command_executions','provider_observation_sources','provider_observation_obligations','provider_observation_projections'] LOOP
    EXECUTE format('CREATE TRIGGER provider_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER provider_evidence_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.guard_provider_command_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.provider_command_authorities) THEN RAISE EXCEPTION 'Accepted provider command identity cannot be truncated'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='outbox_events' THEN
    changed:=TG_OP='DELETE' OR (NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.created_at);
    IF changed AND EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE outbox_id=OLD.id) THEN RAISE EXCEPTION 'Accepted provider command is immutable'; END IF;
  ELSIF TG_TABLE_NAME='payments' THEN
    changed:=TG_OP='DELETE' OR (NEW.id,NEW.merchant_id,NEW.currency) IS DISTINCT FROM (OLD.id,OLD.merchant_id,OLD.currency);
    IF changed AND EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE payment_id=OLD.id) THEN RAISE EXCEPTION 'Accepted provider owner is immutable'; END IF;
  ELSE
    changed:=TG_OP='DELETE' OR (to_jsonb(NEW)->'id',to_jsonb(NEW)->'payment_id',to_jsonb(NEW)->'merchant_id',to_jsonb(NEW)->'amount',to_jsonb(NEW)->'currency',to_jsonb(NEW)->'kind')
      IS DISTINCT FROM (to_jsonb(OLD)->'id',to_jsonb(OLD)->'payment_id',to_jsonb(OLD)->'merchant_id',to_jsonb(OLD)->'amount',to_jsonb(OLD)->'currency',to_jsonb(OLD)->'kind');
    IF changed AND EXISTS(SELECT 1 FROM public.provider_command_authorities WHERE operation_id=OLD.id) THEN RAISE EXCEPTION 'Accepted provider operation is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events','payments','payment_attempts','refunds'] LOOP
    EXECUTE format('CREATE TRIGGER accepted_provider_identity BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_provider_command_identity()',t);
    EXECUTE format('CREATE TRIGGER accepted_provider_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_provider_command_identity()',t);
  END LOOP;
END $$;
CREATE FUNCTION public.accept_provider_command(p_outbox uuid,p_account text,p_mode text) RETURNS public.provider_command_authorities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.outbox_events%ROWTYPE; c record; p public.payments%ROWTYPE; op text; child_xid xid; result public.provider_command_authorities%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Provider acceptance requires READ COMMITTED'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider='STRIPE' AND provider_account=p_account AND provider_mode=p_mode FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Explicit configured provider account/mode required'; END IF;
  SELECT * INTO STRICT w FROM public.outbox_events WHERE id=p_outbox;
  IF NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE id=p_outbox AND xmin::text=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'Only prospective same-transaction command acceptance is supported'; END IF;
  op:=CASE w.event_type WHEN 'provider.capture.requested' THEN 'CAPTURE' WHEN 'provider.refund.requested' THEN 'REFUND'
    WHEN 'provider.authorization.requested' THEN 'AUTHORIZE' WHEN 'provider.void.requested' THEN 'VOID' END;
  IF op IS NULL THEN RAISE EXCEPTION 'Supported accepted provider command required'; END IF;
  IF op='REFUND' THEN
    SELECT id,payment_id,merchant_id,amount,currency,status,xmin INTO STRICT c FROM public.refunds WHERE id=w.aggregate_id;
  ELSE
    SELECT id,payment_id,merchant_id,amount,currency,status,xmin INTO STRICT c FROM public.payment_attempts WHERE id=w.aggregate_id AND kind::text=op;
  END IF;
  child_xid:=c.xmin;
  SELECT * INTO STRICT p FROM public.payments WHERE id=c.payment_id;
  IF child_xid::text<>pg_current_xact_id()::text OR c.status::text<>'PENDING' OR (c.merchant_id,c.currency) IS DISTINCT FROM (p.merchant_id,p.currency)
    OR w.aggregate_type IS DISTINCT FROM (CASE WHEN op='REFUND' THEN 'REFUND' ELSE 'PAYMENT_ATTEMPT' END)
    OR w.payload->>'merchantId' IS DISTINCT FROM c.merchant_id::text OR w.payload->>'paymentId' IS DISTINCT FROM c.payment_id::text
    OR w.payload->>'currency' IS DISTINCT FROM c.currency OR (w.payload->>'amount')::numeric IS DISTINCT FROM c.amount::numeric
    OR w.payload->>(CASE WHEN op='REFUND' THEN 'refundId' ELSE 'attemptId' END) IS DISTINCT FROM c.id::text
    OR w.payload->>'idempotencyKey' IS DISTINCT FROM lower(op)||':'||c.id::text
    OR (op<>'AUTHORIZE' AND coalesce(w.payload->>'providerPaymentId','') NOT LIKE 'pi\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Provider command contradicts prospective accepted operation'; END IF;
  INSERT INTO public.provider_command_authorities(outbox_id,provider,provider_account,provider_mode,operation,operation_id,payment_id,merchant_id,currency,
    amount,command_key,command_payload,accounting_policy,acceptance_epoch)
    VALUES(w.id,'STRIPE',p_account,p_mode,op,c.id,c.payment_id,c.merchant_id,c.currency,c.amount,w.payload->>'idempotencyKey',w.payload,'LEGACY',0) RETURNING * INTO result;
  RETURN result;
END $$;
CREATE FUNCTION public.prepare_provider_execution(p_id uuid,p_outbox uuid,p_account text,p_mode text,p_payload jsonb,p_event text,p_aggregate uuid)
RETURNS public.provider_command_authorities LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.provider_command_authorities%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Provider preparation requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=p_outbox;
  IF (a.provider_account,a.provider_mode,a.command_payload,a.operation_id) IS DISTINCT FROM(p_account,p_mode,p_payload,p_aggregate)
    OR p_event IS DISTINCT FROM (CASE a.operation WHEN 'AUTHORIZE' THEN 'provider.authorization.requested' WHEN 'VOID' THEN 'provider.void.requested'
      WHEN 'CAPTURE' THEN 'provider.capture.requested' ELSE 'provider.refund.requested' END) THEN RAISE EXCEPTION 'Envelope/account contradicts accepted command'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=a.provider AND provider_account=a.provider_account FOR SHARE;
  -- Conservative bound within Stripe's >=24h retention; no new key or blind
  -- replay of an old invocation. Lookup/review remains available after expiry.
  IF EXISTS(SELECT 1 FROM public.provider_command_executions WHERE outbox_id=p_outbox AND prepared_at<now()-interval '23 hours') THEN
    RAISE EXCEPTION 'Provider replay horizon requires reconciliation'; END IF;
  INSERT INTO public.provider_command_executions(id,outbox_id) VALUES(p_id,p_outbox) ON CONFLICT(id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.provider_command_executions WHERE id=p_id AND outbox_id=p_outbox) THEN RAISE EXCEPTION 'Execution identity conflict'; END IF;
  RETURN a;
END $$;
--> statement-breakpoint
-- Parse the actual form bytes, not a caller's normalized request assertion.
CREATE FUNCTION public.provider_form_component(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b bytea:=''::bytea; i integer:=1; ch text;
BEGIN
  WHILE i<=length(value) LOOP
    ch:=substr(value,i,1);
    IF ch='%' THEN b:=b||decode(substr(value,i+1,2),'hex'); i:=i+3;
    ELSE b:=b||convert_to(CASE WHEN ch='+' THEN ' ' ELSE ch END,'UTF8'); i:=i+1; END IF;
  END LOOP;
  RETURN convert_from(b,'UTF8');
END $$;
CREATE FUNCTION public.provider_form(raw bytea) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb:='{}'; pair text; k text; v text;
BEGIN
  IF octet_length(raw)=0 THEN RETURN result; END IF;
  FOREACH pair IN ARRAY string_to_array(convert_from(raw,'UTF8'),'&') LOOP
    k:=public.provider_form_component(split_part(pair,'=',1)); v:=public.provider_form_component(substr(pair,strpos(pair,'=')+1));
    IF strpos(pair,'=')=0 OR result?k THEN RAISE EXCEPTION 'Ambiguous provider request form'; END IF;
    result:=result||jsonb_build_object(k,v);
  END LOOP; RETURN result;
END $$;
CREATE FUNCTION public.provider_source_facts(p_outbox uuid,p_source_kind text,p_exchange jsonb,p_body bytea,p_complete text,p_lookup text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.provider_command_authorities%ROWTYPE; obj jsonb; params jsonb; opath text; disposition text:='AWAITING_CONFIRMATION'; reason text:='OUTCOME_UNCONFIRMED';
  kind text:='UNKNOWN_OUTCOME'; object_id text; pi text; charge text; st text; project boolean:=false; n numeric; k text; expected text; code integer;
BEGIN
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=p_outbox;
  code:=(p_exchange->>'httpStatus')::integer;
  params:=public.provider_form(decode(p_exchange->>'requestBody','hex'));
  opath:=CASE a.operation WHEN 'AUTHORIZE' THEN '/v1/payment_intents' WHEN 'CAPTURE' THEN '/v1/payment_intents/'||(a.command_payload->>'providerPaymentId')||'/capture'
    WHEN 'VOID' THEN '/v1/payment_intents/'||(a.command_payload->>'providerPaymentId')||'/cancel' ELSE '/v1/refunds' END;
  IF p_source_kind='PROVIDER_LOOKUP' THEN opath:=CASE WHEN a.operation='REFUND' THEN '/v1/refunds/' ELSE '/v1/payment_intents/' END||p_lookup; END IF;
  IF p_exchange->>'method' IS DISTINCT FROM (CASE WHEN p_source_kind='COMMAND_RESULT' THEN 'POST' ELSE 'GET' END)
    OR p_exchange->>'host' IS DISTINCT FROM 'api.stripe.com' OR p_exchange->>'protocol' IS DISTINCT FROM 'https'
    OR p_exchange->>'path' IS DISTINCT FROM opath OR p_exchange#>>'{requestHeaders,stripe-account}' IS DISTINCT FROM a.provider_account
    OR (p_source_kind='COMMAND_RESULT' AND p_exchange#>>'{requestHeaders,idempotency-key}' IS DISTINCT FROM a.command_key) THEN
    RAISE EXCEPTION 'Actual provider request contradicts accepted command/account'; END IF;
  IF p_source_kind='COMMAND_RESULT' THEN
    IF (a.operation='CAPTURE' AND (params->>'amount_to_capture')::numeric IS DISTINCT FROM a.amount::numeric)
      OR (a.operation IN ('AUTHORIZE','REFUND') AND (params->>'amount')::numeric IS DISTINCT FROM a.amount::numeric)
      OR (a.operation='AUTHORIZE' AND (upper(params->>'currency') IS DISTINCT FROM a.currency OR params->>'payment_method' IS DISTINCT FROM a.command_payload->>'paymentMethodToken'))
      OR (a.operation='REFUND' AND params->>'payment_intent' IS DISTINCT FROM a.command_payload->>'providerPaymentId') THEN
      RAISE EXCEPTION 'Actual provider request financial fields contradict acceptance'; END IF;
  END IF;
  IF p_complete='COMPLETE' THEN
    BEGIN obj:=convert_from(p_body,'UTF8')::jsonb; EXCEPTION WHEN OTHERS THEN obj:=NULL; END;
  END IF;
  IF jsonb_typeof(obj)='object' AND obj?'error' THEN
    kind:='RETURNED_ERROR'; reason:=CASE WHEN code=429 OR code>=500 THEN 'RETRYABLE_TRANSPORT_FAILURE' ELSE 'PROVIDER_ERROR_NOT_NO_EFFECT_PROOF' END;
  ELSIF code BETWEEN 200 AND 299 AND jsonb_typeof(obj)='object' THEN
    kind:='RETURNED_OBJECT'; object_id:=obj->>'id'; st:=obj->>'status';
    pi:=CASE WHEN obj->>'object'='payment_intent' THEN object_id ELSE public.financial_external_reference(obj->'payment_intent') END;
    charge:=public.financial_external_reference(CASE WHEN obj->>'object'='payment_intent' THEN obj->'latest_charge' ELSE obj->'charge' END);
    disposition:='BLOCKING_REVIEW'; reason:='CONTRADICTORY_PROVIDER_OBJECT';
    IF obj->>'object'=(CASE WHEN a.operation='REFUND' THEN 'refund' ELSE 'payment_intent' END)
      AND ((a.operation='REFUND' AND starts_with(object_id,'re_')) OR (a.operation<>'REFUND' AND starts_with(object_id,'pi_')))
      AND jsonb_typeof(obj->'livemode')='boolean' AND (obj->>'livemode')::boolean=(a.provider_mode='LIVE')
      AND upper(obj->>'currency')=a.currency AND jsonb_typeof(obj->'amount')='number'
      AND (a.operation='AUTHORIZE' OR pi=a.command_payload->>'providerPaymentId') THEN
      n:=(obj->>'amount')::numeric;
      IF n=trunc(n) AND n>0 AND n<=9007199254740991 AND (a.operation IN ('CAPTURE','VOID') OR n=a.amount) THEN
        disposition:='AWAITING_CONFIRMATION'; reason:='OUTCOME_UNCONFIRMED';
        IF a.operation='REFUND' AND st IN ('succeeded','failed','canceled') THEN disposition:='AWAITING_APPLICATION'; reason:=CASE WHEN st='succeeded' THEN 'CONFIRMED_PROVIDER_RESULT' ELSE 'DEFINITIVE_PROVIDER_FAILURE' END; END IF;
        IF a.operation='REFUND' AND st IN ('pending','requires_action','succeeded','failed','canceled') THEN project:=true; END IF;
        IF a.operation='CAPTURE' AND st IN ('succeeded','requires_capture') THEN
          -- D02 retains the real operation response but does not settle the R2-B
          -- per-capture attribution gate from an aggregate PaymentIntent.
          disposition:='BLOCKING_REVIEW'; reason:='CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED';
        END IF;
        IF a.operation='AUTHORIZE' AND st='requires_capture' THEN disposition:='AWAITING_APPLICATION'; reason:='CONFIRMED_PROVIDER_RESULT'; END IF;
        IF a.operation='VOID' AND st='canceled' THEN disposition:='AWAITING_APPLICATION'; reason:='CONFIRMED_PROVIDER_RESULT'; END IF;
      END IF;
    END IF;
    FOREACH k IN ARRAY ARRAY['merchantId','paymentId','refundId','captureAttemptId','authorizeAttemptId'] LOOP
      expected:=CASE k WHEN 'merchantId' THEN a.merchant_id::text WHEN 'paymentId' THEN a.payment_id::text
        WHEN 'refundId' THEN CASE WHEN a.operation='REFUND' THEN a.operation_id::text END
        WHEN 'captureAttemptId' THEN CASE WHEN a.operation='CAPTURE' THEN a.operation_id::text END
        ELSE CASE WHEN a.operation='AUTHORIZE' THEN a.operation_id::text END END;
      IF expected IS NOT NULL AND obj->'metadata'?k AND obj#>>ARRAY['metadata',k] IS DISTINCT FROM expected THEN disposition:='BLOCKING_REVIEW'; reason:='EXPLICIT_PROVIDER_OWNER_CONFLICT'; END IF;
    END LOOP;
    IF p_source_kind='PROVIDER_LOOKUP' AND object_id IS DISTINCT FROM p_lookup THEN disposition:='BLOCKING_REVIEW'; reason:='LOOKUP_OBJECT_CONFLICT'; END IF;
  END IF;
  IF (p_exchange#>>'{responseHeaders,stripe-account}' IS NOT NULL AND p_exchange#>>'{responseHeaders,stripe-account}'<>a.provider_account)
    OR (jsonb_typeof(obj)='object' AND obj?'account' AND obj->>'account' IS DISTINCT FROM a.provider_account) THEN
    disposition:='BLOCKING_REVIEW'; reason:='PROVIDER_ACCOUNT_CONFLICT';
  END IF;
  IF disposition='BLOCKING_REVIEW' THEN project:=false; END IF;
  RETURN jsonb_build_object('kind',kind,'disposition',disposition,'reason',reason,'object_id',object_id,'payment_intent_id',pi,'charge_id',charge,
    'provider_status',st,'project',project,'request_parameters',params,'actual',obj);
END $$;
--> statement-breakpoint
-- Only the existing guarded admission owner can advance its revisions.
CREATE FUNCTION public.admit_provider_observation(p_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.provider_observation_sources%ROWTYPE; a public.provider_command_authorities%ROWTYPE; ir bigint; sr bigint; unknown_owner boolean;
BEGIN
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=p_source;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=s.outbox_id;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=a.provider AND provider_account=a.provider_account FOR UPDATE;
  unknown_owner:=s.normalized_outcome->>'reason' IN ('PROVIDER_OBJECT_OWNER_CONFLICT','SOURCE_KEY_CONFLICT','EXPLICIT_PROVIDER_OWNER_CONFLICT','CONTRADICTORY_PROVIDER_OBJECT','LOOKUP_OBJECT_CONFLICT','PROVIDER_ACCOUNT_CONFLICT');
  INSERT INTO public.receipt_intake_authority(provider,provider_account) VALUES(a.provider,a.provider_account) ON CONFLICT DO NOTHING;
  IF NOT unknown_owner THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(a.merchant_id::text||':'||a.currency,0));
    PERFORM 1 FROM public.capture_accounting_scopes WHERE merchant_id=a.merchant_id AND currency=a.currency FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Accepted provider scope required'; END IF;
    UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1 WHERE merchant_id=a.merchant_id AND currency=a.currency RETURNING evidence_revision INTO sr;
  END IF;
  UPDATE public.receipt_intake_authority SET evidence_revision=evidence_revision+1 WHERE provider=a.provider AND provider_account=a.provider_account RETURNING evidence_revision INTO ir;
  INSERT INTO public.provider_observation_obligations(source_id,provider,provider_account,merchant_id,currency,disposition,reason,scope_evidence_revision,intake_evidence_revision)
    VALUES(s.id,a.provider,a.provider_account,CASE WHEN NOT unknown_owner THEN a.merchant_id END,CASE WHEN NOT unknown_owner THEN a.currency END,
      s.normalized_outcome->>'disposition',s.normalized_outcome->>'reason',sr,ir);
END $$;
CREATE FUNCTION public.publish_provider_observation(p_outbox uuid,p_account text,p_mode text,p_kind text,p_key text,p_execution uuid,
  p_lookup text,p_run uuid,p_actor text,p_prior uuid,p_exchange jsonb,p_body bytea,p_complete text,p_sdk text,p_observed timestamptz)
RETURNS public.provider_observation_sources LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.provider_command_authorities%ROWTYPE; f jsonb; digest bytea; s public.provider_observation_sources%ROWTYPE; prior uuid; projection uuid; conflict boolean:=false;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Provider publication requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=p_outbox;
  IF (a.provider_account,a.provider_mode) IS DISTINCT FROM(p_account,p_mode) THEN RAISE EXCEPTION 'Provider observation account mismatch'; END IF;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=a.provider AND provider_account=a.provider_account FOR UPDATE;
  IF p_kind='COMMAND_RESULT' THEN
    IF NOT EXISTS(SELECT 1 FROM public.provider_command_executions WHERE id=p_execution AND outbox_id=p_outbox) THEN RAISE EXCEPTION 'Prepared accepted execution required'; END IF;
  ELSIF p_kind='PROVIDER_LOOKUP' THEN
    IF p_execution IS NOT NULL OR p_run IS NULL OR coalesce(p_actor,'')='' OR p_lookup IS NULL
      OR NOT (p_lookup=a.command_payload->>'providerPaymentId' AND a.operation IN ('CAPTURE','VOID')
        OR EXISTS(SELECT 1 FROM public.provider_observation_sources WHERE id=p_prior AND outbox_id=p_outbox AND normalized_outcome->>'object_id'=p_lookup)) THEN
      RAISE EXCEPTION 'Owned lookup target and explicit reconciliation lineage required'; END IF;
  ELSE RAISE EXCEPTION 'Typed provider source required'; END IF;
  IF p_prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.provider_observation_sources WHERE id=p_prior AND outbox_id=p_outbox) THEN RAISE EXCEPTION 'Prior observation owner mismatch'; END IF;
  IF jsonb_typeof(p_exchange) IS DISTINCT FROM 'object' OR p_observed IS NULL OR coalesce(p_sdk,'')='' OR coalesce(p_key,'')='' THEN RAISE EXCEPTION 'Complete transport attestation required'; END IF;
  digest:=sha256(convert_to(jsonb_build_array(p_outbox,p_account,p_mode,p_kind,p_key,p_execution,p_lookup,p_run,p_actor,p_prior,p_exchange,encode(p_body,'hex'),p_complete,p_sdk,p_observed)::text,'UTF8'));
  SELECT * INTO s FROM public.provider_observation_sources WHERE source_kind=p_kind AND source_key=p_key AND fingerprint=digest;
  IF FOUND THEN RETURN s; END IF;
  f:=public.provider_source_facts(p_outbox,p_kind,p_exchange,p_body,p_complete,p_lookup);
  SELECT id INTO prior FROM public.provider_observation_sources WHERE outbox_id=p_outbox ORDER BY source_order DESC LIMIT 1;
  IF EXISTS(SELECT 1 FROM public.provider_observation_sources WHERE source_kind=p_kind AND source_key=p_key) THEN f:=f||jsonb_build_object('disposition','BLOCKING_REVIEW','reason','SOURCE_KEY_CONFLICT','project',false); END IF;
  IF f->>'object_id' IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.provider_financial_observations o WHERE o.provider=a.provider AND o.provider_account=a.provider_account
      AND o.object_kind=CASE WHEN a.operation='REFUND' THEN 'REFUND' ELSE 'CAPTURE' END AND o.provider_object_id=f->>'object_id'
      AND (o.payment_id,o.merchant_id,o.currency,o.refund_id) IS DISTINCT FROM
        (a.payment_id,a.merchant_id,a.currency,CASE WHEN a.operation='REFUND' THEN a.operation_id END))
      OR EXISTS(SELECT 1 FROM public.provider_financial_object_owners b WHERE b.provider=a.provider AND b.provider_account=a.provider_account AND b.provider_object_id=f->>'object_id'
        AND (b.payment_id,b.merchant_id,b.currency,b.refund_id) IS DISTINCT FROM(a.payment_id,a.merchant_id,a.currency,CASE WHEN a.operation='REFUND' THEN a.operation_id END)) INTO conflict;
    IF conflict THEN f:=f||jsonb_build_object('disposition','BLOCKING_REVIEW','reason','PROVIDER_OBJECT_OWNER_CONFLICT','project',false); END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.provider_observation_sources o WHERE o.outbox_id=p_outbox AND o.normalized_outcome->>'reason' IN ('CONFIRMED_PROVIDER_RESULT','DEFINITIVE_PROVIDER_FAILURE')
    AND f->>'reason' IN ('CONFIRMED_PROVIDER_RESULT','DEFINITIVE_PROVIDER_FAILURE')
    AND ((o.normalized_outcome->>'object_id') IS DISTINCT FROM(f->>'object_id') OR
      (o.normalized_outcome->>'reason') IS DISTINCT FROM(f->>'reason'))) THEN
    f:=f||jsonb_build_object('disposition','BLOCKING_REVIEW','reason','CONTRADICTORY_PROVIDER_RESULT','project',false);
  END IF;
  INSERT INTO public.provider_observation_sources(outbox_id,source_kind,source_key,execution_id,prior_source_id,lookup_object_id,reconciliation_run_id,lookup_actor,
    observation_kind,request_method,request_path,request_host,request_protocol,request_headers,request_body,request_parameters,response_body,body_completeness,http_status,response_headers,
    transport_error,sdk_version,normalization_version,normalized_outcome,observed_at,fingerprint)
    VALUES(p_outbox,p_kind,p_key,p_execution,coalesce(p_prior,prior),p_lookup,p_run,p_actor,f->>'kind',p_exchange->>'method',p_exchange->>'path',p_exchange->>'host',p_exchange->>'protocol',p_exchange->'requestHeaders',
      decode(p_exchange->>'requestBody','hex'),f->'request_parameters',p_body,p_complete,(p_exchange->>'httpStatus')::integer,p_exchange->'responseHeaders',
      p_exchange->>'transportError',p_sdk,'D02_A_V1',f,p_observed,digest) RETURNING * INTO s;
  PERFORM public.admit_provider_observation(s.id);
  IF (f->>'project')::boolean THEN
    INSERT INTO public.provider_financial_observations(provider,provider_account,source_kind,source_key,object_kind,provider_object_id,payment_id,merchant_id,currency,amount,
      outbox_id,command_key,command_payload,refund_id,capture_attempt_id,payment_intent_id,charge_id,provider_status,snapshot,observed_at,publisher_version)
      VALUES(a.provider,a.provider_account,p_kind,'d02:'||s.id::text,CASE WHEN a.operation='REFUND' THEN 'REFUND' ELSE 'CAPTURE' END,f->>'object_id',a.payment_id,a.merchant_id,a.currency,a.amount,
        a.outbox_id,a.command_key,a.command_payload,CASE WHEN a.operation='REFUND' THEN a.operation_id END,CASE WHEN a.operation='CAPTURE' THEN a.operation_id END,
        f->>'payment_intent_id',f->>'charge_id',f->>'provider_status',f,p_observed,'D02_A_V1') RETURNING id INTO projection;
    INSERT INTO public.provider_observation_projections(source_id,observation_id) VALUES(s.id,projection);
  END IF;
  RETURN s;
END $$;
CREATE FUNCTION public.check_provider_source_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.provider_observation_sources%ROWTYPE; a public.provider_command_authorities%ROWTYPE;
BEGIN
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=coalesce((to_jsonb(NEW)->>'source_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=s.outbox_id;
  IF NOT EXISTS(SELECT 1 FROM public.provider_observation_obligations WHERE source_id=s.id AND provider=a.provider AND provider_account=a.provider_account
    AND disposition=s.normalized_outcome->>'disposition' AND reason=s.normalized_outcome->>'reason') THEN RAISE EXCEPTION 'Provider source requires its atomic admission obligation'; END IF;
  IF (s.normalized_outcome->>'project')::boolean IS DISTINCT FROM EXISTS(SELECT 1 FROM public.provider_observation_projections WHERE source_id=s.id) THEN
    RAISE EXCEPTION 'Provider source projection must be complete'; END IF;
  IF EXISTS(SELECT 1 FROM public.provider_financial_observations o JOIN public.provider_observation_projections l ON l.observation_id=o.id WHERE l.source_id=s.id AND
    (o.provider,o.provider_account,o.source_kind,o.source_key,o.object_kind,o.provider_object_id,o.payment_id,o.merchant_id,o.currency,o.amount,o.outbox_id,o.command_key,o.command_payload,
      o.refund_id,o.capture_attempt_id,o.payment_intent_id,o.charge_id,o.provider_status,o.snapshot,o.observed_at,o.publisher_version)
    IS DISTINCT FROM(a.provider,a.provider_account,s.source_kind,'d02:'||s.id::text,CASE WHEN a.operation='REFUND' THEN 'REFUND' ELSE 'CAPTURE' END,
      s.normalized_outcome->>'object_id',a.payment_id,a.merchant_id,a.currency,a.amount,a.outbox_id,a.command_key,a.command_payload,
      CASE WHEN a.operation='REFUND' THEN a.operation_id END,CASE WHEN a.operation='CAPTURE' THEN a.operation_id END,
      s.normalized_outcome->>'payment_intent_id',s.normalized_outcome->>'charge_id',s.normalized_outcome->>'provider_status',s.normalized_outcome,s.observed_at,'D02_A_V1')) THEN
    RAISE EXCEPTION 'Provider projection contradicts immutable source'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_source_complete AFTER INSERT ON public.provider_observation_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_provider_source_complete();
CREATE CONSTRAINT TRIGGER provider_obligation_complete AFTER INSERT ON public.provider_observation_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_provider_source_complete();
CREATE CONSTRAINT TRIGGER provider_projection_complete AFTER INSERT ON public.provider_observation_projections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_provider_source_complete();
--> statement-breakpoint
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
  IF EXISTS(SELECT 1 FROM public.receipt_admission_obligations o WHERE o.provider=p_provider AND o.provider_account=p_account AND o.merchant_id IS NULL AND o.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
    OR EXISTS(SELECT 1 FROM public.receipt_admission_obligations o WHERE o.merchant_id=p_merchant AND o.currency=p_currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW'))
    OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers b WHERE b.provider=p_provider AND b.provider_account=p_account AND b.merchant_id IS NULL)
    OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers b WHERE b.merchant_id=p_merchant AND b.currency=p_currency)
    OR EXISTS(SELECT 1 FROM public.accounting_exceptions x WHERE x.merchant_id=p_merchant AND x.currency=p_currency AND x.status='OPEN')
    OR EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE o.provider=p_provider AND o.provider_account=p_account AND o.merchant_id IS NULL AND o.disposition='BLOCKING_REVIEW')
    OR EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE o.merchant_id=p_merchant AND o.currency=p_currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')) THEN
    RAISE EXCEPTION 'Receipt admission blocked by unresolved evidence or exception'; END IF;
  RETURN NEXT;
END $$;
--> statement-breakpoint
DO $$ DECLARE owner_name text:='fintech_observation_'||md5(current_database()); admission text:='fintech_admission_'||md5(current_database()); f record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=owner_name) THEN RAISE EXCEPTION 'Observation owner already exists'; END IF;
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.provider_command_authorities,public.provider_command_executions,public.provider_observation_sources,public.provider_observation_obligations,public.provider_observation_projections,
    public.outbox_events,public.payments,public.payment_attempts,public.refunds,public.financial_evidence_accounts,public.capture_accounting_scopes,
    public.provider_financial_observations,public.provider_financial_object_owners,public.reconciliation_runs TO %I',owner_name);
  EXECUTE format('GRANT INSERT ON public.provider_command_authorities,public.provider_command_executions,public.provider_observation_sources,public.provider_financial_observations,public.provider_observation_projections TO %I',owner_name);
  EXECUTE format('GRANT USAGE ON SEQUENCE public.provider_observation_sources_source_order_seq TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.provider_observation_sources,public.provider_command_authorities,public.provider_observation_obligations TO %I',admission);
  EXECUTE format('GRANT INSERT ON public.provider_observation_obligations TO %I',admission);
  FOR f IN SELECT oid::regprocedure signature,prosecdef,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('guard_provider_command_identity','accept_provider_command','prepare_provider_execution','provider_form_component','provider_form','provider_source_facts','admit_provider_observation','publish_provider_observation','check_provider_source_complete') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,owner_name);
    IF f.prosecdef THEN
      IF f.proname='admit_provider_observation' THEN
        EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',admission);
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,admission);
        EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',admission);
      ELSE EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,owner_name); END IF;
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.financial_external_reference(jsonb),public.validate_financial_publisher_input(),public.protect_financial_evidence() TO %I',owner_name);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END $$;
REVOKE ALL ON public.provider_command_authorities,public.provider_command_executions,public.provider_observation_sources,public.provider_observation_obligations,public.provider_observation_projections FROM PUBLIC;

-- P-A: immutable tagged storage only. No payment application contract, permit
-- issuer, source discharge, runtime grant, enrollment or financial effect.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;

-- Fail closed if the installed legacy owner key is not the expected exact FK.
DO $$ DECLARE c record; n integer:=0; BEGIN
  IF EXISTS(SELECT 1 FROM public.financial_application_manifests m JOIN public.financial_application_roots r ON r.id=m.root_id WHERE r.family<>'REFUND') THEN
    RAISE EXCEPTION 'Expected only installed REFUND manifest interpretation'; END IF;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.financial_application_manifests'::regclass
    AND contype='f' AND confrelid='public.webhook_financial_evidence'::regclass AND convalidated AND NOT condeferrable
    AND confmatchtype='s' AND confupdtype='a' AND confdeltype='a'
    AND conkey=ARRAY(SELECT attnum FROM unnest(ARRAY['inbox_id','proof_revision','payment_id','merchant_id','currency']) WITH ORDINALITY k(name,n)
      JOIN pg_attribute ON attrelid='public.financial_application_manifests'::regclass AND attname=k.name ORDER BY k.n)
    AND confkey=ARRAY(SELECT attnum FROM unnest(ARRAY['inbox_id','proof_revision','payment_id','merchant_id','currency']) WITH ORDINALITY k(name,n)
      JOIN pg_attribute ON attrelid='public.webhook_financial_evidence'::regclass AND attname=k.name ORDER BY k.n)
  LOOP
    EXECUTE format('ALTER TABLE public.financial_application_manifests DROP CONSTRAINT %I',c.conname); n:=n+1;
  END LOOP;
  IF n<>1 THEN RAISE EXCEPTION 'Expected exact installed REFUND manifest owner FK'; END IF;
END $$;
ALTER TABLE public.financial_application_manifests
  ADD COLUMN proof_kind text NOT NULL DEFAULT 'REFUND_V1',
  ADD COLUMN payment_operation_proof_id uuid,
  ADD COLUMN legacy_proof_inbox_id uuid GENERATED ALWAYS AS (CASE WHEN proof_kind='REFUND_V1' THEN inbox_id END) STORED,
  ADD COLUMN payment_proof_inbox_id uuid GENERATED ALWAYS AS (CASE WHEN proof_kind='PAYMENT_OPERATION_V1' THEN inbox_id END) STORED,
  ADD CONSTRAINT application_manifest_proof_branch CHECK(((proof_kind='REFUND_V1' AND payment_operation_proof_id IS NULL)
    OR (proof_kind='PAYMENT_OPERATION_V1' AND payment_operation_proof_id IS NOT NULL)) IS TRUE),
  ADD CONSTRAINT application_manifest_refund_proof FOREIGN KEY(legacy_proof_inbox_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency),
  ADD CONSTRAINT application_manifest_payment_proof FOREIGN KEY(payment_proof_inbox_id,payment_operation_proof_id,payment_id,merchant_id,currency)
    REFERENCES public.payment_operation_evidence(inbox_id,id,payment_id,merchant_id,currency);
--> statement-breakpoint

-- Interpret the immutable B1 witness, not mutable current capture eligibility.
-- This checker neither admits sources nor certifies a complete application.
CREATE FUNCTION public.check_payment_proof_envelope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; e public.payment_operation_evidence%ROWTYPE;
  a public.provider_command_authorities%ROWTYPE; auth public.provider_command_authorities%ROWTYPE;
  s public.provider_observation_sources%ROWTYPE; receipt public.provider_financial_receipts%ROWTYPE; checked jsonb; baseline jsonb;
BEGIN
  -- BEFORE triggers cannot read the new STORED generated linkage values.
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=NEW.root_id;
  IF NEW.proof_kind='REFUND_V1' THEN
    IF r.family<>'REFUND' THEN RAISE EXCEPTION 'REFUND envelope requires REFUND root'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.proof_kind IS DISTINCT FROM 'PAYMENT_OPERATION_V1' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE id=NEW.payment_operation_proof_id AND inbox_id=NEW.inbox_id;
  SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=e.outbox_id;
  IF NEW.proof_revision IS DISTINCT FROM 1 OR e.proof_version IS DISTINCT FROM 1 OR e.validator_version IS DISTINCT FROM 'PAYMENT_OPERATION_V1'
    OR (r.family,r.phase,r.operation_id,r.attempt_id,r.accepted_outbox_id,r.payment_id,r.merchant_id,r.currency,r.provider,r.provider_account,r.policy,r.acceptance_epoch)
      IS DISTINCT FROM (a.operation,'TERMINAL',e.attempt_id,e.attempt_id,e.outbox_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.accounting_policy,e.acceptance_epoch)
    OR (NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.policy,NEW.epoch,NEW.proof_operation)
      IS DISTINCT FROM (e.payment_id,e.merchant_id,e.currency,e.accounting_policy,e.acceptance_epoch,e.operation)
    OR (a.operation_id,a.payment_id,a.merchant_id,a.currency,a.provider,a.provider_account,a.provider_mode,a.accounting_policy,a.acceptance_epoch)
      IS DISTINCT FROM (e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.provider_mode,e.accounting_policy,e.acceptance_epoch)
    OR (a.operation,e.operation,e.outcome) NOT IN (('AUTHORIZE','payment.authorized','AUTHORIZE_SUCCEEDED'),
      ('CAPTURE','payment.capture_succeeded','CAPTURE_SUCCEEDED'),('VOID','payment.cancelled','VOID_SUCCEEDED')) THEN
    RAISE EXCEPTION 'Payment envelope requires exact canonical root and typed proof'; END IF;
  IF e.fingerprint IS DISTINCT FROM sha256(convert_to(e.facts::text,'UTF8'))
    OR (e.operation,e.outcome,e.provider,e.provider_account,e.provider_mode,e.attempt_id,e.payment_id,e.merchant_id,e.currency,e.outbox_id,e.execution_id,
      e.payment_intent_id,e.charge_id,e.capture_principal,e.authorized_principal,e.accounting_policy,e.acceptance_epoch)
      IS DISTINCT FROM (e.facts->>'operation',e.facts->>'outcome',e.facts->>'provider',e.facts->>'provider_account',e.facts->>'provider_mode',
      (e.facts->>'attempt_id')::uuid,(e.facts->>'payment_id')::uuid,(e.facts->>'merchant_id')::uuid,e.facts->>'currency',(e.facts->>'outbox_id')::uuid,(e.facts#>>'{source,execution_id}')::uuid,
      e.facts->>'payment_intent_id',e.facts->>'charge_id',(e.facts->>'capture_principal')::bigint,(e.facts->>'authorized_principal')::bigint,e.facts->>'accounting_policy',(e.facts->>'acceptance_epoch')::bigint)
    OR e.facts->>'validator' IS DISTINCT FROM 'PAYMENT_OPERATION_V1'
    OR e.facts->>'interpretation' IS DISTINCT FROM (CASE WHEN a.operation='CAPTURE' THEN 'STRIPE_FIRST_CAPTURE_V1' ELSE 'STRIPE_PAYMENT_WORKFLOW_V1' END)
    OR e.facts->>'command_key' IS DISTINCT FROM a.command_key
    OR e.facts->>'command_hash' IS DISTINCT FROM encode(sha256(convert_to(a.command_payload::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Payment envelope sealed interpretation mismatch'; END IF;
  SELECT * INTO STRICT s FROM public.provider_observation_sources WHERE id=e.source_id AND outbox_id=e.outbox_id AND execution_id=e.execution_id;
  PERFORM 1 FROM public.provider_command_executions WHERE id=e.execution_id AND outbox_id=e.outbox_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment envelope original execution mismatch'; END IF;
  checked:=public.checked_payment_command_source(s.id);
  IF e.facts->'source' IS DISTINCT FROM checked THEN RAISE EXCEPTION 'Payment envelope original source mismatch'; END IF;
  IF a.operation='AUTHORIZE' THEN
    IF e.authorization_source_id IS NOT NULL OR e.facts->'authorization' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Authorization envelope cannot adopt a predecessor source'; END IF;
  ELSE
    baseline:=public.checked_payment_command_source(e.authorization_source_id);
    SELECT c.* INTO STRICT auth FROM public.provider_command_authorities c JOIN public.provider_observation_sources v ON v.outbox_id=c.outbox_id WHERE v.id=e.authorization_source_id;
    IF e.facts->'authorization' IS DISTINCT FROM baseline OR auth.operation IS DISTINCT FROM 'AUTHORIZE'
      OR (auth.payment_id,auth.merchant_id,auth.currency,auth.provider,auth.provider_account,auth.provider_mode)
        IS DISTINCT FROM (e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,e.provider_mode) THEN
      RAISE EXCEPTION 'Payment envelope original authorization mismatch'; END IF;
  END IF;
  SELECT * INTO STRICT receipt FROM public.provider_financial_receipts WHERE inbox_id=e.inbox_id;
  IF (receipt.provider,receipt.provider_account,encode(sha256(receipt.raw_body),'hex'),receipt.verification_version,receipt.normalization_version)
    IS DISTINCT FROM (e.provider,e.provider_account,e.facts->>'receipt_hash',e.facts->>'verifier',(e.facts->>'normalization_version')::integer) THEN
    RAISE EXCEPTION 'Payment envelope original signed receipt mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_payment_proof BEFORE INSERT ON public.financial_application_manifests
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_proof_envelope();

DO $$ DECLARE owner_name text:='fintech_proof_envelope_'||md5(current_database()); BEGIN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.financial_application_roots,public.payment_operation_evidence,public.provider_command_authorities,
    public.provider_command_executions,public.provider_observation_sources,public.provider_financial_receipts TO %I',owner_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.checked_payment_command_source(uuid),public.provider_form(bytea),public.provider_form_component(text),
    public.payment_json(bytea),public.check_payment_json(json),public.payment_minor(jsonb,text) TO %I',owner_name);
  REVOKE ALL ON FUNCTION public.check_payment_proof_envelope() FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.check_payment_proof_envelope() OWNER TO %I',owner_name);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END $$;

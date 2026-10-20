-- R2-A.2 ownership-corrected dormant draft; awaiting independent re-review.
-- No shared/production installation is authorized by this checkpoint.
-- See docs/audits/h1-fix-02-b3-2-b2-r2-a-financial-application-foundation.md.
-- R2-A common protocol only. No installed operation contracts or enrolled scopes.
-- Later reviewed migrations own operation plans/validators and coordinated floor
-- installation. This migration grants no runtime capability and enables no writer.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
-- Referenced ownership keys add no historical stamp or row change. Installation
-- still requires a bounded DDL/drain window; this is not an online-cutover claim.
ALTER TABLE public.refund_capture_allocations ADD CONSTRAINT application_refund_allocation_scope UNIQUE(id,payment_id,merchant_id,currency);
ALTER TABLE public.dispute_capture_allocations ADD CONSTRAINT application_dispute_allocation_scope UNIQUE(id,payment_id,merchant_id,currency);
ALTER TABLE public.dispute_hold_effects ADD CONSTRAINT application_hold_effect_scope UNIQUE(id,payment_id,merchant_id,currency);
ALTER TABLE public.settlement_items ADD CONSTRAINT application_settlement_item_scope UNIQUE(id,payment_id,currency);
--> statement-breakpoint

CREATE TABLE public.financial_application_contracts (
  family text NOT NULL, phase text NOT NULL, policy text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  prepare_function regprocedure NOT NULL, validate_function regprocedure NOT NULL,
  PRIMARY KEY(family,phase,policy)
);
-- Protected enrollment is separate from legacy capture-lot policy. Empty on
-- installation; no routine in this checkpoint enrolls a scope or enables ACTIVE.
CREATE TABLE public.financial_application_scope_authority (
  merchant_id uuid NOT NULL, currency text NOT NULL, provider text NOT NULL, provider_account text NOT NULL,
  policy text NOT NULL, epoch bigint NOT NULL CHECK(epoch>=0),
  admission_mode text NOT NULL CHECK(admission_mode='DORMANT'),
  PRIMARY KEY(merchant_id,currency),
  FOREIGN KEY(merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  FOREIGN KEY(provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  CHECK((policy='LEGACY' AND epoch=0) OR (policy='CAPTURE_FIFO_V1' AND epoch>0))
);
CREATE TABLE public.financial_application_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL CHECK(family IN ('AUTHORIZE','CAPTURE','VOID','REFUND','DISPUTE','SETTLEMENT','PAYOUT')),
  operation_id uuid NOT NULL, phase text NOT NULL,
  merchant_id uuid NOT NULL, currency text NOT NULL, provider text NOT NULL, provider_account text NOT NULL,
  policy text NOT NULL, acceptance_epoch bigint NOT NULL CHECK(acceptance_epoch>=0),
  accepted_outbox_id uuid REFERENCES public.provider_command_authorities(outbox_id),
  payment_id uuid, attempt_id uuid, refund_id uuid, dispute_id uuid, settlement_id uuid, payout_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family,operation_id,phase,currency), UNIQUE(id,merchant_id,currency),
  FOREIGN KEY(merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  FOREIGN KEY(provider,provider_account) REFERENCES public.financial_evidence_accounts(provider,provider_account),
  FOREIGN KEY(payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency),
  FOREIGN KEY(attempt_id,payment_id,merchant_id,currency) REFERENCES public.payment_attempts(id,payment_id,merchant_id,currency),
  FOREIGN KEY(refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency),
  FOREIGN KEY(dispute_id,payment_id,merchant_id,currency) REFERENCES public.disputes(id,payment_id,merchant_id,currency),
  FOREIGN KEY(settlement_id,merchant_id,currency) REFERENCES public.settlements(id,merchant_id,currency),
  FOREIGN KEY(payout_id) REFERENCES public.payouts(id),
  CHECK(((family IN ('AUTHORIZE','CAPTURE','VOID') AND phase='TERMINAL' AND operation_id=attempt_id AND payment_id IS NOT NULL AND accepted_outbox_id IS NOT NULL AND num_nonnulls(attempt_id,refund_id,dispute_id,settlement_id,payout_id)=1)
    OR (family='REFUND' AND phase='TERMINAL' AND operation_id=refund_id AND payment_id IS NOT NULL AND accepted_outbox_id IS NOT NULL AND num_nonnulls(attempt_id,refund_id,dispute_id,settlement_id,payout_id)=1)
    OR (family='DISPUTE' AND phase IN ('OPEN','CLOSE') AND operation_id=dispute_id AND payment_id IS NOT NULL AND accepted_outbox_id IS NULL AND num_nonnulls(attempt_id,refund_id,dispute_id,settlement_id,payout_id)=1)
    OR (family='SETTLEMENT' AND phase IN ('GENERATION','COMPLETION') AND operation_id=settlement_id AND payment_id IS NULL AND accepted_outbox_id IS NULL AND num_nonnulls(attempt_id,refund_id,dispute_id,settlement_id,payout_id)=1)
    OR (family='PAYOUT' AND phase IN ('RESERVATION','COMPLETION') AND operation_id=payout_id AND payment_id IS NULL AND accepted_outbox_id IS NULL AND num_nonnulls(attempt_id,refund_id,dispute_id,settlement_id,payout_id)=1)) IS TRUE)
);
CREATE TABLE public.financial_application_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), root_id uuid NOT NULL REFERENCES public.financial_application_roots(id),
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL,
  inbox_id uuid NOT NULL, proof_revision integer NOT NULL CHECK(proof_revision=1),
  proof_operation text NOT NULL, claim_generation integer NOT NULL CHECK(claim_generation>=0),
  merchant_id uuid NOT NULL, currency text NOT NULL, payment_id uuid NOT NULL,
  policy text NOT NULL, epoch bigint NOT NULL, scope_revision bigint NOT NULL, intake_revision bigint NOT NULL,
  contract_version integer NOT NULL CHECK(contract_version>0),
  result text NOT NULL CHECK(result IN ('POSTED','ZERO_EFFECT','VERIFIED_NO_EFFECT')),
  source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
  effect_manifest jsonb NOT NULL CHECK(jsonb_typeof(effect_manifest)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,backend_pid), UNIQUE(id,root_id),
  FOREIGN KEY(root_id,merchant_id,currency) REFERENCES public.financial_application_roots(id,merchant_id,currency),
  FOREIGN KEY(inbox_id,proof_revision,payment_id,merchant_id,currency)
    REFERENCES public.webhook_financial_evidence(inbox_id,proof_revision,payment_id,merchant_id,currency)
);
CREATE TABLE public.financial_application_permits (
  transaction_id xid8 NOT NULL, backend_pid integer NOT NULL,
  manifest_id uuid NOT NULL UNIQUE REFERENCES public.financial_application_manifests(id),
  database_principal name NOT NULL DEFAULT session_user,
  PRIMARY KEY(transaction_id,backend_pid)
);
CREATE TABLE public.financial_applications (
  root_id uuid PRIMARY KEY REFERENCES public.financial_application_roots(id),
  manifest_id uuid NOT NULL UNIQUE,
  result text NOT NULL CHECK(result IN ('POSTED','ZERO_EFFECT','VERIFIED_NO_EFFECT')),
  audit_id uuid NOT NULL UNIQUE REFERENCES public.audit_logs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(manifest_id,root_id) REFERENCES public.financial_application_manifests(id,root_id)
);
-- Revision is the exact cause identity, not just the payment or original inbox.
-- Original R0 resolutions are untouched. Reblocking changes its revision; a new
-- D02 source/delivery has its own identity and cannot inherit an old clearance.
CREATE TABLE public.financial_application_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), root_id uuid NOT NULL REFERENCES public.financial_applications(root_id) DEFERRABLE INITIALLY DEFERRED,
  inbox_id uuid REFERENCES public.receipt_admission_obligations(inbox_id), obligation_revision bigint,
  observation_source_id uuid REFERENCES public.provider_observation_obligations(source_id),
  delivery_id uuid, barrier_key text,
  disposition text NOT NULL CHECK(disposition IN ('APPLIED','VERIFIED_NO_EFFECT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(delivery_id,barrier_key) REFERENCES public.receipt_delivery_barriers(delivery_id,barrier_key),
  UNIQUE(inbox_id,obligation_revision), UNIQUE(observation_source_id), UNIQUE(delivery_id,barrier_key),
  CHECK(num_nonnulls(inbox_id,observation_source_id,delivery_id)=1),
  CHECK((inbox_id IS NOT NULL)=(obligation_revision IS NOT NULL)),
  CHECK((delivery_id IS NOT NULL)=(barrier_key IS NOT NULL))
);
CREATE TABLE public.financial_application_revision_effects (
  manifest_id uuid PRIMARY KEY REFERENCES public.financial_application_manifests(id),
  root_id uuid NOT NULL REFERENCES public.financial_applications(root_id) DEFERRABLE INITIALLY DEFERRED,
  prior_revision bigint NOT NULL, final_revision bigint NOT NULL,
  CHECK(final_revision=prior_revision+1)
);
CREATE TABLE public.financial_application_effect_links (
  manifest_id uuid NOT NULL, root_id uuid NOT NULL, relation_name text NOT NULL, effect_id uuid NOT NULL,
  merchant_id uuid NOT NULL, currency text NOT NULL, payment_id uuid NOT NULL,
  journal_id uuid UNIQUE, lot_id uuid, refund_allocation_id uuid, dispute_allocation_id uuid, hold_effect_id uuid, settlement_item_id uuid,
  PRIMARY KEY(manifest_id,relation_name,effect_id),
  FOREIGN KEY(manifest_id,root_id) REFERENCES public.financial_application_manifests(id,root_id),
  FOREIGN KEY(root_id,merchant_id,currency) REFERENCES public.financial_application_roots(id,merchant_id,currency),
  FOREIGN KEY(root_id) REFERENCES public.financial_applications(root_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(lot_id,payment_id,merchant_id,currency) REFERENCES public.capture_accounting_lots(id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(refund_allocation_id,payment_id,merchant_id,currency) REFERENCES public.refund_capture_allocations(id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispute_allocation_id,payment_id,merchant_id,currency) REFERENCES public.dispute_capture_allocations(id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(hold_effect_id,payment_id,merchant_id,currency) REFERENCES public.dispute_hold_effects(id,payment_id,merchant_id,currency) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(settlement_item_id,payment_id,currency) REFERENCES public.settlement_items(id,payment_id,currency) DEFERRABLE INITIALLY DEFERRED,
  CHECK(num_nonnulls(journal_id,lot_id,refund_allocation_id,dispute_allocation_id,hold_effect_id,settlement_item_id)=1),
  CHECK(((relation_name='ledger_transactions' AND effect_id=journal_id) OR (relation_name='capture_accounting_lots' AND effect_id=lot_id)
    OR (relation_name='refund_capture_allocations' AND effect_id=refund_allocation_id) OR (relation_name='dispute_capture_allocations' AND effect_id=dispute_allocation_id)
    OR (relation_name='dispute_hold_effects' AND effect_id=hold_effect_id) OR (relation_name='settlement_items' AND effect_id=settlement_item_id)) IS TRUE)
);

CREATE FUNCTION public.check_financial_application_root() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.provider_command_authorities%ROWTYPE;
BEGIN
  IF NEW.accepted_outbox_id IS NOT NULL THEN
    SELECT * INTO STRICT a FROM public.provider_command_authorities WHERE outbox_id=NEW.accepted_outbox_id;
    IF (NEW.family,NEW.operation_id,NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.provider,NEW.provider_account,NEW.policy,NEW.acceptance_epoch)
      IS DISTINCT FROM (a.operation,a.operation_id,a.payment_id,a.merchant_id,a.currency,a.provider,a.provider_account,a.accounting_policy,a.acceptance_epoch) THEN
      RAISE EXCEPTION 'Canonical root must retain exact accepted command identity'; END IF;
  ELSE
    -- These families require their stored internal acceptance/phase contracts in
    -- later checkpoints. Do not invent an epoch or claim from current scope.
    RAISE EXCEPTION 'Internal or dispute root acceptance contract is not installed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_root_identity BEFORE INSERT ON public.financial_application_roots FOR EACH ROW EXECUTE FUNCTION public.check_financial_application_root();

-- No caller supplies a plan. Only a migration-installed SQL contract can derive
-- it from protected state after the authority prefix and financial parent locks.
-- Contract registry has no mutation API and no application-owner write grant.
CREATE FUNCTION public.prepare_financial_application(p_root uuid,p_inbox uuid,p_generation integer,p_revision integer,p_operation text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE; s public.financial_application_scope_authority%ROWTYPE;
  c public.financial_application_contracts%ROWTYPE; e public.webhook_financial_evidence%ROWTYPE;
  w public.webhook_events%ROWTYPE; sr bigint; ir bigint; plan jsonb; m uuid; x jsonb; kind text; effect uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Financial application requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT w FROM public.webhook_events WHERE id=p_inbox FOR UPDATE;
  IF w.status<>'PROCESSING' OR w.attempts IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'Current private inbox claim required'; END IF;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=p_root;
  PERFORM 1 FROM public.financial_evidence_accounts WHERE provider=r.provider AND provider_account=r.provider_account FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.merchant_id::text||':'||r.currency,0));
  SELECT evidence_revision INTO STRICT sr FROM public.capture_accounting_scopes WHERE merchant_id=r.merchant_id AND currency=r.currency FOR NO KEY UPDATE;
  SELECT * INTO STRICT s FROM public.financial_application_scope_authority WHERE merchant_id=r.merchant_id AND currency=r.currency;
  IF (s.provider,s.provider_account,s.policy,s.epoch) IS DISTINCT FROM(r.provider,r.provider_account,r.policy,r.acceptance_epoch) THEN RAISE EXCEPTION 'Stored policy or acceptance epoch mismatch'; END IF;
  SELECT coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=r.provider AND provider_account=r.provider_account),0) INTO ir;
  SELECT * INTO c FROM public.financial_application_contracts WHERE family=r.family AND phase=r.phase AND policy=r.policy;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation-specific financial application contract is not installed'; END IF;
  -- Payment-operation and internal proof alternatives stay closed until reviewed.
  IF r.family<>'REFUND' THEN RAISE EXCEPTION 'Typed application proof contract is not installed'; END IF;
  PERFORM 1 FROM public.payments WHERE id=r.payment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.refunds WHERE id=r.refund_id FOR UPDATE;
  PERFORM 1 FROM public.capture_accounting_lots WHERE payment_id=r.payment_id ORDER BY capture_attempt_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.dispute_capture_allocations WHERE payment_id=r.payment_id ORDER BY capture_lot_id,id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.refund_capture_allocations WHERE payment_id=r.payment_id ORDER BY capture_lot_id,id FOR NO KEY UPDATE;
  e:=public.load_effective_financial_evidence(p_inbox,p_revision,p_operation);
  IF (e.refund_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account) IS DISTINCT FROM
    (r.refund_id,r.payment_id,r.merchant_id,r.currency,r.provider,r.provider_account) THEN RAISE EXCEPTION 'Typed proof owner mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations WHERE inbox_id=p_inbox AND proof_revision=p_revision
    AND operation=p_operation AND disposition='AWAITING_APPLICATION' AND merchant_id=r.merchant_id AND currency=r.currency) THEN RAISE EXCEPTION 'Exact admitted application source required'; END IF;
  -- This checkpoint has no generic blocker bypass or recovery capability.
  PERFORM public.check_financial_application_admission(p_root,p_inbox);
  EXECUTE format('SELECT %s($1)',c.prepare_function::oid::regproc) INTO plan USING p_root;
  IF jsonb_typeof(plan) IS DISTINCT FROM 'object' OR jsonb_typeof(plan->'sources') IS DISTINCT FROM 'object'
    OR jsonb_typeof(plan->'effects') IS DISTINCT FROM 'array' OR plan->>'result' NOT IN ('POSTED','ZERO_EFFECT','VERIFIED_NO_EFFECT') THEN
    RAISE EXCEPTION 'Installed SQL contract returned incomplete manifest'; END IF;
  INSERT INTO public.financial_application_manifests(root_id,transaction_id,backend_pid,inbox_id,proof_revision,proof_operation,claim_generation,
    merchant_id,currency,payment_id,policy,epoch,scope_revision,intake_revision,contract_version,result,source_manifest,effect_manifest)
    VALUES(r.id,pg_current_xact_id(),pg_backend_pid(),p_inbox,p_revision,p_operation,p_generation,r.merchant_id,r.currency,r.payment_id,
      r.policy,r.acceptance_epoch,sr,ir,c.version,plan->>'result',plan->'sources',plan->'effects') RETURNING id INTO m;
  INSERT INTO public.financial_application_permits(transaction_id,backend_pid,manifest_id) VALUES(pg_current_xact_id(),pg_backend_pid(),m);
  FOR x IN SELECT DISTINCT ON(value->>'table',value->>'id') value FROM jsonb_array_elements(plan->'effects') WITH ORDINALITY v(value,n)
    ORDER BY value->>'table',value->>'id',n DESC LOOP
    kind:=x->>'table'; effect:=(x->>'id')::uuid;
    IF kind IN ('ledger_transactions','capture_accounting_lots','refund_capture_allocations','dispute_capture_allocations','dispute_hold_effects','settlement_items') THEN
      INSERT INTO public.financial_application_effect_links(manifest_id,root_id,relation_name,effect_id,merchant_id,currency,payment_id,
        journal_id,lot_id,refund_allocation_id,dispute_allocation_id,hold_effect_id,settlement_item_id)
        VALUES(m,r.id,kind,effect,r.merchant_id,r.currency,r.payment_id,
          CASE WHEN kind='ledger_transactions' THEN effect END,CASE WHEN kind='capture_accounting_lots' THEN effect END,
          CASE WHEN kind='refund_capture_allocations' THEN effect END,CASE WHEN kind='dispute_capture_allocations' THEN effect END,
          CASE WHEN kind='dispute_hold_effects' THEN effect END,CASE WHEN kind='settlement_items' THEN effect END);
    END IF;
  END LOOP;
  RETURN m;
END $$;

CREATE FUNCTION public.check_financial_application_admission(p_root uuid,p_own_inbox uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.financial_application_roots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=p_root;
  IF EXISTS(SELECT 1 FROM public.receipt_admission_obligations o WHERE
    ((o.provider=r.provider AND o.provider_account=r.provider_account AND o.merchant_id IS NULL AND o.disposition IN ('AWAITING_CORRELATION','BLOCKING_REVIEW'))
      OR (o.merchant_id=r.merchant_id AND o.currency=r.currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
    AND NOT (o.inbox_id=p_own_inbox AND o.disposition='AWAITING_APPLICATION')
    AND NOT EXISTS(SELECT 1 FROM public.financial_application_dispositions d WHERE d.inbox_id=o.inbox_id AND d.obligation_revision=o.obligation_revision))
    OR EXISTS(SELECT 1 FROM public.provider_observation_obligations o WHERE
      ((o.provider=r.provider AND o.provider_account=r.provider_account AND o.merchant_id IS NULL AND o.disposition='BLOCKING_REVIEW')
      OR (o.merchant_id=r.merchant_id AND o.currency=r.currency AND o.disposition IN ('AWAITING_APPLICATION','BLOCKING_REVIEW')))
      AND NOT EXISTS(SELECT 1 FROM public.financial_application_dispositions d WHERE d.observation_source_id=o.source_id)
      AND NOT (o.disposition='AWAITING_APPLICATION' AND EXISTS(SELECT 1 FROM public.webhook_financial_evidence e
        JOIN public.provider_observation_projections l ON l.observation_id=e.refund_observation_id
        JOIN public.provider_observation_sources v ON v.id=l.source_id WHERE e.inbox_id=p_own_inbox AND l.source_id=o.source_id
        AND v.outbox_id=r.accepted_outbox_id AND e.refund_id=r.refund_id AND v.normalized_outcome->>'object_id'=e.provider_object_id
        AND v.normalized_outcome->>'reason'=CASE e.operation WHEN 'refund.succeeded' THEN 'CONFIRMED_PROVIDER_RESULT' WHEN 'refund.failed' THEN 'DEFINITIVE_PROVIDER_FAILURE' END)))
    OR EXISTS(SELECT 1 FROM public.receipt_delivery_barriers b WHERE (b.provider=r.provider AND b.provider_account=r.provider_account AND b.merchant_id IS NULL)
      OR (b.merchant_id=r.merchant_id AND b.currency=r.currency))
    OR EXISTS(SELECT 1 FROM public.accounting_exceptions WHERE merchant_id=r.merchant_id AND currency=r.currency AND status='OPEN') THEN
    RAISE EXCEPTION 'Application blocked by unrelated or unresolved source'; END IF;
END $$;

CREATE FUNCTION public.current_financial_application_manifest() RETURNS public.financial_application_manifests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; r public.financial_application_roots%ROWTYPE;
BEGIN
  SELECT v.* INTO m FROM public.financial_application_permits p JOIN public.financial_application_manifests v ON v.id=p.manifest_id
    WHERE p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.database_principal=session_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current transaction/backend application permit required'; END IF;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency AND s.policy=m.policy AND s.epoch=m.epoch)
    OR NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes s WHERE s.merchant_id=m.merchant_id AND s.currency=m.currency
      AND s.evidence_revision=coalesce((SELECT final_revision FROM public.financial_application_revision_effects WHERE manifest_id=m.id),m.scope_revision))
    OR m.intake_revision IS DISTINCT FROM coalesce((SELECT evidence_revision FROM public.receipt_intake_authority WHERE provider=r.provider AND provider_account=r.provider_account),0)
    OR NOT EXISTS(SELECT 1 FROM public.webhook_events WHERE id=m.inbox_id AND attempts=m.claim_generation AND status IN ('PROCESSING','PROCESSED')) THEN
    RAISE EXCEPTION 'Stale application policy, claim or evidence revision'; END IF;
  RETURN m;
END $$;

-- Both directions use this same protected manifest and installed SQL validator.
-- Missing groups cannot be certified by journal uniqueness or a caller status.
CREATE FUNCTION public.validate_financial_application(p_root uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.financial_applications%ROWTYPE; m public.financial_application_manifests%ROWTYPE;
  r public.financial_application_roots%ROWTYPE; c public.financial_application_contracts%ROWTYPE; ok boolean; x jsonb; actual jsonb;
BEGIN
  SELECT * INTO a FROM public.financial_applications WHERE root_id=p_root;
  IF NOT FOUND THEN RAISE EXCEPTION 'Protected effect requires complete financial application'; END IF;
  SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=a.manifest_id;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=p_root;
  SELECT * INTO c FROM public.financial_application_contracts WHERE family=r.family AND phase=r.phase AND policy=m.policy AND version=m.contract_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complete operation validator is not installed'; END IF;
  IF a.result IS DISTINCT FROM m.result OR a.audit_id IS DISTINCT FROM (m.source_manifest->>'audit_id')::uuid
    OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE id=a.audit_id AND merchant_id=m.merchant_id)
    OR NOT EXISTS(SELECT 1 FROM public.webhook_events WHERE id=m.inbox_id AND status='PROCESSED' AND attempts=m.claim_generation)
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_dispositions d JOIN public.receipt_admission_obligations o ON o.inbox_id=d.inbox_id AND o.obligation_revision=d.obligation_revision
      WHERE d.root_id=p_root AND d.inbox_id=m.inbox_id AND d.disposition=CASE WHEN a.result='VERIFIED_NO_EFFECT' THEN 'VERIFIED_NO_EFFECT' ELSE 'APPLIED' END) THEN
    RAISE EXCEPTION 'Application requires exact workflow, immutable audit and source disposition'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) items(value) WHERE items.value->>'table'='refunds' AND items.value->>'id'=r.refund_id::text)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) items(value) WHERE items.value->>'table'='audit_logs' AND items.value->>'id'=a.audit_id::text)
    OR (m.result='POSTED' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) items(value) WHERE items.value->>'table'='ledger_transactions'
      AND items.value#>>'{after,status}'='POSTED' AND items.value#>>'{after,business_id}'=r.operation_id::text AND items.value#>>'{after,business_type}'=r.family)) THEN
    RAISE EXCEPTION 'Missing entire workflow, audit or primary journal effect group'; END IF;
  IF m.result<>'POSTED' AND (EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) items(value) WHERE items.value->>'table' IN ('ledger_transactions','ledger_entries'))
    OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE business_type=r.family AND business_id=r.operation_id)) THEN
    RAISE EXCEPTION 'Zero/no-effect application cannot own a financial journal'; END IF;
  FOR x IN SELECT DISTINCT ON(value->>'table',value->>'id') value FROM jsonb_array_elements(m.effect_manifest) WITH ORDINALITY v(value,n)
    ORDER BY value->>'table',value->>'id',n DESC LOOP
    IF x->>'table' NOT IN ('payments','payment_attempts','refunds','disputes','payouts','settlements','settlement_items','capture_accounting_lots',
      'refund_capture_allocations','dispute_capture_allocations','dispute_hold_effects','ledger_transactions','ledger_entries','audit_logs') THEN
      RAISE EXCEPTION 'Unsupported manifest effect relation'; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',x->>'table') INTO actual USING (x->>'id')::uuid;
    IF actual IS DISTINCT FROM x->'after' THEN RAISE EXCEPTION 'Missing or mismatched manifested effect'; END IF;
  END LOOP;
  EXECUTE format('SELECT %s($1)',c.validate_function::oid::regproc) INTO ok USING m.id;
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Incomplete or mismatched financial effects'; END IF;
END $$;

CREATE FUNCTION public.guard_financial_application_records() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE;
BEGIN
  m:=public.current_financial_application_manifest();
  IF NEW.root_id IS DISTINCT FROM m.root_id THEN RAISE EXCEPTION 'Application root does not match transaction permit'; END IF;
  IF TG_TABLE_NAME='financial_applications' THEN
    IF NEW.manifest_id IS DISTINCT FROM m.id THEN RAISE EXCEPTION 'Application manifest mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME='financial_application_dispositions' THEN
    -- Recovery/delivery/D02 finalizers stay closed until their complete typed
    -- validator is installed; no note or broad payment match can discharge them.
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
CREATE FUNCTION public.check_financial_application_finality() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.validate_financial_application(NEW.root_id);
  IF NOT EXISTS(SELECT 1 FROM public.financial_application_revision_effects e JOIN public.financial_application_manifests m ON m.id=e.manifest_id
    JOIN public.capture_accounting_scopes s ON (s.merchant_id,s.currency)=(m.merchant_id,m.currency)
    WHERE e.root_id=NEW.root_id AND e.prior_revision=m.scope_revision AND s.evidence_revision=e.final_revision) THEN
    RAISE EXCEPTION 'Final application requires its guarded revision effect'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.advance_financial_application_revision() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE;
BEGIN
  m:=public.current_financial_application_manifest();
  PERFORM public.validate_financial_application(m.root_id);
  INSERT INTO public.financial_application_revision_effects(manifest_id,root_id,prior_revision,final_revision)
    VALUES(m.id,m.root_id,m.scope_revision,m.scope_revision+1);
  UPDATE public.capture_accounting_scopes SET evidence_revision=evidence_revision+1
    WHERE merchant_id=m.merchant_id AND currency=m.currency AND evidence_revision=m.scope_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stale application revision'; END IF;
END $$;
CREATE FUNCTION public.complete_financial_application() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; d text;
BEGIN
  m:=public.current_financial_application_manifest();
  UPDATE public.webhook_events SET status='PROCESSED',processed_at=now(),locked_at=NULL,updated_at=now()
    WHERE id=m.inbox_id AND status='PROCESSING' AND attempts=m.claim_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim finality compare-and-set failed'; END IF;
  INSERT INTO public.financial_applications(root_id,manifest_id,result,audit_id) VALUES(m.root_id,m.id,m.result,(m.source_manifest->>'audit_id')::uuid);
  d:=CASE WHEN m.result='VERIFIED_NO_EFFECT' THEN 'VERIFIED_NO_EFFECT' ELSE 'APPLIED' END;
  INSERT INTO public.financial_application_dispositions(root_id,inbox_id,obligation_revision,disposition)
    SELECT m.root_id,inbox_id,obligation_revision,d FROM public.receipt_admission_obligations WHERE inbox_id=m.inbox_id;
  INSERT INTO public.financial_application_dispositions(root_id,observation_source_id,disposition)
    SELECT m.root_id,l.source_id,d FROM public.webhook_financial_evidence e JOIN public.provider_observation_projections l ON l.observation_id=e.refund_observation_id WHERE e.inbox_id=m.inbox_id;
  PERFORM public.advance_financial_application_revision();
  RETURN m.root_id;
END $$;
CREATE TRIGGER application_record_permit BEFORE INSERT ON public.financial_applications FOR EACH ROW EXECUTE FUNCTION public.guard_financial_application_records();
CREATE TRIGGER application_disposition_permit BEFORE INSERT ON public.financial_application_dispositions FOR EACH ROW EXECUTE FUNCTION public.guard_financial_application_records();
CREATE CONSTRAINT TRIGGER application_complete AFTER INSERT ON public.financial_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_financial_application_finality();
CREATE CONSTRAINT TRIGGER application_disposition_complete AFTER INSERT ON public.financial_application_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_financial_application_finality();

-- Prospective reverse implication. Enrollment is protected and empty, so these
-- triggers do not change legacy behavior. Once enrolled, NULL/version0 or an
-- arbitrary business type does not select a legacy escape route. An installed
-- preparation contract must name every exact before/after write, including
-- DRAFT construction and POSTED sealing. It is not a worker-supplied snapshot.
-- Resolve implicated owners independently of a caller's claimed scope or the
-- existence of an application root. Both trigger timings use this same lookup.
CREATE FUNCTION public.financial_application_effect_owners(p_relation text,p_row jsonb)
RETURNS TABLE(merchant_id uuid,currency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_row IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT (p_row->>'merchant_id')::uuid,p_row->>'currency';
  IF p_row->>'payment_id' IS NOT NULL THEN
    RETURN QUERY SELECT p.merchant_id,p.currency FROM public.payments p WHERE p.id=(p_row->>'payment_id')::uuid;
  END IF;
  IF p_relation='ledger_transactions' THEN
    -- A changed/unsupported business_type must not conceal a known operation.
    RETURN QUERY WITH sources AS (
      SELECT a.merchant_id,a.currency,a.payment_id FROM public.payment_attempts a WHERE a.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT r.merchant_id,r.currency,r.payment_id FROM public.refunds r WHERE r.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT d.merchant_id,d.currency,d.payment_id FROM public.disputes d WHERE d.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT h.merchant_id,h.currency,h.payment_id FROM public.dispute_hold_effects h WHERE h.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT s.merchant_id,s.currency,NULL::uuid FROM public.settlements s WHERE s.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT p.merchant_id,p.currency,NULL::uuid FROM public.payouts p WHERE p.id=(p_row->>'business_id')::uuid
      UNION ALL SELECT a.merchant_id,a.currency,a.payment_id FROM public.provider_command_authorities a WHERE a.operation_id=(p_row->>'business_id')::uuid
      UNION ALL SELECT r.merchant_id,r.currency,r.payment_id FROM public.financial_application_roots r WHERE r.operation_id=(p_row->>'business_id')::uuid
    ) SELECT s.merchant_id,s.currency FROM sources s
      UNION ALL SELECT p.merchant_id,p.currency FROM sources s JOIN public.payments p ON p.id=s.payment_id;
  ELSIF p_relation='ledger_entries' THEN
    RETURN QUERY SELECT owners.* FROM public.ledger_transactions t
      CROSS JOIN LATERAL public.financial_application_effect_owners('ledger_transactions',to_jsonb(t)) owners
      WHERE t.id=(p_row->>'transaction_id')::uuid;
    RETURN QUERY SELECT a.merchant_id,a.currency FROM public.ledger_accounts a WHERE a.id=(p_row->>'account_id')::uuid;
  ELSIF p_relation='settlement_items' THEN
    RETURN QUERY SELECT s.merchant_id,s.currency FROM public.settlements s WHERE s.id=(p_row->>'settlement_id')::uuid;
    RETURN QUERY SELECT a.merchant_id,a.currency FROM public.payment_attempts a WHERE a.id=(p_row->>'capture_attempt_id')::uuid;
    RETURN QUERY SELECT p.merchant_id,p.currency FROM public.payment_attempts a JOIN public.payments p ON p.id=a.payment_id
      WHERE a.id=(p_row->>'capture_attempt_id')::uuid;
    RETURN QUERY SELECT l.merchant_id,l.currency FROM public.capture_accounting_lots l WHERE l.id=(p_row->>'capture_lot_id')::uuid;
    RETURN QUERY SELECT owners.* FROM public.ledger_transactions t
      CROSS JOIN LATERAL public.financial_application_effect_owners('ledger_transactions',to_jsonb(t)) owners
      WHERE t.business_type='CAPTURE' AND t.business_id=(p_row->>'capture_attempt_id')::uuid;
  END IF;
END $$;

-- Prospective only: historical legacy candidates are neither scanned nor
-- rewritten. Protected candidates retain original capture amounts, independently
-- of later refund/hold effects and of their optional allocation-policy fields.
CREATE FUNCTION public.check_financial_application_item_owner(p_row jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.settlements s
    JOIN public.payments p ON p.id=(p_row->>'payment_id')::uuid AND (p.merchant_id,p.currency)=(s.merchant_id,s.currency)
    JOIN public.payment_attempts a ON a.id=(p_row->>'capture_attempt_id')::uuid
      AND (a.payment_id,a.merchant_id,a.currency)=(p.id,p.merchant_id,p.currency) AND a.kind='CAPTURE' AND a.status='SUCCEEDED'
    JOIN public.ledger_transactions j ON j.business_type='CAPTURE' AND j.business_id=a.id
      AND (j.merchant_id,j.currency)=(a.merchant_id,a.currency) AND j.status='POSTED'
    CROSS JOIN LATERAL (SELECT
      coalesce(sum(e.debit) FILTER (WHERE ac.code='PSP_CLEARING' AND ac.merchant_id IS NULL),0) gross,
      coalesce(sum(e.credit) FILTER (WHERE ac.code='PLATFORM_FEE_REVENUE' AND ac.merchant_id IS NULL),0) fee,
      coalesce(sum(e.credit) FILTER (WHERE ac.code='MERCHANT_PENDING' AND ac.merchant_id=p.merchant_id),0) net
      FROM public.ledger_entries e JOIN public.ledger_accounts ac ON ac.id=e.account_id
      WHERE e.transaction_id=j.id AND e.currency=p.currency AND ac.currency=p.currency) amounts
    WHERE s.id=(p_row->>'settlement_id')::uuid AND s.currency=p_row->>'currency'
      AND a.amount=(p_row->>'gross_amount')::bigint
      AND amounts.gross>0 AND amounts.gross=amounts.fee+amounts.net
      AND (amounts.gross,amounts.fee,amounts.net)=((p_row->>'gross_amount')::bigint,(p_row->>'fee_amount')::bigint,(p_row->>'net_amount')::bigint)) THEN
    RAISE EXCEPTION 'Protected settlement item requires owned header, payment and original capture journal amounts';
  END IF;
END $$;

CREATE FUNCTION public.guard_financial_application_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb;
  m public.financial_application_manifests%ROWTYPE; application_root public.financial_application_roots%ROWTYPE; protected boolean;
BEGIN
  IF TG_OP='DELETE' THEN n:=to_jsonb(OLD); END IF;
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  SELECT EXISTS(SELECT 1 FROM (VALUES(n),(o)) images(body)
    CROSS JOIN LATERAL public.financial_application_effect_owners(TG_TABLE_NAME,images.body) owners
    JOIN public.financial_application_scope_authority s USING(merchant_id,currency)) INTO protected;
  IF NOT protected THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Protected financial effect cannot be deleted'; END IF;
  m:=public.current_financial_application_manifest();
  SELECT * INTO STRICT application_root FROM public.financial_application_roots WHERE id=m.root_id;
  IF EXISTS(SELECT 1 FROM (VALUES(n),(o)) images(body)
    CROSS JOIN LATERAL public.financial_application_effect_owners(TG_TABLE_NAME,images.body) owners
    WHERE (owners.merchant_id IS NOT NULL AND owners.merchant_id IS DISTINCT FROM m.merchant_id)
      OR (owners.currency IS NOT NULL AND owners.currency IS DISTINCT FROM m.currency)) THEN RAISE EXCEPTION 'Protected effect scope mismatch'; END IF;
  IF TG_TABLE_NAME='ledger_entries' THEN
    IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=(n->>'transaction_id')::uuid
      AND (t.merchant_id,t.currency)=(m.merchant_id,m.currency)) THEN RAISE EXCEPTION 'Protected entry requires owned journal'; END IF;
  ELSIF TG_TABLE_NAME<>'settlement_items' AND ((n->>'merchant_id')::uuid,n->>'currency') IS DISTINCT FROM (m.merchant_id,m.currency) THEN
    RAISE EXCEPTION 'Protected effect scope mismatch';
  END IF;
  IF TG_TABLE_NAME='ledger_transactions' THEN
    IF ((n->>'business_type'=application_root.family AND (n->>'business_id')::uuid=application_root.operation_id)
      OR (n->>'business_type'='DISPUTE_HOLD_ADJUSTMENT' AND application_root.family='REFUND')) IS NOT TRUE THEN
      RAISE EXCEPTION 'Unsupported financial business type or operation journal'; END IF;
  ELSIF TG_TABLE_NAME='settlement_items' THEN
    IF TG_OP='UPDATE' AND (n->'settlement_id',n->'payment_id',n->'capture_attempt_id',n->'capture_lot_id',n->'currency',n->'gross_amount',n->'fee_amount',n->'net_amount')
      IS DISTINCT FROM (o->'settlement_id',o->'payment_id',o->'capture_attempt_id',o->'capture_lot_id',o->'currency',o->'gross_amount',o->'fee_amount',o->'net_amount') THEN
      RAISE EXCEPTION 'Protected settlement candidate identity and original amounts are immutable'; END IF;
    PERFORM public.check_financial_application_item_owner(n);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=TG_TABLE_NAME AND x->>'id'=n->>'id'
    AND x->>'write'=TG_OP AND x->'after'=n AND (TG_OP='INSERT' OR x->'before'=o)) THEN
    RAISE EXCEPTION 'Protected effect requires its SQL-prepared exact write'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.check_financial_application_effect_finality() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; actual jsonb; o jsonb; protected boolean;
BEGIN
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',TG_TABLE_NAME) INTO actual USING NEW.id;
  SELECT EXISTS(SELECT 1 FROM (VALUES(to_jsonb(NEW)),(o),(actual)) images(body)
    CROSS JOIN LATERAL public.financial_application_effect_owners(TG_TABLE_NAME,images.body) owners
    JOIN public.financial_application_scope_authority s USING(merchant_id,currency)) INTO protected;
  -- Re-resolve final rows, including OLD references. Missing authority/application
  -- must refuse independently of whether a permit or manifest was ever inserted.
  IF protected THEN
    m:=public.current_financial_application_manifest();
    IF actual IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x
      WHERE x->>'table'=TG_TABLE_NAME AND x->>'id'=NEW.id::text AND x->'after'=actual) THEN
      RAISE EXCEPTION 'Protected final effect requires its SQL-prepared manifest'; END IF;
    IF EXISTS(SELECT 1 FROM public.financial_application_effect_owners(TG_TABLE_NAME,actual) owners
      WHERE (owners.merchant_id IS NOT NULL AND owners.merchant_id IS DISTINCT FROM m.merchant_id)
        OR (owners.currency IS NOT NULL AND owners.currency IS DISTINCT FROM m.currency)) THEN RAISE EXCEPTION 'Protected final effect scope mismatch'; END IF;
    IF TG_TABLE_NAME='settlement_items' THEN PERFORM public.check_financial_application_item_owner(actual); END IF;
    PERFORM public.validate_financial_application(m.root_id);
    RETURN NULL;
  END IF;
  SELECT v.* INTO m FROM public.financial_application_permits p JOIN public.financial_application_manifests v ON v.id=p.manifest_id
    WHERE p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid();
  IF FOUND AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=TG_TABLE_NAME AND x->>'id'=NEW.id::text) THEN
    PERFORM public.validate_financial_application(m.root_id);
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.reject_protected_application_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.financial_application_scope_authority) THEN RAISE EXCEPTION 'Protected financial relations cannot be truncated'; END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payments','payment_attempts','refunds','disputes','payouts','settlements','settlement_items',
    'capture_accounting_lots','refund_capture_allocations','dispute_capture_allocations','dispute_hold_effects','ledger_transactions','ledger_entries'] LOOP
    EXECUTE format('CREATE TRIGGER application_effect_permit BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_financial_application_effect()',t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER application_effect_complete AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_financial_application_effect_finality()',t);
    EXECUTE format('CREATE TRIGGER application_effect_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_protected_application_truncate()',t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['financial_application_contracts','financial_application_scope_authority','financial_application_roots',
    'financial_application_manifests','financial_application_permits','financial_applications','financial_application_dispositions','financial_application_revision_effects','financial_application_effect_links'] LOOP
    EXECUTE format('CREATE TRIGGER application_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('CREATE TRIGGER application_immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.protect_financial_evidence()',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  END LOOP;
END $$;

DO $$ DECLARE owner_name text:='fintech_application_'||md5(current_database()); f record; BEGIN
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',owner_name);
  EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE format('GRANT SELECT ON public.financial_application_contracts,public.financial_application_scope_authority,public.financial_application_roots,
    public.financial_application_manifests,public.financial_application_permits,public.financial_applications,public.financial_application_dispositions,
    public.financial_application_revision_effects,public.financial_application_effect_links,public.provider_observation_sources,public.provider_observation_projections,
    public.financial_evidence_accounts,public.capture_accounting_scopes,public.receipt_intake_authority,public.webhook_events,public.webhook_financial_evidence,
    public.receipt_admission_obligations,public.receipt_delivery_barriers,public.provider_observation_obligations,public.accounting_exceptions,
    public.provider_command_authorities,public.payments,public.payment_attempts,public.refunds,public.disputes,public.payouts,public.settlements,
    public.settlement_items,public.dispute_hold_effects,public.capture_accounting_lots,public.dispute_capture_allocations,
    public.refund_capture_allocations,public.audit_logs,public.ledger_transactions,public.ledger_entries,public.ledger_accounts,
    public.provider_financial_receipts,public.provider_financial_object_owners,public.provider_financial_observations TO %I',owner_name);
  EXECUTE format('GRANT INSERT ON public.financial_application_manifests,public.financial_application_permits,public.financial_applications,public.financial_application_dispositions,public.financial_application_effect_links TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(updated_at) ON public.webhook_events,public.payments,public.refunds TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(status,processed_at,locked_at) ON public.webhook_events TO %I',owner_name);
  EXECUTE format('GRANT UPDATE(created_at) ON public.financial_evidence_accounts,public.capture_accounting_scopes,public.capture_accounting_lots,public.dispute_capture_allocations,public.refund_capture_allocations TO %I',owner_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.load_effective_financial_evidence(uuid,integer,text),public.financial_receipt_facts(uuid),public.financial_external_reference(jsonb),public.protect_financial_evidence() TO %I',owner_name);
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('check_financial_application_root','prepare_financial_application','check_financial_application_admission','current_financial_application_manifest',
     'validate_financial_application','guard_financial_application_records','check_financial_application_finality',
     'financial_application_effect_owners','check_financial_application_item_owner',
     'guard_financial_application_effect','check_financial_application_effect_finality','reject_protected_application_truncate','complete_financial_application') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,owner_name);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.advance_financial_application_revision() TO %I',owner_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_financial_application_manifest(),public.validate_financial_application(uuid) TO %I','fintech_admission_'||md5(current_database()));
  EXECUTE format('GRANT SELECT ON public.financial_application_manifests,public.financial_application_revision_effects TO %I','fintech_admission_'||md5(current_database()));
  EXECUTE format('GRANT INSERT ON public.financial_application_revision_effects TO %I','fintech_admission_'||md5(current_database()));
  REVOKE ALL ON FUNCTION public.advance_financial_application_revision() FROM PUBLIC;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I','fintech_admission_'||md5(current_database()));
  EXECUTE format('ALTER FUNCTION public.advance_financial_application_revision() OWNER TO %I','fintech_admission_'||md5(current_database()));
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I','fintech_admission_'||md5(current_database()));
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END $$;

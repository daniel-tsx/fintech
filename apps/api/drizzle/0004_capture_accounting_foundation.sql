-- B1 installs evidence/allocation foundations ONLY. Existing financial writers
-- do not consume these tables. Drain writers before applying transactionally.
-- ALTER TABLE/unique-key installation may block reads as well as writes.
LOCK TABLE public.ledger_transactions, public.ledger_entries, public.payments,
  public.payment_attempts, public.refunds, public.disputes, public.settlements,
  public.settlement_items IN SHARE ROW EXCLUSIVE MODE;
-- A CAPTURE with no routable owner cannot even be assigned a review scope.
-- Refuse atomically; preserve its evidence for explicit migration review.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ledger_transactions WHERE business_type='CAPTURE'
    AND (merchant_id IS NULL OR currency !~ '^[A-Z]{3}$')) THEN
    RAISE EXCEPTION 'Unscoped legacy CAPTURE evidence requires human migration review';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.payments ADD CONSTRAINT payments_accounting_scope UNIQUE (id, merchant_id, currency);
ALTER TABLE public.payment_attempts ADD CONSTRAINT attempts_accounting_scope UNIQUE (id, payment_id, merchant_id, currency);
ALTER TABLE public.refunds ADD CONSTRAINT refunds_accounting_scope UNIQUE (id, payment_id, merchant_id, currency);
ALTER TABLE public.disputes ADD CONSTRAINT disputes_accounting_scope UNIQUE (id, payment_id, merchant_id, currency);
ALTER TABLE public.ledger_transactions ADD CONSTRAINT journals_accounting_scope UNIQUE (id, merchant_id, currency);
ALTER TABLE public.settlements ADD CONSTRAINT settlements_accounting_scope UNIQUE (id, merchant_id, currency);
--> statement-breakpoint
CREATE TABLE public.capture_accounting_scopes (
  merchant_id uuid NOT NULL REFERENCES public.merchants(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'FOUNDATION_ONLY' CHECK (status IN ('FOUNDATION_ONLY','REVIEW_REQUIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,currency)
);
-- Deliberately no ACTIVE state in B1. B2 must review migration/cutover before
-- extending this gate and connecting any financial reader/writer.
CREATE TABLE public.capture_accounting_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_attempt_id uuid NOT NULL UNIQUE,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  capture_journal_id uuid NOT NULL UNIQUE,
  original_gross bigint NOT NULL CHECK (original_gross > 0),
  original_fee bigint NOT NULL CHECK (original_fee >= 0 AND original_fee <= original_gross),
  original_net bigint NOT NULL CHECK (original_net = original_gross-original_fee),
  financial_captured_at timestamptz NOT NULL,
  eligible_at timestamptz,
  origin text NOT NULL DEFAULT 'NEW_CAPTURE' CHECK (origin IN ('NEW_CAPTURE','LEGACY_ORIGINAL_ONLY')),
  policy_version text NOT NULL DEFAULT 'CAPTURE_FIFO_V1' CHECK (policy_version = 'CAPTURE_FIFO_V1'),
  allocation_revision bigint NOT NULL DEFAULT 0 CHECK (allocation_revision >= 0),
  settlement_state text NOT NULL DEFAULT 'UNSETTLED' CHECK (settlement_state IN ('UNSETTLED','FINALIZED')),
  finalized_settlement_item_id uuid UNIQUE REFERENCES public.settlement_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin='LEGACY_ORIGINAL_ONLY' OR eligible_at IS NOT NULL) AND (eligible_at IS NULL OR eligible_at >= financial_captured_at)),
  CHECK ((settlement_state='UNSETTLED' AND finalized_settlement_item_id IS NULL) OR (settlement_state='FINALIZED' AND finalized_settlement_item_id IS NOT NULL)),
  UNIQUE (id,payment_id,merchant_id,currency),
  UNIQUE (id,capture_attempt_id,payment_id,currency),
  FOREIGN KEY (merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  FOREIGN KEY (payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency),
  FOREIGN KEY (capture_attempt_id,payment_id,merchant_id,currency) REFERENCES public.payment_attempts(id,payment_id,merchant_id,currency),
  FOREIGN KEY (capture_journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency)
);
CREATE INDEX capture_lots_payment_fifo ON public.capture_accounting_lots(payment_id,financial_captured_at,capture_attempt_id);
--> statement-breakpoint
CREATE TABLE public.refund_capture_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL,
  capture_lot_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  reserved_gross bigint NOT NULL CHECK (reserved_gross > 0),
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONFIRMED','RELEASED')),
  confirmed_gross bigint,
  confirmed_fee bigint,
  journal_id uuid,
  provider_event_id uuid REFERENCES public.webhook_events(id),
  release_reason text,
  policy_version text NOT NULL DEFAULT 'CAPTURE_FIFO_V1' CHECK (policy_version='CAPTURE_FIFO_V1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id,capture_lot_id),
  CHECK ((
    (status='RESERVED' AND confirmed_gross IS NULL AND confirmed_fee IS NULL AND journal_id IS NULL AND provider_event_id IS NULL AND release_reason IS NULL)
    OR (status='CONFIRMED' AND confirmed_gross=reserved_gross AND confirmed_fee>=0 AND confirmed_fee<=confirmed_gross AND journal_id IS NOT NULL AND provider_event_id IS NOT NULL AND release_reason IS NULL)
    OR (status='RELEASED' AND confirmed_gross IS NULL AND confirmed_fee IS NULL AND journal_id IS NULL AND provider_event_id IS NOT NULL AND release_reason='CONFIRMED_PROVIDER_FAILURE')
  ) IS TRUE),
  FOREIGN KEY (refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency),
  FOREIGN KEY (capture_lot_id,payment_id,merchant_id,currency) REFERENCES public.capture_accounting_lots(id,payment_id,merchant_id,currency),
  FOREIGN KEY (journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency)
);
CREATE INDEX refund_allocations_lot ON public.refund_capture_allocations(capture_lot_id);
--> statement-breakpoint
CREATE TABLE public.dispute_capture_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL,
  capture_lot_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  gross_principal bigint NOT NULL CHECK (gross_principal > 0),
  funded_hold bigint NOT NULL CHECK (funded_hold >= 0 AND funded_hold <= gross_principal),
  unfunded_exposure bigint NOT NULL CHECK (unfunded_exposure = gross_principal-funded_hold),
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','OPEN','CLOSED')),
  outcome text CHECK (outcome IN ('MERCHANT_WON','MERCHANT_LOST')),
  open_journal_id uuid,
  close_journal_id uuid,
  policy_version text NOT NULL DEFAULT 'CAPTURE_FIFO_V1' CHECK (policy_version='CAPTURE_FIFO_V1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispute_id,capture_lot_id),
  UNIQUE (id,capture_lot_id,payment_id,merchant_id,currency),
  CHECK ((status='PLANNED' AND outcome IS NULL AND open_journal_id IS NULL AND close_journal_id IS NULL)
    OR (status='OPEN' AND outcome IS NULL AND close_journal_id IS NULL AND (funded_hold=0 OR open_journal_id IS NOT NULL))
    OR (status='CLOSED' AND outcome IS NOT NULL AND (funded_hold=0 OR open_journal_id IS NOT NULL) AND (outcome='MERCHANT_WON' OR close_journal_id IS NOT NULL))),
  FOREIGN KEY (dispute_id,payment_id,merchant_id,currency) REFERENCES public.disputes(id,payment_id,merchant_id,currency),
  FOREIGN KEY (capture_lot_id,payment_id,merchant_id,currency) REFERENCES public.capture_accounting_lots(id,payment_id,merchant_id,currency),
  FOREIGN KEY (open_journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency),
  FOREIGN KEY (close_journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency)
);
CREATE INDEX dispute_allocations_lot ON public.dispute_capture_allocations(capture_lot_id);
CREATE TABLE public.dispute_hold_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL,
  capture_lot_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  effect_key text NOT NULL CHECK (length(effect_key)>0),
  hold_delta bigint NOT NULL CHECK (hold_delta<>0),
  journal_id uuid NOT NULL UNIQUE,
  provider_event_id uuid NOT NULL REFERENCES public.webhook_events(id),
  cause_refund_id uuid REFERENCES public.refunds(id),
  cause_dispute_id uuid REFERENCES public.disputes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (allocation_id,effect_key),
  CHECK ((cause_refund_id IS NOT NULL)::integer+(cause_dispute_id IS NOT NULL)::integer=1),
  FOREIGN KEY (allocation_id,capture_lot_id,payment_id,merchant_id,currency) REFERENCES public.dispute_capture_allocations(id,capture_lot_id,payment_id,merchant_id,currency),
  FOREIGN KEY (cause_refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency),
  FOREIGN KEY (cause_dispute_id,payment_id,merchant_id,currency) REFERENCES public.disputes(id,payment_id,merchant_id,currency),
  FOREIGN KEY (journal_id,merchant_id,currency) REFERENCES public.ledger_transactions(id,merchant_id,currency)
);
--> statement-breakpoint
CREATE TABLE public.accounting_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  payment_id uuid,
  category text NOT NULL CHECK (category IN ('REFUND_DISPUTE_PRINCIPAL_OVERLAP','AMBIGUOUS_PROVIDER_NET_EFFECT','LEGACY_ALLOCATION_UNRECONCILED','SETTLEMENT_ELIGIBILITY_CONFLICT')),
  source_kind text NOT NULL CHECK (source_kind IN ('WEBHOOK','LEGACY','INTERNAL')),
  evidence_key text NOT NULL CHECK (length(evidence_key)>0),
  provider_event_id uuid REFERENCES public.webhook_events(id),
  refund_id uuid,
  dispute_id uuid,
  observed_conflict jsonb NOT NULL CHECK (jsonb_typeof(observed_conflict)='object'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution_reference text,
  resolved_by uuid REFERENCES public.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind='WEBHOOK' AND provider_event_id IS NOT NULL AND evidence_key='webhook:'||provider_event_id::text)
    OR (source_kind IN ('LEGACY','INTERNAL') AND provider_event_id IS NULL)),
  CHECK ((refund_id IS NULL AND dispute_id IS NULL) OR payment_id IS NOT NULL),
  CHECK (((status='OPEN' AND resolution_reference IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (status='RESOLVED' AND length(resolution_reference)>0 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)) IS TRUE),
  UNIQUE (merchant_id,currency,category,evidence_key),
  UNIQUE (id,payment_id,merchant_id,currency),
  FOREIGN KEY (merchant_id,currency) REFERENCES public.capture_accounting_scopes(merchant_id,currency),
  FOREIGN KEY (payment_id,merchant_id,currency) REFERENCES public.payments(id,merchant_id,currency),
  FOREIGN KEY (refund_id,payment_id,merchant_id,currency) REFERENCES public.refunds(id,payment_id,merchant_id,currency),
  FOREIGN KEY (dispute_id,payment_id,merchant_id,currency) REFERENCES public.disputes(id,payment_id,merchant_id,currency)
);
CREATE INDEX accounting_exceptions_open ON public.accounting_exceptions(merchant_id,currency,status);
CREATE TABLE public.accounting_exception_lots (
  exception_id uuid NOT NULL,
  capture_lot_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  PRIMARY KEY (exception_id,capture_lot_id),
  FOREIGN KEY (exception_id,payment_id,merchant_id,currency) REFERENCES public.accounting_exceptions(id,payment_id,merchant_id,currency),
  FOREIGN KEY (capture_lot_id,payment_id,merchant_id,currency) REFERENCES public.capture_accounting_lots(id,payment_id,merchant_id,currency)
);
--> statement-breakpoint
-- Nullable additive fields leave every existing API/runtime insert unchanged.
ALTER TABLE public.settlements
  ADD COLUMN accounting_policy_version text,
  ADD COLUMN estimated_asset_transfer bigint,
  ADD COLUMN estimated_merchant_release bigint,
  ADD COLUMN finalized_asset_transfer bigint,
  ADD COLUMN finalized_merchant_release bigint,
  ADD COLUMN finalization_result text,
  ADD COLUMN accounting_journal_id uuid REFERENCES public.ledger_transactions(id),
  ADD COLUMN accounting_finalized_at timestamptz,
  ADD CONSTRAINT settlement_foundation_fields CHECK ((
    (accounting_policy_version IS NULL AND estimated_asset_transfer IS NULL AND estimated_merchant_release IS NULL AND finalized_asset_transfer IS NULL AND finalized_merchant_release IS NULL AND finalization_result IS NULL AND accounting_journal_id IS NULL AND accounting_finalized_at IS NULL)
    OR (accounting_policy_version='CAPTURE_FIFO_V1' AND estimated_asset_transfer>=0 AND estimated_merchant_release>=0 AND
      ((finalization_result IS NULL AND finalized_asset_transfer IS NULL AND finalized_merchant_release IS NULL AND accounting_journal_id IS NULL AND accounting_finalized_at IS NULL)
       OR (status='SUCCEEDED' AND accounting_finalized_at IS NOT NULL AND finalized_asset_transfer>=0 AND finalized_merchant_release>=0 AND
         ((finalization_result='ZERO_EFFECT' AND finalized_asset_transfer=0 AND finalized_merchant_release=0 AND accounting_journal_id IS NULL)
          OR (finalization_result='POSTED' AND (finalized_asset_transfer>0 OR finalized_merchant_release>0) AND accounting_journal_id IS NOT NULL)))))
  ) IS TRUE);
ALTER TABLE public.settlement_items
  ADD COLUMN capture_lot_id uuid,
  ADD COLUMN accounting_policy_version text,
  ADD COLUMN estimated_asset_transfer bigint,
  ADD COLUMN estimated_merchant_release bigint,
  ADD COLUMN selected_revision bigint,
  ADD COLUMN finalized_asset_transfer bigint,
  ADD COLUMN finalized_merchant_release bigint,
  ADD COLUMN restricted_hold bigint,
  ADD COLUMN applied_revision bigint,
  ADD COLUMN finalization_result text,
  ADD COLUMN accounting_journal_id uuid REFERENCES public.ledger_transactions(id),
  ADD COLUMN accounting_finalized_at timestamptz,
  ADD CONSTRAINT settlement_item_lot_scope FOREIGN KEY (capture_lot_id,capture_attempt_id,payment_id,currency) REFERENCES public.capture_accounting_lots(id,capture_attempt_id,payment_id,currency),
  ADD CONSTRAINT settlement_item_foundation_fields CHECK ((
    (accounting_policy_version IS NULL AND capture_lot_id IS NULL AND estimated_asset_transfer IS NULL AND estimated_merchant_release IS NULL AND selected_revision IS NULL AND finalized_asset_transfer IS NULL AND finalized_merchant_release IS NULL AND restricted_hold IS NULL AND applied_revision IS NULL AND finalization_result IS NULL AND accounting_journal_id IS NULL AND accounting_finalized_at IS NULL)
    OR (accounting_policy_version='CAPTURE_FIFO_V1' AND capture_lot_id IS NOT NULL AND estimated_asset_transfer>=0 AND estimated_merchant_release>=0 AND selected_revision>=0 AND
      ((finalization_result IS NULL AND finalized_asset_transfer IS NULL AND finalized_merchant_release IS NULL AND restricted_hold IS NULL AND applied_revision IS NULL AND accounting_journal_id IS NULL AND accounting_finalized_at IS NULL)
       OR (accounting_finalized_at IS NOT NULL AND finalized_asset_transfer>=0 AND finalized_asset_transfer<=gross_amount AND finalized_merchant_release>=0 AND finalized_merchant_release<=net_amount AND restricted_hold>=0 AND restricted_hold<=net_amount AND applied_revision>=selected_revision AND
         ((finalization_result='ZERO_EFFECT' AND finalized_asset_transfer=0 AND finalized_merchant_release=0 AND accounting_journal_id IS NULL)
          OR (finalization_result='POSTED' AND (finalized_asset_transfer>0 OR finalized_merchant_release>0) AND accounting_journal_id IS NOT NULL)))))
  ) IS TRUE);
--> statement-breakpoint
-- Live inspection view, not an activation decision or a balance projection.
CREATE VIEW public.capture_accounting_legacy_inventory AS
WITH original AS (
  SELECT a.id AS capture_attempt_id,p.id AS payment_id,p.merchant_id,p.currency,
    a.status AS attempt_status,a.amount AS attempt_amount,
    j.journal_id,j.financial_captured_at,j.gross,j.fee,j.net,
    coalesce(j.journal_count=1 AND j.journal_valid AND j.entries_valid AND j.gross>0
      AND j.gross=j.fee+j.net AND j.gross=a.amount AND a.status='SUCCEEDED'
      AND a.merchant_id=p.merchant_id AND a.currency=p.currency,false) AS original_valid,
    (SELECT count(*) FROM public.refunds r WHERE r.payment_id=p.id) AS refund_records,
    (SELECT count(*) FROM public.disputes d WHERE d.payment_id=p.id) AS dispute_records,
    (SELECT count(*) FROM public.settlement_items i WHERE i.capture_attempt_id=a.id) AS settlement_records
  FROM public.payment_attempts a JOIN public.payments p ON p.id=a.payment_id
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT t.id) AS journal_count,min(t.id::text)::uuid AS journal_id,
      min(t.posted_at) AS financial_captured_at,
      bool_and((t.status='POSTED' AND t.merchant_id=p.merchant_id AND t.currency=p.currency AND t.posted_at IS NOT NULL) IS TRUE) AS journal_valid,
      -- bool_and ignores NULL inputs: every ownership predicate must be TRUE.
      bool_and((e.currency=p.currency AND ac.currency=p.currency AND
        ((ac.code='PSP_CLEARING' AND ac.account_type='ASSET' AND ac.merchant_id IS NULL AND e.debit>0 AND e.credit=0)
         OR (ac.code='MERCHANT_PENDING' AND ac.account_type='LIABILITY' AND ac.merchant_id=p.merchant_id AND e.credit>0 AND e.debit=0)
          OR (ac.code='PLATFORM_FEE_REVENUE' AND ac.account_type='REVENUE' AND ac.merchant_id IS NULL AND e.credit>0 AND e.debit=0))) IS TRUE)
        AND count(*) FILTER (WHERE ac.code='PSP_CLEARING')=1
        AND count(*) FILTER (WHERE ac.code='MERCHANT_PENDING')<=1
        AND count(*) FILTER (WHERE ac.code='PLATFORM_FEE_REVENUE')<=1 AS entries_valid,
      coalesce(sum(e.debit) FILTER (WHERE ac.code='PSP_CLEARING'),0) AS gross,
      coalesce(sum(e.credit) FILTER (WHERE ac.code='PLATFORM_FEE_REVENUE'),0) AS fee,
      coalesce(sum(e.credit) FILTER (WHERE ac.code='MERCHANT_PENDING'),0) AS net
    FROM public.ledger_transactions t
    LEFT JOIN public.ledger_entries e ON e.transaction_id=t.id
    LEFT JOIN public.ledger_accounts ac ON ac.id=e.account_id
    WHERE t.business_type='CAPTURE' AND t.business_id=a.id
  ) j ON true
  WHERE a.kind='CAPTURE' AND (a.status='SUCCEEDED' OR j.journal_count>0)
)
SELECT *,CASE WHEN original_valid AND refund_records=0 AND dispute_records=0 AND settlement_records=0
  THEN 'ORIGINAL_VERIFIED' ELSE 'REVIEW_REQUIRED' END AS classification
FROM original;
CREATE VIEW public.capture_accounting_orphan_inventory AS
SELECT t.id AS journal_id,t.business_id AS capture_reference,t.merchant_id,t.currency,t.status,t.posted_at
FROM public.ledger_transactions t WHERE t.business_type='CAPTURE'
  AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.id=t.business_id AND a.kind='CAPTURE');
--> statement-breakpoint
CREATE FUNCTION public.validate_capture_accounting_lot() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original public.capture_accounting_legacy_inventory%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capture accounting evidence cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.capture_attempt_id,NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.capture_journal_id,
        NEW.original_gross,NEW.original_fee,NEW.original_net,NEW.financial_captured_at,NEW.origin,NEW.policy_version,NEW.created_at)
      IS DISTINCT FROM
       (OLD.id,OLD.capture_attempt_id,OLD.payment_id,OLD.merchant_id,OLD.currency,OLD.capture_journal_id,
        OLD.original_gross,OLD.original_fee,OLD.original_net,OLD.financial_captured_at,OLD.origin,OLD.policy_version,OLD.created_at)
      OR (OLD.eligible_at IS NOT NULL AND NEW.eligible_at IS DISTINCT FROM OLD.eligible_at)
      OR NEW.allocation_revision<OLD.allocation_revision
      OR (OLD.settlement_state='FINALIZED' AND (NEW.settlement_state,NEW.finalized_settlement_item_id) IS DISTINCT FROM (OLD.settlement_state,OLD.finalized_settlement_item_id)) THEN
      RAISE EXCEPTION 'Original capture identity and finalized accounting evidence are immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM public.capture_accounting_legacy_inventory WHERE capture_attempt_id=NEW.capture_attempt_id;
  IF NOT FOUND OR NOT original.original_valid
    OR (NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.capture_journal_id,NEW.original_gross::numeric,NEW.original_fee::numeric,NEW.original_net::numeric,NEW.financial_captured_at)
      IS DISTINCT FROM (original.payment_id,original.merchant_id,original.currency,original.journal_id,original.gross,original.fee,original.net,original.financial_captured_at) THEN
    RAISE EXCEPTION 'Capture lot must agree with one immutable POSTED CAPTURE journal and successful attempt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_lot_evidence BEFORE INSERT OR UPDATE OR DELETE ON public.capture_accounting_lots
FOR EACH ROW EXECUTE FUNCTION public.validate_capture_accounting_lot();
--> statement-breakpoint
CREATE FUNCTION public.prepare_capture_allocation_write() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE lot_id uuid; event public.webhook_events%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Allocation evidence cannot be deleted; use its lifecycle or a new effect'; END IF;
  IF TG_TABLE_NAME='refund_capture_allocations' THEN
    IF TG_OP='UPDATE' AND (OLD.status<>'RESERVED' OR
      (NEW.id,NEW.refund_id,NEW.capture_lot_id,NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.reserved_gross,NEW.policy_version,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.refund_id,OLD.capture_lot_id,OLD.payment_id,OLD.merchant_id,OLD.currency,OLD.reserved_gross,OLD.policy_version,OLD.created_at)) THEN
      RAISE EXCEPTION 'Frozen refund attribution and final effects are immutable';
    END IF;
    -- Same-value parent writes create versions, invalidating stale RR snapshots
    -- of aggregate allocations. Identity parents precede the common lot parent.
    UPDATE public.refunds SET amount=amount WHERE id=NEW.refund_id;
    IF NEW.status IN ('CONFIRMED','RELEASED') THEN
      SELECT * INTO event FROM public.webhook_events WHERE id=NEW.provider_event_id;
      IF NOT FOUND OR event.payload->>'type' IS DISTINCT FROM (CASE WHEN NEW.status='CONFIRMED' THEN 'refund.succeeded' ELSE 'refund.failed' END)
        OR event.payload->'data'->>'refundId' IS DISTINCT FROM NEW.refund_id::text
        OR event.payload->'data'->>'paymentId' IS DISTINCT FROM NEW.payment_id::text
        OR event.payload->'data'->>'merchantId' IS DISTINCT FROM NEW.merchant_id::text
        OR event.payload->'data'->>'currency' IS DISTINCT FROM NEW.currency THEN
        RAISE EXCEPTION 'Final refund allocation requires correlated confirmed provider evidence';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='dispute_capture_allocations' THEN
    IF TG_OP='UPDATE' AND (OLD.status='CLOSED' OR
      (NEW.id,NEW.dispute_id,NEW.capture_lot_id,NEW.payment_id,NEW.merchant_id,NEW.currency,NEW.gross_principal,NEW.funded_hold,NEW.unfunded_exposure,NEW.policy_version,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.dispute_id,OLD.capture_lot_id,OLD.payment_id,OLD.merchant_id,OLD.currency,OLD.gross_principal,OLD.funded_hold,OLD.unfunded_exposure,OLD.policy_version,OLD.created_at)
      OR (OLD.status='OPEN' AND (NEW.status='PLANNED' OR NEW.open_journal_id IS DISTINCT FROM OLD.open_journal_id))) THEN
      RAISE EXCEPTION 'Dispute principal and applied funding evidence are immutable';
    END IF;
    UPDATE public.disputes SET amount=amount WHERE id=NEW.dispute_id;
  ELSE
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Hold adjustment effects are append-only'; END IF;
    UPDATE public.disputes SET amount=amount WHERE id=(SELECT dispute_id FROM public.dispute_capture_allocations WHERE id=NEW.allocation_id);
    PERFORM 1 FROM public.dispute_capture_allocations WHERE id=NEW.allocation_id AND status='OPEN' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Hold adjustments require an OPEN allocation'; END IF;
  END IF;
  lot_id:=NEW.capture_lot_id;
  UPDATE public.capture_accounting_lots SET allocation_revision=allocation_revision+1 WHERE id=lot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation references an unknown capture lot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refund_allocation_write BEFORE INSERT OR UPDATE OR DELETE ON public.refund_capture_allocations
FOR EACH ROW EXECUTE FUNCTION public.prepare_capture_allocation_write();
CREATE TRIGGER dispute_allocation_write BEFORE INSERT OR UPDATE OR DELETE ON public.dispute_capture_allocations
FOR EACH ROW EXECUTE FUNCTION public.prepare_capture_allocation_write();
CREATE TRIGGER dispute_hold_effect_write BEFORE INSERT OR UPDATE OR DELETE ON public.dispute_hold_effects
FOR EACH ROW EXECUTE FUNCTION public.prepare_capture_allocation_write();
--> statement-breakpoint
CREATE FUNCTION public.check_capture_allocation_bounds() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE lot public.capture_accounting_lots%ROWTYPE; refund_gross numeric; refund_fee numeric;
  reserved numeric; dispute_principal numeric; lost numeric; held numeric;
BEGIN
  SELECT * INTO lot FROM public.capture_accounting_lots WHERE id=NEW.capture_lot_id;
  SELECT coalesce(sum(confirmed_gross) FILTER (WHERE status='CONFIRMED'),0),
    coalesce(sum(confirmed_fee) FILTER (WHERE status='CONFIRMED'),0),
    coalesce(sum(reserved_gross) FILTER (WHERE status='RESERVED'),0)
    INTO refund_gross,refund_fee,reserved FROM public.refund_capture_allocations WHERE capture_lot_id=lot.id;
  SELECT coalesce(sum(gross_principal) FILTER (WHERE status IN ('PLANNED','OPEN')),0),
    coalesce(sum(gross_principal) FILTER (WHERE status='CLOSED' AND outcome='MERCHANT_LOST'),0)
    INTO dispute_principal,lost FROM public.dispute_capture_allocations WHERE capture_lot_id=lot.id;
  IF refund_gross+reserved+dispute_principal+lost>lot.original_gross THEN RAISE EXCEPTION 'Capture principal allocation exceeds recognized capacity or overlaps'; END IF;
  -- Nonnegative integer quotient matches BigInt exactly; numeric / can round
  -- before floor at bigint bounds. Numeric multiplication avoids overflow.
  IF refund_fee<>pg_catalog.div(lot.original_fee::numeric*refund_gross,lot.original_gross::numeric) THEN RAISE EXCEPTION 'Confirmed capture refund fees do not reconcile cumulatively'; END IF;
  SELECT coalesce(sum(d.funded_hold+coalesce(e.delta,0)),0) INTO held
    FROM public.dispute_capture_allocations d
    LEFT JOIN LATERAL (SELECT sum(hold_delta) AS delta FROM public.dispute_hold_effects WHERE allocation_id=d.id) e ON true
    WHERE d.capture_lot_id=lot.id AND d.status IN ('PLANNED','OPEN');
  IF held>greatest(lot.original_net::numeric-(refund_gross-refund_fee)-lost,0) THEN RAISE EXCEPTION 'Funded dispute holds exceed surviving merchant entitlement'; END IF;
  IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations d
    LEFT JOIN LATERAL (SELECT sum(hold_delta) AS delta FROM public.dispute_hold_effects WHERE allocation_id=d.id) e ON true
    WHERE d.capture_lot_id=lot.id AND (d.funded_hold+coalesce(e.delta,0)<0 OR d.funded_hold+coalesce(e.delta,0)>d.gross_principal)) THEN
    RAISE EXCEPTION 'Adjusted dispute funding is outside principal bounds';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER refund_allocation_capacity AFTER INSERT OR UPDATE ON public.refund_capture_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_bounds();
CREATE CONSTRAINT TRIGGER dispute_allocation_capacity AFTER INSERT OR UPDATE ON public.dispute_capture_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_bounds();
CREATE CONSTRAINT TRIGGER hold_effect_capacity AFTER INSERT ON public.dispute_hold_effects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_bounds();
--> statement-breakpoint
CREATE FUNCTION public.require_accounting_journal(journal_id uuid,kind text,business_id uuid,merchant_id uuid,currency text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.id=journal_id AND t.status='POSTED'
    AND t.business_type=kind AND t.business_id=require_accounting_journal.business_id
    AND t.merchant_id=require_accounting_journal.merchant_id AND t.currency=require_accounting_journal.currency) THEN
    RAISE EXCEPTION 'Accounting effect requires the matching immutable POSTED business journal';
  END IF;
END;
$$;
CREATE FUNCTION public.check_capture_allocation_effect() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE total numeric; amount bigint; fee numeric; active integer; finalized integer;
  journal uuid; event public.webhook_events%ROWTYPE; allocation public.dispute_capture_allocations%ROWTYPE;
  hold_amount numeric; actual numeric; closed_outcome text;
BEGIN
  IF TG_TABLE_NAME='refund_capture_allocations' THEN
    SELECT r.amount INTO amount FROM public.refunds r WHERE r.id=NEW.refund_id;
    SELECT coalesce(sum(reserved_gross) FILTER (WHERE status<>'RELEASED'),0),
      count(*) FILTER (WHERE status<>'RELEASED'),count(*) FILTER (WHERE status='CONFIRMED'),
      coalesce(sum(confirmed_fee),0),min(journal_id::text)::uuid
      INTO total,active,finalized,fee,journal FROM public.refund_capture_allocations WHERE refund_id=NEW.refund_id;
    IF total<>0 AND total<>amount THEN RAISE EXCEPTION 'Frozen refund allocations must cover the whole accepted refund'; END IF;
    IF finalized>0 THEN
      IF finalized<>active OR total<>amount OR EXISTS (SELECT 1 FROM public.refund_capture_allocations WHERE refund_id=NEW.refund_id AND status='CONFIRMED' AND journal_id<>journal) THEN
        RAISE EXCEPTION 'Confirmed refund allocations must finalize atomically with one journal';
      END IF;
      PERFORM public.require_accounting_journal(journal,'REFUND',NEW.refund_id,NEW.merchant_id,NEW.currency);
      SELECT coalesce(sum(e.credit) FILTER (WHERE a.code IN ('PSP_CLEARING','PLATFORM_CASH')),0),
        coalesce(sum(e.debit) FILTER (WHERE a.code='PLATFORM_FEE_REFUNDS'),0)
        INTO total,actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=journal;
      IF total<>amount OR actual<>fee THEN RAISE EXCEPTION 'Refund journal and allocation amounts disagree'; END IF;
    END IF;
    SELECT * INTO event FROM public.webhook_events WHERE id=NEW.provider_event_id;
    IF NEW.status IN ('CONFIRMED','RELEASED') AND (event.payload->'data'->>'amount')::numeric IS DISTINCT FROM amount::numeric THEN
      RAISE EXCEPTION 'Refund provider evidence amount disagrees with accepted intent';
    END IF;
  ELSIF TG_TABLE_NAME='dispute_capture_allocations' THEN
    SELECT d.amount INTO amount FROM public.disputes d WHERE d.id=NEW.dispute_id;
    SELECT coalesce(sum(gross_principal),0) INTO total FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id;
    IF total<>amount THEN RAISE EXCEPTION 'Dispute allocations must cover the whole recorded principal'; END IF;
    FOR allocation IN SELECT * FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id LOOP
      IF allocation.open_journal_id IS NOT NULL THEN PERFORM public.require_accounting_journal(allocation.open_journal_id,'DISPUTE_OPEN',allocation.dispute_id,allocation.merchant_id,allocation.currency); END IF;
      IF allocation.close_journal_id IS NOT NULL THEN PERFORM public.require_accounting_journal(allocation.close_journal_id,'DISPUTE_CLOSE',allocation.dispute_id,allocation.merchant_id,allocation.currency); END IF;
    END LOOP;
    -- Opening journals have one case business key. Planned rows are non-applied.
    IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id AND status<>'PLANNED') THEN
      IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id AND status='PLANNED') THEN RAISE EXCEPTION 'Dispute funding must open atomically'; END IF;
      SELECT sum(funded_hold),min(open_journal_id::text)::uuid INTO hold_amount,journal FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id;
      IF hold_amount>0 THEN
        SELECT coalesce(sum(e.credit),0) INTO actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=journal AND a.code='DISPUTE_CLEARING';
        IF actual<>hold_amount THEN RAISE EXCEPTION 'Dispute opening journal and funded allocations disagree'; END IF;
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id AND status='CLOSED') THEN
      SELECT outcome INTO closed_outcome FROM public.dispute_capture_allocations WHERE id=NEW.id;
      IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE dispute_id=NEW.dispute_id AND
        (status<>'CLOSED' OR outcome IS DISTINCT FROM closed_outcome)) THEN RAISE EXCEPTION 'Dispute outcome must finalize atomically'; END IF;
      SELECT coalesce(sum(d.funded_hold+coalesce(e.delta,0)),0),min(d.close_journal_id::text)::uuid INTO hold_amount,journal
        FROM public.dispute_capture_allocations d LEFT JOIN LATERAL
        (SELECT sum(hold_delta) AS delta FROM public.dispute_hold_effects WHERE allocation_id=d.id) e ON true WHERE d.dispute_id=NEW.dispute_id;
      IF hold_amount>0 OR closed_outcome='MERCHANT_LOST' THEN
        PERFORM public.require_accounting_journal(journal,'DISPUTE_CLOSE',NEW.dispute_id,NEW.merchant_id,NEW.currency);
        SELECT coalesce(sum(e.debit),0) INTO actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=journal AND a.code='DISPUTE_CLEARING';
        IF actual<>hold_amount THEN RAISE EXCEPTION 'Dispute close journal disagrees with adjusted funding'; END IF;
        IF closed_outcome='MERCHANT_LOST' THEN
          SELECT coalesce(sum(e.credit),0) INTO actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=journal AND a.code IN ('PSP_CLEARING','PLATFORM_CASH');
          IF actual<>amount THEN RAISE EXCEPTION 'Dispute loss journal disagrees with gross principal'; END IF;
        ELSE
          SELECT coalesce(sum(e.credit),0) INTO actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=journal AND a.code IN ('MERCHANT_PENDING','MERCHANT_AVAILABLE');
          IF actual<>hold_amount THEN RAISE EXCEPTION 'Dispute win journal disagrees with released funding'; END IF;
        END IF;
      END IF;
    END IF;
  ELSE
    PERFORM public.require_accounting_journal(NEW.journal_id,'DISPUTE_HOLD_ADJUSTMENT',NEW.id,NEW.merchant_id,NEW.currency);
    SELECT coalesce(sum(e.credit-e.debit),0) INTO actual FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=NEW.journal_id AND a.code='DISPUTE_CLEARING';
    IF actual<>NEW.hold_delta THEN RAISE EXCEPTION 'Hold adjustment delta and journal disagree'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER refund_allocation_effect AFTER INSERT OR UPDATE ON public.refund_capture_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_effect();
CREATE CONSTRAINT TRIGGER dispute_allocation_effect AFTER INSERT OR UPDATE ON public.dispute_capture_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_effect();
CREATE CONSTRAINT TRIGGER dispute_hold_effect AFTER INSERT ON public.dispute_hold_effects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capture_allocation_effect();
--> statement-breakpoint
CREATE FUNCTION public.protect_accounting_foundation_evidence() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Accounting evidence cannot be deleted or truncated'; END IF;
  IF TG_TABLE_NAME='accounting_exception_lots' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Exception lot references are immutable'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.accounting_exceptions WHERE id=NEW.exception_id AND status='OPEN') THEN RAISE EXCEPTION 'Only OPEN exceptions may receive lot references'; END IF;
  ELSIF TG_TABLE_NAME='accounting_exceptions' THEN
    IF TG_OP='UPDATE' AND (OLD.status='RESOLVED' OR
      (to_jsonb(NEW)-ARRAY['status','resolution_reference','resolved_by','resolved_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','resolution_reference','resolved_by','resolved_at'])) THEN RAISE EXCEPTION 'Original exception evidence and reviewed resolutions are immutable'; END IF;
    IF NEW.status='OPEN' THEN UPDATE public.capture_accounting_scopes SET status='REVIEW_REQUIRED' WHERE merchant_id=NEW.merchant_id AND currency=NEW.currency; END IF;
  ELSIF TG_TABLE_NAME='settlement_items' THEN
    -- B2 callers must lock batch before lots. A real parent version also
    -- rejects stale repeatable-read snapshots of concurrent item sums.
    UPDATE public.settlements SET updated_at=updated_at WHERE id=NEW.settlement_id;
    IF EXISTS (SELECT 1 FROM public.settlements WHERE id=NEW.settlement_id AND finalization_result IS NOT NULL)
      AND (TG_OP='INSERT' OR OLD.finalization_result IS NOT NULL) THEN RAISE EXCEPTION 'Finalized batch cannot receive new candidate effects'; END IF;
    IF TG_OP='UPDATE' AND OLD.finalization_result IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Finalized settlement allocations are immutable'; END IF;
    IF TG_OP='UPDATE' AND OLD.capture_lot_id IS NOT NULL AND
      (to_jsonb(NEW)-ARRAY['finalized_asset_transfer','finalized_merchant_release','restricted_hold','applied_revision','finalization_result','accounting_journal_id','accounting_finalized_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['finalized_asset_transfer','finalized_merchant_release','restricted_hold','applied_revision','finalization_result','accounting_journal_id','accounting_finalized_at']) THEN
      RAISE EXCEPTION 'Settlement candidate identity and estimates are immutable';
    END IF;
  ELSIF TG_TABLE_NAME='settlements' THEN
    IF TG_OP='UPDATE' AND OLD.finalization_result IS NOT NULL AND
      (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'Finalized settlement batch evidence is immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER exception_evidence BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_exceptions
FOR EACH ROW EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER exception_lot_evidence BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_exception_lots
FOR EACH ROW EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER settlement_item_evidence BEFORE INSERT OR UPDATE ON public.settlement_items
FOR EACH ROW WHEN (NEW.capture_lot_id IS NOT NULL) EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER settlement_item_delete BEFORE DELETE ON public.settlement_items
FOR EACH ROW WHEN (OLD.capture_lot_id IS NOT NULL) EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER settlement_batch_evidence BEFORE UPDATE OR DELETE ON public.settlements
FOR EACH ROW WHEN (OLD.accounting_policy_version IS NOT NULL) EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER capture_lots_no_truncate BEFORE TRUNCATE ON public.capture_accounting_lots FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER refund_allocations_no_truncate BEFORE TRUNCATE ON public.refund_capture_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER dispute_allocations_no_truncate BEFORE TRUNCATE ON public.dispute_capture_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER hold_effects_no_truncate BEFORE TRUNCATE ON public.dispute_hold_effects FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER exceptions_no_truncate BEFORE TRUNCATE ON public.accounting_exceptions FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
CREATE TRIGGER exception_lots_no_truncate BEFORE TRUNCATE ON public.accounting_exception_lots FOR EACH STATEMENT EXECUTE FUNCTION public.protect_accounting_foundation_evidence();
--> statement-breakpoint
CREATE FUNCTION public.check_accounting_settlement_evidence() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE item public.settlement_items%ROWTYPE; batch public.settlements%ROWTYPE; lot public.capture_accounting_lots%ROWTYPE;
  batch_id uuid; asset_total numeric; release_total numeric; actual_asset numeric; actual_release numeric;
  refunded numeric; returned_fee numeric; lost numeric; held numeric;
BEGIN
  IF TG_TABLE_NAME='capture_accounting_lots' THEN
    IF NEW.finalized_settlement_item_id IS NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND OLD.settlement_state='FINALIZED' THEN RETURN NULL; END IF;
    SELECT * INTO item FROM public.settlement_items WHERE id=NEW.finalized_settlement_item_id;
    IF item.capture_lot_id IS DISTINCT FROM NEW.id OR item.finalization_result IS NULL THEN RAISE EXCEPTION 'Finalized lot requires matching final settlement item evidence'; END IF;
    batch_id:=item.settlement_id;
  ELSIF TG_TABLE_NAME='settlement_items' THEN
    IF NEW.capture_lot_id IS NULL THEN RETURN NULL; END IF;
    batch_id:=NEW.settlement_id;
  ELSE
    IF NEW.accounting_policy_version IS NULL THEN RETURN NULL; END IF;
    batch_id:=NEW.id;
  END IF;
  SELECT * INTO batch FROM public.settlements WHERE id=batch_id;
  IF batch.accounting_policy_version IS NULL THEN RAISE EXCEPTION 'Foundation items cannot belong to a legacy batch'; END IF;
  IF batch.finalization_result IS NOT NULL THEN
    -- Same scope parent as exception creation: earlier conflicting evidence
    -- must be visible, or a stale repeatable-read finalizer must abort.
    UPDATE public.capture_accounting_scopes SET status=status WHERE merchant_id=batch.merchant_id AND currency=batch.currency;
  END IF;
  FOR item IN SELECT * FROM public.settlement_items WHERE settlement_id=batch_id LOOP
    SELECT * INTO lot FROM public.capture_accounting_lots WHERE id=item.capture_lot_id;
    IF item.capture_lot_id IS NULL OR lot.merchant_id IS DISTINCT FROM batch.merchant_id OR lot.currency IS DISTINCT FROM batch.currency
      OR (item.gross_amount,item.fee_amount,item.net_amount) IS DISTINCT FROM (lot.original_gross,lot.original_fee,lot.original_net)
      OR item.accounting_policy_version IS DISTINCT FROM batch.accounting_policy_version THEN RAISE EXCEPTION 'Foundation settlement candidates require scoped original capture lots'; END IF;
    -- Read the completed transaction, allowing item/lot/batch construction in
    -- either order, but never commit a final item against a pending batch.
    IF item.finalization_result IS NOT NULL AND batch.finalization_result IS NULL THEN
      RAISE EXCEPTION 'Finalized capture allocations require a completed foundation batch';
    END IF;
    IF item.finalization_result IS NOT NULL AND (lot.settlement_state<>'FINALIZED' OR lot.finalized_settlement_item_id<>item.id OR item.applied_revision<>lot.allocation_revision) THEN
      RAISE EXCEPTION 'Settlement item finalization and locked lot revision must agree';
    END IF;
    IF item.finalization_result IS NOT NULL AND (lot.eligible_at IS NULL OR lot.eligible_at>now()) THEN RAISE EXCEPTION 'Settlement finalization requires confirmed mature eligibility'; END IF;
    IF item.finalization_result IS NOT NULL THEN
      SELECT coalesce(sum(confirmed_gross),0),coalesce(sum(confirmed_fee),0) INTO refunded,returned_fee
        FROM public.refund_capture_allocations WHERE capture_lot_id=lot.id AND status='CONFIRMED';
      SELECT coalesce(sum(gross_principal) FILTER (WHERE status='CLOSED' AND outcome='MERCHANT_LOST'),0) INTO lost
        FROM public.dispute_capture_allocations WHERE capture_lot_id=lot.id;
      SELECT coalesce(sum(d.funded_hold+coalesce(e.delta,0)),0) INTO held FROM public.dispute_capture_allocations d
        LEFT JOIN LATERAL (SELECT sum(hold_delta) AS delta FROM public.dispute_hold_effects WHERE allocation_id=d.id) e ON true
        WHERE d.capture_lot_id=lot.id AND d.status='OPEN';
      IF item.finalized_asset_transfer<>lot.original_gross-refunded-lost OR item.restricted_hold<>held
        OR item.finalized_merchant_release<>greatest(lot.original_net-(refunded-returned_fee)-lost-held,0) THEN
        RAISE EXCEPTION 'Final settlement amounts must reconcile with confirmed capture allocations';
      END IF;
      IF EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE capture_lot_id=lot.id AND status='PLANNED') THEN
        RAISE EXCEPTION 'Non-applied dispute funding cannot finalize settlement';
      END IF;
    END IF;
  END LOOP;
  SELECT coalesce(sum(estimated_asset_transfer),0),coalesce(sum(estimated_merchant_release),0)
    INTO asset_total,release_total FROM public.settlement_items WHERE settlement_id=batch_id;
  IF asset_total<>batch.estimated_asset_transfer OR release_total<>batch.estimated_merchant_release THEN RAISE EXCEPTION 'Settlement estimates must equal actual candidate item sums'; END IF;
  IF batch.finalization_result IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.accounting_exceptions WHERE merchant_id=batch.merchant_id AND currency=batch.currency AND status='OPEN') THEN
      RAISE EXCEPTION 'Unresolved accounting exceptions block foundation settlement finalization for this scope';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.settlement_items WHERE settlement_id=batch_id) OR EXISTS (SELECT 1 FROM public.settlement_items WHERE settlement_id=batch_id AND finalization_result IS NULL) THEN
      RAISE EXCEPTION 'Foundation settlement completion requires all real candidate items finalized';
    END IF;
    SELECT sum(finalized_asset_transfer),sum(finalized_merchant_release) INTO asset_total,release_total FROM public.settlement_items WHERE settlement_id=batch_id;
    IF asset_total<>batch.finalized_asset_transfer OR release_total<>batch.finalized_merchant_release THEN RAISE EXCEPTION 'Final settlement totals must equal finalized item sums'; END IF;
    IF batch.finalization_result='POSTED' THEN
      PERFORM public.require_accounting_journal(batch.accounting_journal_id,'SETTLEMENT',batch.id,batch.merchant_id,batch.currency);
      SELECT coalesce(sum(e.debit) FILTER (WHERE a.code='PLATFORM_CASH'),0),coalesce(sum(e.debit) FILTER (WHERE a.code='MERCHANT_PENDING'),0)
        INTO actual_asset,actual_release FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=batch.accounting_journal_id;
      IF actual_asset<>asset_total OR actual_release<>release_total THEN RAISE EXCEPTION 'Settlement journal disagrees with finalized asset/release amounts'; END IF;
      SELECT coalesce(sum(e.credit) FILTER (WHERE a.code='PSP_CLEARING'),0),coalesce(sum(e.credit) FILTER (WHERE a.code='MERCHANT_AVAILABLE'),0)
        INTO actual_asset,actual_release FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id=e.account_id WHERE e.transaction_id=batch.accounting_journal_id;
      IF actual_asset<>asset_total OR actual_release<>release_total THEN RAISE EXCEPTION 'Settlement destination amounts disagree with finalized asset/release amounts'; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.settlement_items WHERE settlement_id=batch_id AND
      ((finalization_result='POSTED' AND accounting_journal_id IS DISTINCT FROM batch.accounting_journal_id)
       OR (finalization_result='ZERO_EFFECT' AND accounting_journal_id IS NOT NULL))) THEN RAISE EXCEPTION 'Settlement item journals must agree with batch result'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_lot_finalization AFTER INSERT OR UPDATE ON public.capture_accounting_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_accounting_settlement_evidence();
CREATE CONSTRAINT TRIGGER accounting_settlement_item AFTER INSERT OR UPDATE ON public.settlement_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_accounting_settlement_evidence();
CREATE CONSTRAINT TRIGGER accounting_settlement_batch AFTER INSERT OR UPDATE ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_accounting_settlement_evidence();
--> statement-breakpoint
CREATE FUNCTION public.protect_allocated_intent_amount() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount AND
    ((TG_TABLE_NAME='refunds' AND EXISTS (SELECT 1 FROM public.refund_capture_allocations WHERE refund_id=OLD.id))
     OR (TG_TABLE_NAME='disputes' AND EXISTS (SELECT 1 FROM public.dispute_capture_allocations WHERE dispute_id=OLD.id))) THEN
    RAISE EXCEPTION 'Allocated intent principal is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refund_allocated_intent BEFORE UPDATE ON public.refunds FOR EACH ROW EXECUTE FUNCTION public.protect_allocated_intent_amount();
CREATE TRIGGER dispute_allocated_intent BEFORE UPDATE ON public.disputes FOR EACH ROW EXECUTE FUNCTION public.protect_allocated_intent_amount();
--> statement-breakpoint
-- Conservative inventory/backfill. No refund, dispute, or settlement allocations
-- are fabricated. Legacy eligibility is unknown, not today's configured delay.
INSERT INTO public.capture_accounting_scopes (merchant_id,currency,status)
SELECT merchant_id,currency,CASE WHEN bool_or(classification='REVIEW_REQUIRED') THEN 'REVIEW_REQUIRED' ELSE 'FOUNDATION_ONLY' END
FROM public.capture_accounting_legacy_inventory GROUP BY merchant_id,currency;
INSERT INTO public.capture_accounting_scopes (merchant_id,currency,status)
SELECT DISTINCT merchant_id,currency,'REVIEW_REQUIRED' FROM public.capture_accounting_orphan_inventory
ON CONFLICT (merchant_id,currency) DO UPDATE SET status='REVIEW_REQUIRED';
INSERT INTO public.capture_accounting_lots (capture_attempt_id,payment_id,merchant_id,currency,capture_journal_id,
  original_gross,original_fee,original_net,financial_captured_at,origin)
SELECT capture_attempt_id,payment_id,merchant_id,currency,journal_id,gross::bigint,fee::bigint,net::bigint,financial_captured_at,'LEGACY_ORIGINAL_ONLY'
FROM public.capture_accounting_legacy_inventory WHERE classification='ORIGINAL_VERIFIED';
INSERT INTO public.accounting_exceptions (merchant_id,currency,payment_id,category,source_kind,evidence_key,observed_conflict)
SELECT merchant_id,currency,payment_id,'LEGACY_ALLOCATION_UNRECONCILED','LEGACY','legacy-capture:'||capture_attempt_id::text,to_jsonb(i)
FROM public.capture_accounting_legacy_inventory i WHERE classification='REVIEW_REQUIRED';
INSERT INTO public.accounting_exceptions (merchant_id,currency,category,source_kind,evidence_key,observed_conflict)
SELECT merchant_id,currency,'LEGACY_ALLOCATION_UNRECONCILED','LEGACY','legacy-journal:'||journal_id::text,to_jsonb(i)
FROM public.capture_accounting_orphan_inventory i;

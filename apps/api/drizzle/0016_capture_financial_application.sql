-- B2-B: atomic dormant first capture only. No enrollment, runtime grants or B2-C acknowledgment.
SET LOCAL lock_timeout='10s';
SET LOCAL search_path=pg_catalog,pg_temp;
-- Coordinated installation requires drained writers; a timeout/deadlock rolls the entire DDL back.
LOCK TABLE public.financial_application_roots,public.ledger_transactions,public.ledger_entries,public.ledger_accounts,
  public.capture_accounting_lots,public.payments,public.payment_attempts,public.webhook_events,public.audit_logs,
  public.financial_application_effect_links,public.financial_application_revision_effects IN SHARE ROW EXCLUSIVE MODE;

-- Normalize only SQL timestamptz columns in retained row images. All other keys,
-- JSON payloads and proof fingerprints remain byte-for-byte JSON values.
CREATE FUNCTION public.financial_image_at_utc(p_relation text,p_image jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE column_name text;
BEGIN
  IF p_image IS NULL OR p_image='null'::jsonb THEN RETURN p_image; END IF;
  IF jsonb_typeof(p_image)<>'object' OR p_relation NOT IN ('payments','payment_attempts','webhook_events','audit_logs','outbox_events',
    'provider_command_authorities','payment_operation_evidence','receipt_admission_obligations','financial_application_roots',
    'financial_application_manifests','first_capture_intent_requests','first_capture_intent_acceptances') THEN
    RAISE EXCEPTION 'Supported typed financial row image required'; END IF;
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('public.'||quote_ident(p_relation))
    AND attnum>0 AND NOT attisdropped AND atttypid='timestamptz'::regtype LOOP
    IF p_image ? column_name AND p_image->column_name<>'null'::jsonb THEN
      IF jsonb_typeof(p_image->column_name)<>'string' THEN RAISE EXCEPTION 'SQL timestamp string required'; END IF;
      p_image:=jsonb_set(p_image,ARRAY[column_name],to_jsonb((p_image->>column_name)::timestamptz));
    END IF;
  END LOOP;
  RETURN p_image;
END $$;
CREATE FUNCTION public.financial_effects_at_utc(p_effects jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE effect jsonb; result jsonb:='[]'; key text;
BEGIN
  FOR effect IN SELECT value FROM jsonb_array_elements(p_effects) LOOP
    FOREACH key IN ARRAY ARRAY['before','after'] LOOP
      IF effect ? key THEN effect:=jsonb_set(effect,ARRAY[key],public.financial_image_at_utc(effect->>'table',effect->key)); END IF;
    END LOOP;
    result:=result||jsonb_build_array(effect);
  END LOOP;
  RETURN result;
END $$;
--> statement-breakpoint

-- Reconstruct the entire required group from issued inputs, independently of effect_manifest.
CREATE FUNCTION public.capture_application_effects(m public.financial_application_manifests) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE s jsonb:=m.source_manifest; p jsonb:=s->'payment_before'; t jsonb:=s->'attempt_before';
  e public.payment_operation_evidence%ROWTYPE; ids jsonb:=s->'ids'; stamp timestamptz:=m.created_at;
  gross numeric; total numeric; product numeric; uncapped numeric; fee numeric; net numeric; x jsonb; ac jsonb;
  draft jsonb; posted jsonb; entry jsonb; effects jsonb; code text; owner uuid; typ text;
BEGIN
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE id=m.payment_operation_proof_id;
  gross:=e.capture_principal; total:=(p->>'captured_amount')::numeric+gross;
  product:=total*(s#>>'{terms,fee_bps}')::numeric;
  uncapped:=floor(product/10000)+(s#>>'{terms,fixed_fee_minor}')::numeric;
  fee:=least(total,uncapped)-(p->>'platform_fee_amount')::numeric; net:=gross-fee;
  IF gross<=0 OR total>(p->>'authorized_amount')::numeric OR (p->>'authorized_amount')::numeric>9007199254740991
    OR (s#>>'{terms,fee_bps}')::numeric NOT BETWEEN 0 AND 10000
    OR (s#>>'{terms,fixed_fee_minor}')::numeric NOT BETWEEN 0 AND 9007199254740991
    OR (s#>>'{terms,settlement_delay_days}')::integer<0 OR product NOT BETWEEN 0 AND 9007199254740991
    OR uncapped NOT BETWEEN 0 AND 9007199254740991 OR fee NOT BETWEEN 0 AND gross OR net<0
    OR s->'money' IS DISTINCT FROM jsonb_build_object('C0',(p->>'captured_amount')::bigint,'F0',(p->>'platform_fee_amount')::bigint,
      'C1',total,'F1',(p->>'platform_fee_amount')::numeric+fee,'gross',gross,'fee',fee,'net',net) THEN
    RAISE EXCEPTION 'Exact compatible SQL capture calculation required'; END IF;
  draft:=to_jsonb(jsonb_populate_record(NULL::public.ledger_transactions,jsonb_build_object('id',ids->>'journal','merchant_id',m.merchant_id,
    'business_type','CAPTURE','business_id',e.attempt_id,'currency',m.currency,'description','Capture '||e.attempt_id::text,
    'status','DRAFT','reversal_of_id',NULL,'created_at',stamp,'posted_at',NULL)));
  posted:=draft||jsonb_build_object('status','POSTED','posted_at',stamp);
  effects:=jsonb_build_array(jsonb_build_object('table','ledger_transactions','id',ids->>'journal','write','INSERT','after',draft));
  FOREACH code IN ARRAY ARRAY['PSP_CLEARING','MERCHANT_PENDING','PLATFORM_FEE_REVENUE'] LOOP
    IF (code='MERCHANT_PENDING' AND net=0) OR (code='PLATFORM_FEE_REVENUE' AND fee=0) THEN CONTINUE; END IF;
    owner:=CASE WHEN code='MERCHANT_PENDING' THEN m.merchant_id END;
    typ:=CASE code WHEN 'PSP_CLEARING' THEN 'ASSET' WHEN 'MERCHANT_PENDING' THEN 'LIABILITY' ELSE 'REVENUE' END;
    SELECT value->'row' INTO STRICT ac FROM jsonb_array_elements(s->'accounts') WHERE value#>>'{row,code}'=code;
    IF (ac->>'merchant_id',ac->>'currency',ac->>'account_type') IS DISTINCT FROM (owner::text,m.currency,typ)
      OR ids#>>ARRAY['entries',code] IS NULL THEN RAISE EXCEPTION 'Exact owned capture account and entry required'; END IF;
    entry:=to_jsonb(jsonb_populate_record(NULL::public.ledger_entries,jsonb_build_object('id',ids#>>ARRAY['entries',code],
      'transaction_id',ids->>'journal','account_id',ac->>'id','currency',m.currency,'created_at',stamp,
      'debit',CASE WHEN code='PSP_CLEARING' THEN gross ELSE 0 END,
      'credit',CASE code WHEN 'MERCHANT_PENDING' THEN net WHEN 'PLATFORM_FEE_REVENUE' THEN fee ELSE 0 END)));
    effects:=effects||jsonb_build_array(
      jsonb_build_object('table','ledger_transactions','id',ids->>'journal','write','UPDATE','before',draft,'after',draft),
      jsonb_build_object('table','ledger_entries','id',entry->>'id','write','INSERT','after',entry));
  END LOOP;
  effects:=effects||jsonb_build_array(
    jsonb_build_object('table','ledger_transactions','id',ids->>'journal','write','UPDATE','before',draft,'after',posted),
    jsonb_build_object('table','payment_attempts','id',e.attempt_id,'write','UPDATE','before',t,'after',t||jsonb_build_object(
      'status','SUCCEEDED','provider_transaction_id',e.payment_intent_id,'failure_code',NULL,'updated_at',stamp)),
    jsonb_build_object('table','payments','id',m.payment_id,'write','UPDATE','before',p,'after',p||jsonb_build_object('status','CAPTURED',
      'captured_amount',total,'platform_fee_amount',(p->>'platform_fee_amount')::numeric+fee,'version',(p->>'version')::integer+1,
      'captured_at',coalesce((p->>'captured_at')::timestamptz,stamp),'updated_at',stamp)),
    jsonb_build_object('table','capture_accounting_lots','id',ids->>'lot','write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.capture_accounting_lots,
      jsonb_build_object('id',ids->>'lot','capture_attempt_id',e.attempt_id,'payment_id',m.payment_id,'merchant_id',m.merchant_id,'currency',m.currency,
        'capture_journal_id',ids->>'journal','original_gross',gross,'original_fee',fee,'original_net',net,'financial_captured_at',stamp,
        'eligible_at',stamp+(s#>>'{terms,settlement_delay_days}')::integer*interval '24 hours','origin','NEW_CAPTURE','policy_version','CAPTURE_FIFO_V1',
        'allocation_revision',0,'settlement_state','UNSETTLED','finalized_settlement_item_id',NULL,'created_at',stamp)))),
    jsonb_build_object('table','audit_logs','id',ids->>'audit','write','INSERT','after',to_jsonb(jsonb_populate_record(NULL::public.audit_logs,
      jsonb_build_object('id',ids->>'audit','merchant_id',m.merchant_id,'actor_type','PROVIDER','actor_id',e.payment_intent_id,
        'action','payment.capture_succeeded','target_type','payment','target_id',m.payment_id::text,'correlation_id',NULL,'created_at',stamp,
        'metadata',jsonb_build_object('attemptId',e.attempt_id,'outboxId',e.outbox_id,'proofId',e.id,'rootId',m.root_id,
          'journalId',ids->>'journal','lotId',ids->>'lot','gross',gross,'fee',fee,'net',net))))),
    jsonb_build_object('table','webhook_events','id',m.inbox_id,'write','UPDATE','before',s->'inbox_before','after',(s->'inbox_before')||
      jsonb_build_object('status','PROCESSED','processed_at',stamp,'locked_at',NULL,'updated_at',stamp)));
  RETURN effects;
END $$;

CREATE FUNCTION public.capture_application_completion(m public.financial_application_manifests) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE s jsonb:=m.source_manifest; result jsonb; x jsonb; row_image jsonb; journal boolean; identity uuid;
BEGIN
  result:=jsonb_build_array(jsonb_build_object('table','financial_applications','id',m.root_id,'after',
    to_jsonb(jsonb_populate_record(NULL::public.financial_applications,jsonb_build_object('root_id',m.root_id,'manifest_id',m.id,
      'result','POSTED','audit_id',s->>'audit_id','created_at',m.created_at)))));
  row_image:=to_jsonb(jsonb_populate_record(NULL::public.financial_application_dispositions,jsonb_build_object('id',s->>'receipt_disposition_id',
    'root_id',m.root_id,'inbox_id',m.inbox_id,'obligation_revision',s#>>'{obligation,obligation_revision}','disposition','APPLIED','created_at',m.created_at)));
  result:=result||jsonb_build_array(jsonb_build_object('table','financial_application_dispositions','id',row_image->>'id','after',row_image));
  FOR x IN SELECT value FROM jsonb_array_elements(s->'source_dispositions') LOOP
    row_image:=to_jsonb(jsonb_populate_record(NULL::public.financial_application_dispositions,jsonb_build_object('id',x->>'id','root_id',m.root_id,
      'observation_source_id',x->>'source_id','disposition','APPLIED','created_at',m.created_at)));
    result:=result||jsonb_build_array(jsonb_build_object('table','financial_application_dispositions','id',row_image->>'id','after',row_image));
  END LOOP;
  FOREACH journal IN ARRAY ARRAY[true,false] LOOP
    identity:=(s#>>ARRAY['ids',CASE WHEN journal THEN 'journal' ELSE 'lot' END])::uuid;
    row_image:=to_jsonb(jsonb_populate_record(NULL::public.financial_application_effect_links,jsonb_build_object('manifest_id',m.id,'root_id',m.root_id,
      'relation_name',CASE WHEN journal THEN 'ledger_transactions' ELSE 'capture_accounting_lots' END,'effect_id',identity,
      'merchant_id',m.merchant_id,'currency',m.currency,'payment_id',m.payment_id,
      CASE WHEN journal THEN 'journal_id' ELSE 'lot_id' END,identity)));
    result:=result||jsonb_build_array(jsonb_build_object('table','financial_application_effect_links','id',identity,'after',row_image));
  END LOOP;
  RETURN result||jsonb_build_array(jsonb_build_object('table','financial_application_revision_effects','id',m.id,'after',jsonb_build_object(
    'manifest_id',m.id,'root_id',m.root_id,'prior_revision',m.scope_revision,'final_revision',m.scope_revision+1)));
END $$;

CREATE FUNCTION public.materialize_capture_application(m public.financial_application_manifests) RETURNS public.financial_application_manifests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE ac public.ledger_accounts%ROWTYPE; account_code text; owner uuid; typ text; created boolean;
  accounts jsonb:='[]'; entries jsonb:='{}'; dispositions jsonb:='[]'; x jsonb;
BEGIN
  -- The order matches the actual legacy capture writer, including cold shared accounts.
  FOREACH account_code IN ARRAY ARRAY['PSP_CLEARING','MERCHANT_PENDING','PLATFORM_FEE_REVENUE'] LOOP
    IF (account_code='MERCHANT_PENDING' AND (m.source_manifest#>>'{money,net}')::numeric=0)
      OR (account_code='PLATFORM_FEE_REVENUE' AND (m.source_manifest#>>'{money,fee}')::numeric=0) THEN CONTINUE; END IF;
    owner:=CASE WHEN account_code='MERCHANT_PENDING' THEN m.merchant_id END;
    typ:=CASE account_code WHEN 'PSP_CLEARING' THEN 'ASSET' WHEN 'MERCHANT_PENDING' THEN 'LIABILITY' ELSE 'REVENUE' END;
    INSERT INTO public.ledger_accounts(id,merchant_id,code,account_type,currency,name,created_at)
      VALUES(gen_random_uuid(),owner,account_code,typ::public.ledger_account_type,m.currency,replace(account_code,'_',' '),m.created_at) ON CONFLICT DO NOTHING RETURNING * INTO ac;
    created:=FOUND;
    SELECT a.* INTO STRICT ac FROM public.ledger_accounts a WHERE a.merchant_id IS NOT DISTINCT FROM owner AND a.code=account_code AND a.currency=m.currency FOR SHARE;
    IF ac.account_type::text IS DISTINCT FROM typ THEN RAISE EXCEPTION 'Capture account type mismatch'; END IF;
    accounts:=accounts||jsonb_build_array(jsonb_build_object('row',to_jsonb(ac),'created',created));
    entries:=entries||jsonb_build_object(account_code,gen_random_uuid());
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(m.source_manifest#>'{inventory,sources}') LOOP
    dispositions:=dispositions||jsonb_build_array(jsonb_build_object('source_id',x#>>'{obligation,source_id}','id',gen_random_uuid()));
  END LOOP;
  m.source_manifest:=m.source_manifest||jsonb_build_object('contract','CAPTURE_APPLICATION_V1','executable',true,'accounts',accounts,
    'ids',jsonb_build_object('journal',m.effect_manifest#>>'{0,id}','lot',m.effect_manifest#>>'{1,id}','audit',m.effect_manifest#>>'{4,id}','entries',entries),
    'applied_at',m.created_at,'audit_id',m.effect_manifest#>>'{4,id}','receipt_disposition_id',gen_random_uuid(),'source_dispositions',dispositions);
  m.effect_manifest:=public.capture_application_effects(m);
  m.source_manifest:=m.source_manifest||jsonb_build_object('completion',public.capture_application_completion(m));
  RETURN m;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.current_capture_application_manifest(p_manifest uuid) RETURNS public.financial_application_manifests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; i public.capture_preparation_issuances%ROWTYPE;
BEGIN
  SELECT v.* INTO STRICT m FROM public.financial_application_permits p JOIN public.financial_application_manifests v ON v.id=p.manifest_id
    WHERE v.id=p_manifest AND p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.database_principal=session_user
      AND p.permit_kind='APPLICATION' AND p.intent_manifest_id IS NULL;
  SELECT * INTO STRICT i FROM public.capture_preparation_issuances WHERE manifest_id=m.id AND transaction_id=pg_current_xact_id()
    AND backend_pid=pg_backend_pid() AND database_principal=session_user;
  IF m.source_manifest->>'contract' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1' OR m.source_manifest->'executable' IS DISTINCT FROM 'true'::jsonb
    OR i.manifest_image IS DISTINCT FROM to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id']
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.id=m.root_id AND to_jsonb(r)=i.root_image AND r.family='CAPTURE')
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority a WHERE (a.merchant_id,a.currency)=(m.merchant_id,m.currency)
      AND (a.provider,a.provider_account,a.policy,a.epoch,a.admission_mode)=(m.source_manifest#>>'{root,provider}',m.source_manifest#>>'{root,provider_account}','LEGACY',0,'DORMANT'))
    OR NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes a WHERE (a.merchant_id,a.currency)=(m.merchant_id,m.currency)
      AND a.evidence_revision=coalesce((SELECT final_revision FROM public.financial_application_revision_effects WHERE manifest_id=m.id),m.scope_revision))
    OR m.intake_revision IS DISTINCT FROM coalesce((SELECT evidence_revision FROM public.receipt_intake_authority
      WHERE provider=m.source_manifest#>>'{root,provider}' AND provider_account=m.source_manifest#>>'{root,provider_account}'),0)
    OR NOT EXISTS(SELECT 1 FROM public.webhook_events w WHERE w.id=m.inbox_id AND w.attempts=m.claim_generation
      AND w.status IN ('PROCESSING','PROCESSED') AND (to_jsonb(w)=m.source_manifest->'inbox_before'
        OR to_jsonb(w)=(SELECT value->'after' FROM jsonb_array_elements(m.effect_manifest) WHERE value->>'table'='webhook_events'))) THEN
    RAISE EXCEPTION 'Current exact SQL-issued capture permit, authority and claim required'; END IF;
  RETURN m;
END $$;

CREATE FUNCTION public.check_capture_application(p_manifest uuid,p_final boolean,p_committed boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; r public.financial_application_roots%ROWTYPE; e public.payment_operation_evidence%ROWTYPE;
  peer public.payment_operation_evidence%ROWTYPE; command_row public.provider_command_authorities%ROWTYPE; i public.capture_preparation_issuances%ROWTYPE;
  src jsonb; expected jsonb; completion jsonb; x jsonb; actual jsonb; rev public.financial_application_revision_effects%ROWTYPE;
  o public.receipt_admission_obligations%ROWTYPE; po public.provider_observation_obligations%ROWTYPE; n integer;
BEGIN
  SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=p_manifest;
  SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  SELECT * INTO STRICT i FROM public.capture_preparation_issuances WHERE manifest_id=m.id;
  SELECT * INTO STRICT e FROM public.payment_operation_evidence WHERE id=m.payment_operation_proof_id;
  SELECT * INTO STRICT command_row FROM public.provider_command_authorities WHERE outbox_id=e.outbox_id;
  src:=m.source_manifest;
  IF NOT p_committed AND (public.current_capture_application_manifest(m.id)).id IS DISTINCT FROM m.id THEN RAISE EXCEPTION 'Current capture permit required'; END IF;
  IF (m.proof_kind,m.proof_revision,m.proof_operation,m.contract_version,m.result,m.inbox_id,m.payment_id,m.merchant_id,m.currency,m.policy,m.epoch)
      IS DISTINCT FROM ('PAYMENT_OPERATION_V1',1,'payment.capture_succeeded',1,'POSTED',e.inbox_id,e.payment_id,e.merchant_id,e.currency,'LEGACY',0::bigint)
    OR (r.family,r.phase,r.operation_id,r.attempt_id,r.payment_id,r.merchant_id,r.currency,r.provider,r.provider_account,r.accepted_outbox_id,r.policy,r.acceptance_epoch)
      IS DISTINCT FROM ('CAPTURE','TERMINAL',e.attempt_id,e.attempt_id,e.payment_id,e.merchant_id,e.currency,'STRIPE',e.provider_account,e.outbox_id,'LEGACY',0::bigint)
    OR e.provider<>'STRIPE' OR e.provider_mode<>'TEST' OR e.outcome<>'CAPTURE_SUCCEEDED'
    OR src->>'contract' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1' OR src->'executable' IS DISTINCT FROM 'true'::jsonb
    OR src->'proof' IS DISTINCT FROM to_jsonb(e) OR src->'command' IS DISTINCT FROM to_jsonb(command_row) OR src->'root' IS DISTINCT FROM to_jsonb(r)
    OR src->>'audit_id' IS DISTINCT FROM src#>>'{ids,audit}' OR (src->>'applied_at')::timestamptz IS DISTINCT FROM m.created_at
    OR r.created_at IS DISTINCT FROM m.created_at OR i.root_image IS DISTINCT FROM to_jsonb(r)
    OR i.manifest_image IS DISTINCT FROM to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id']
    OR (i.transaction_id,i.backend_pid,i.database_principal::text) IS DISTINCT FROM (m.transaction_id,m.backend_pid,src->>'database_principal')
    OR i.intent_manifest_id::text IS DISTINCT FROM src#>>'{intent,id}'
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_permits p WHERE p.manifest_id=m.id AND p.permit_kind='APPLICATION' AND p.intent_manifest_id IS NULL
      AND (p.transaction_id,p.backend_pid,p.database_principal)=(i.transaction_id,i.backend_pid,i.database_principal))
    OR NOT EXISTS(SELECT 1 FROM public.first_capture_intent_manifests c WHERE c.id=i.intent_manifest_id AND to_jsonb(c)=src->'intent'
      AND (c.attempt_id,c.outbox_id,c.payment_id,c.merchant_id,c.currency,c.provider,c.provider_account,c.provider_mode,c.policy,c.epoch)
        =(e.attempt_id,e.outbox_id,e.payment_id,e.merchant_id,e.currency,e.provider,e.provider_account,'TEST','LEGACY',0)
      AND c.amount=e.capture_principal AND (c.variant<>'FIRST_PARTIAL')=(e.facts->>'final_capture')::boolean
      AND public.check_first_capture_intent(c.id,true,true))
    OR NOT EXISTS(SELECT 1 FROM public.financial_application_contracts WHERE family='CAPTURE' AND phase='TERMINAL' AND policy='LEGACY' AND version=1
      AND prepare_function='public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure
      AND validate_function='public.validate_capture_preparation(uuid)'::regprocedure)
    OR NOT EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c WHERE c.inbox_id=m.inbox_id AND c.operation='CLAIM'
      AND public.financial_image_at_utc('webhook_events',c.after_image)=src->'inbox_before' AND c.database_principal=i.database_principal)
    OR (src#>>'{inbox_before,status}',(src#>>'{inbox_before,attempts}')::integer) IS DISTINCT FROM ('PROCESSING',m.claim_generation)
    OR public.financial_image_at_utc('payments',src->'payment_before') IS DISTINCT FROM public.financial_image_at_utc('payments',src#>'{intent,effect_manifest,0,after}')
    OR public.financial_image_at_utc('payment_attempts',src->'attempt_before') IS DISTINCT FROM public.financial_image_at_utc('payment_attempts',src#>'{intent,effect_manifest,1,after}') THEN
    RAISE EXCEPTION 'Complete original capture authority, proof, intent and issuance required'; END IF;
  -- Current completion uses the same effective B1 reader. Admission recognition reads immutable provenance only.
  IF NOT p_committed AND public.load_effective_payment_operation_evidence(e.inbox_id,1,e.operation) IS DISTINCT FROM e THEN
    RAISE EXCEPTION 'Exact effective capture proof required'; END IF;
  IF e.fingerprint IS DISTINCT FROM sha256(convert_to(e.facts::text,'UTF8'))
    OR public.checked_payment_command_source(e.source_id) IS DISTINCT FROM e.facts->'source'
    OR public.checked_payment_command_source(e.authorization_source_id) IS DISTINCT FROM e.facts->'authorization' THEN
    RAISE EXCEPTION 'Original immutable capture provenance mismatch'; END IF;
  SELECT * INTO STRICT o FROM public.receipt_admission_obligations WHERE inbox_id=m.inbox_id;
  IF (NOT p_committed AND to_jsonb(o) IS DISTINCT FROM src->'obligation') OR src->'obligation' IS DISTINCT FROM
    (SELECT value->'obligation' FROM jsonb_array_elements(src#>'{inventory,receipts}') WHERE value#>>'{obligation,inbox_id}'=m.inbox_id::text)
    OR (src#>>'{obligation,disposition}',src#>>'{obligation,payment_operation_proof_id}') IS DISTINCT FROM ('AWAITING_APPLICATION',e.id::text) THEN
    RAISE EXCEPTION 'Exact applying receipt revision required'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(src#>'{inventory,receipts}') LOOP
    SELECT * INTO STRICT peer FROM public.payment_operation_evidence WHERE id=(x->>'proof_id')::uuid;
    IF x->>'fingerprint' IS DISTINCT FROM encode(peer.fingerprint,'hex') OR
      (peer.outbox_id,peer.attempt_id,peer.provider,peer.provider_account,peer.provider_mode,peer.payment_id,peer.merchant_id,peer.currency,
        peer.payment_intent_id,peer.charge_id,peer.capture_principal,peer.outcome,peer.authorization_source_id,peer.accounting_policy,peer.acceptance_epoch,peer.facts->'final_capture')
      IS DISTINCT FROM (e.outbox_id,e.attempt_id,e.provider,e.provider_account,e.provider_mode,e.payment_id,e.merchant_id,e.currency,
        e.payment_intent_id,e.charge_id,e.capture_principal,e.outcome,e.authorization_source_id,e.accounting_policy,e.acceptance_epoch,e.facts->'final_capture') THEN
      RAISE EXCEPTION 'Capture receipt coverage is not independently equivalent'; END IF;
    IF NOT p_committed AND NOT EXISTS(SELECT 1 FROM public.receipt_admission_obligations b WHERE b.inbox_id=peer.inbox_id AND to_jsonb(b)=x->'obligation') THEN
      RAISE EXCEPTION 'Covered capture receipt changed'; END IF;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(src#>'{inventory,sources}') LOOP
    SELECT * INTO STRICT po FROM public.provider_observation_obligations WHERE source_id=(x#>>'{obligation,source_id}')::uuid;
    IF (po.provider,po.provider_account,po.merchant_id,po.currency,po.disposition,po.reason) IS DISTINCT FROM
      (e.provider,e.provider_account,e.merchant_id,e.currency,'BLOCKING_REVIEW','CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED')
      OR to_jsonb(po) IS DISTINCT FROM (x->'obligation')-ARRAY['outbox_id','source_kind']
      OR x#>>'{obligation,outbox_id}' IS DISTINCT FROM e.outbox_id::text OR x#>>'{obligation,source_kind}' IS DISTINCT FROM 'COMMAND_RESULT'
      OR public.checked_payment_command_source(po.source_id) IS DISTINCT FROM x->'source'
      OR x#>'{source,object}' IS DISTINCT FROM e.facts#>'{source,object}' THEN RAISE EXCEPTION 'Unproven capture source coverage'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(src#>'{inventory,sources}') WHERE value#>>'{obligation,source_id}'=e.source_id::text)
    OR (SELECT count(*) FROM jsonb_array_elements(src->'source_dispositions'))<>(SELECT count(*) FROM jsonb_array_elements(src#>'{inventory,sources}'))
    OR EXISTS((SELECT value#>>'{obligation,source_id}' FROM jsonb_array_elements(src#>'{inventory,sources}')) EXCEPT
      (SELECT value->>'source_id' FROM jsonb_array_elements(src->'source_dispositions'))) THEN RAISE EXCEPTION 'Complete exact capture source set required'; END IF;
  expected:=public.capture_application_effects(m); completion:=public.capture_application_completion(m);
  IF m.effect_manifest IS DISTINCT FROM expected OR src->'completion' IS DISTINCT FROM completion THEN
    RAISE EXCEPTION 'Missing whole capture group or altered executable plan'; END IF;
  n:=1+CASE WHEN (src#>>'{money,net}')::numeric>0 THEN 1 ELSE 0 END+CASE WHEN (src#>>'{money,fee}')::numeric>0 THEN 1 ELSE 0 END;
  IF jsonb_array_length(src->'accounts')<>n OR (SELECT count(*) FROM jsonb_object_keys(src#>'{ids,entries}'))<>n
    OR (SELECT count(*) FROM public.ledger_entries WHERE transaction_id=(src#>>'{ids,journal}')::uuid)<>n
    OR (SELECT count(*) FROM public.capture_accounting_lots WHERE capture_attempt_id=e.attempt_id)<>1
    OR (SELECT count(*) FROM public.ledger_transactions WHERE business_id=e.attempt_id)<>1
    OR (SELECT count(*) FROM public.financial_application_roots WHERE family='CAPTURE' AND operation_id=e.attempt_id)<>1
    OR (SELECT count(*) FROM public.audit_logs l WHERE l.action='payment.capture_succeeded' AND EXISTS(
      SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',to_jsonb(l)) own WHERE own.payment_id=e.payment_id))<>1 THEN
    RAISE EXCEPTION 'Exact complete capture journal, entries, lot, root and audit required'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(src->'accounts') LOOP
    SELECT to_jsonb(ac) INTO STRICT actual FROM public.ledger_accounts ac WHERE id=(x#>>'{row,id}')::uuid;
    IF actual-ARRAY['name','created_at'] IS DISTINCT FROM (x->'row')-ARRAY['name','created_at'] THEN RAISE EXCEPTION 'Capture financial account identity changed'; END IF;
  END LOOP;
  FOR x IN SELECT DISTINCT ON(value->>'table',value->>'id') value FROM jsonb_array_elements(expected) WITH ORDINALITY v(value,effect_order)
    ORDER BY value->>'table',value->>'id',v.effect_order DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',x->>'table') INTO actual USING (x->>'id')::uuid;
    IF p_committed AND x->>'table'='payments' THEN
      IF actual->>'merchant_id' IS DISTINCT FROM m.merchant_id::text OR actual->>'currency' IS DISTINCT FROM m.currency THEN RAISE EXCEPTION 'Capture payment owner changed'; END IF;
    ELSIF p_committed AND x->>'table'='capture_accounting_lots' THEN
      IF actual-ARRAY['allocation_revision','settlement_state','finalized_settlement_item_id'] IS DISTINCT FROM (x->'after')-ARRAY['allocation_revision','settlement_state','finalized_settlement_item_id'] THEN
        RAISE EXCEPTION 'Original capture lot evidence changed'; END IF;
    ELSIF actual IS DISTINCT FROM x->'after' THEN RAISE EXCEPTION 'Missing or mismatched complete capture effect: %',x->>'table'; END IF;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(completion) LOOP
    IF x->>'table'='financial_application_revision_effects' AND NOT p_final THEN CONTINUE; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE %I=$1',x->>'table',CASE x->>'table' WHEN 'financial_applications' THEN 'root_id'
      WHEN 'financial_application_revision_effects' THEN 'manifest_id' WHEN 'financial_application_effect_links' THEN 'effect_id' ELSE 'id' END)
      INTO actual USING (x->>'id')::uuid;
    IF actual IS DISTINCT FROM x->'after' THEN RAISE EXCEPTION 'Missing complete capture finality group: %',x->>'table'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.financial_application_effect_links WHERE root_id=m.root_id)<>2
    OR (SELECT count(*) FROM public.financial_application_dispositions WHERE root_id=m.root_id)<>1+jsonb_array_length(src->'source_dispositions') THEN
    RAISE EXCEPTION 'Unexpected capture effect links or source dispositions'; END IF;
  IF p_final THEN
    SELECT * INTO STRICT rev FROM public.financial_application_revision_effects WHERE manifest_id=m.id;
    IF NOT EXISTS(SELECT 1 FROM public.capture_accounting_scopes a WHERE (a.merchant_id,a.currency)=(m.merchant_id,m.currency)
      AND CASE WHEN p_committed THEN a.evidence_revision>=rev.final_revision ELSE a.evidence_revision=rev.final_revision END) THEN
      RAISE EXCEPTION 'Capture requires exactly one guarded financial revision'; END IF;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.validate_capture_preparation(p_manifest uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.check_capture_application(p_manifest,true,false) $$;

-- Admission recognizes original immutable completion; it grants no acknowledgment/replay action.
CREATE FUNCTION public.capture_application_cause_cleared(p_inbox uuid,p_revision bigint,p_source uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d record;
BEGIN
  IF num_nonnulls(p_inbox,p_source)<>1 OR (p_inbox IS NOT NULL AND p_revision IS NULL) THEN RETURN false; END IF;
  FOR d IN SELECT m.id FROM public.financial_application_dispositions x JOIN public.financial_applications a ON a.root_id=x.root_id
    JOIN public.financial_application_roots r ON r.id=a.root_id JOIN public.financial_application_manifests m ON m.id=a.manifest_id
    WHERE r.family='CAPTURE' AND x.disposition='APPLIED' AND ((p_inbox IS NOT NULL AND x.inbox_id=p_inbox AND x.obligation_revision=p_revision AND m.inbox_id=p_inbox)
      OR (p_source IS NOT NULL AND x.observation_source_id=p_source)) LOOP
    IF public.check_capture_application(d.id,true,true) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
EXCEPTION WHEN no_data_found OR raise_exception OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.complete_capture_application() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; x jsonb; w jsonb;
BEGIN
  m:=public.current_financial_application_manifest();
  IF m.source_manifest->>'contract' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1' THEN RAISE EXCEPTION 'Exact executable capture required'; END IF;
  SELECT value->'after' INTO STRICT w FROM jsonb_array_elements(m.effect_manifest) WHERE value->>'table'='webhook_events';
  UPDATE public.webhook_events SET status='PROCESSED',processed_at=(w->>'processed_at')::timestamptz,locked_at=NULL,updated_at=(w->>'updated_at')::timestamptz
    WHERE id=m.inbox_id AND status='PROCESSING' AND attempts=m.claim_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capture claim finality compare-and-set failed'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(m.source_manifest->'completion') LOOP
    IF x->>'table'='financial_application_revision_effects' THEN CONTINUE; END IF;
    EXECUTE format('INSERT INTO public.%I SELECT (jsonb_populate_record(NULL::public.%I,$1)).*',x->>'table',x->>'table') USING x->'after';
  END LOOP;
  PERFORM public.advance_financial_application_revision();
  PERFORM public.validate_capture_preparation(m.id);
  -- F02 stays SECURITY INVOKER: flush its reads before returning to the EXECUTE-only caller.
  SET CONSTRAINTS public.ledger_entries_balance_check,public.ledger_transactions_balance_check IMMEDIATE;
  RETURN m.root_id;
END $$;

CREATE FUNCTION public.apply_capture_application() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; x jsonb; a jsonb; b jsonb;
BEGIN
  m:=public.current_financial_application_manifest();
  IF m.source_manifest->>'contract' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1'
    OR m.effect_manifest IS DISTINCT FROM public.capture_application_effects(m) THEN RAISE EXCEPTION 'Executable SQL capture plan required'; END IF;
  -- Preparation-only reading refuses any prior finalization or stale source image.
  PERFORM public.read_capture_preparation();
  FOR x IN SELECT value FROM jsonb_array_elements(m.effect_manifest) LOOP
    a:=x->'after'; b:=x->'before';
    IF x->>'table'='webhook_events' OR (x->>'write'='UPDATE' AND a=b) THEN CONTINUE; END IF;
    IF x->>'write'='INSERT' THEN
      EXECUTE format('INSERT INTO public.%I SELECT (jsonb_populate_record(NULL::public.%I,$1)).*',x->>'table',x->>'table') USING a;
    ELSIF x->>'table'='ledger_transactions' THEN
      UPDATE public.ledger_transactions SET status='POSTED',posted_at=(a->>'posted_at')::timestamptz WHERE id=(x->>'id')::uuid;
    ELSIF x->>'table'='payment_attempts' THEN
      UPDATE public.payment_attempts SET status='SUCCEEDED',provider_transaction_id=a->>'provider_transaction_id',failure_code=NULL,updated_at=(a->>'updated_at')::timestamptz
        WHERE id=(x->>'id')::uuid;
    ELSIF x->>'table'='payments' THEN
      UPDATE public.payments SET status='CAPTURED',captured_amount=(a->>'captured_amount')::bigint,platform_fee_amount=(a->>'platform_fee_amount')::bigint,
        captured_at=(a->>'captured_at')::timestamptz,version=(a->>'version')::integer,updated_at=(a->>'updated_at')::timestamptz WHERE id=(x->>'id')::uuid;
    ELSE RAISE EXCEPTION 'Unsupported capture write'; END IF;
  END LOOP;
  RETURN public.complete_financial_application();
END $$;

CREATE OR REPLACE FUNCTION public.check_capture_preparation_record(p_relation text,n jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE r public.financial_application_roots%ROWTYPE; m public.financial_application_manifests%ROWTYPE; i public.capture_preparation_issuances%ROWTYPE;
BEGIN
  IF p_relation='financial_application_roots' THEN r:=jsonb_populate_record(NULL::public.financial_application_roots,n);
  ELSIF p_relation='financial_application_permits' THEN
    IF n->>'permit_kind'<>'APPLICATION' THEN RETURN false; END IF;
    SELECT * INTO STRICT m FROM public.financial_application_manifests WHERE id=(n->>'manifest_id')::uuid;
    SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=m.root_id;
  ELSE SELECT * INTO STRICT r FROM public.financial_application_roots WHERE id=(n->>'root_id')::uuid; END IF;
  IF r.family<>'CAPTURE' OR NOT EXISTS(SELECT 1 FROM public.financial_application_scope_authority WHERE merchant_id=r.merchant_id AND currency=r.currency) THEN RETURN false; END IF;
  SELECT * INTO i FROM public.capture_preparation_issuances WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
    AND database_principal=session_user AND root_id=r.id;
  -- Preserve P-B's installed refusal when no protected capture issuance exists.
  IF NOT FOUND THEN RETURN false; END IF;
  IF i.root_image IS DISTINCT FROM to_jsonb(r) OR i.manifest_image#>>'{source_manifest,contract}' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1' THEN
    RAISE EXCEPTION 'Exact issued executable capture root required'; END IF;
  IF p_relation='financial_application_manifests' AND n-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM i.manifest_image THEN
    RAISE EXCEPTION 'Exact issued capture manifest required'; END IF;
  IF p_relation='financial_application_permits' AND ((n->>'manifest_id')::uuid IS DISTINCT FROM i.manifest_id
    OR (n->>'transaction_id')::xid8 IS DISTINCT FROM i.transaction_id OR (n->>'backend_pid')::integer IS DISTINCT FROM i.backend_pid
    OR n->>'database_principal' IS DISTINCT FROM i.database_principal::text OR n->>'permit_kind' IS DISTINCT FROM 'APPLICATION'
    OR n->>'intent_manifest_id' IS NOT NULL OR to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'] IS DISTINCT FROM i.manifest_image) THEN
    RAISE EXCEPTION 'Exact issued capture permit required'; END IF;
  IF p_relation='financial_application_revision_effects' THEN
    m:=public.current_financial_application_manifest();
    IF m.id<>i.manifest_id OR n IS DISTINCT FROM (SELECT value->'after' FROM jsonb_array_elements(m.source_manifest->'completion')
      WHERE value->>'table'='financial_application_revision_effects') THEN RAISE EXCEPTION 'Exact guarded capture revision required'; END IF;
  ELSIF p_relation NOT IN ('financial_application_roots','financial_application_manifests','financial_application_permits') THEN
    RAISE EXCEPTION 'Unsupported capture authority record'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.capture_application_record_protected(p_relation text,n jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF n IS NULL THEN RETURN false; END IF;
  IF p_relation='webhook_events' THEN
    RETURN EXISTS(SELECT 1 FROM public.payment_operation_evidence e JOIN public.financial_application_scope_authority s USING(merchant_id,currency)
      WHERE e.inbox_id=(n->>'id')::uuid AND e.operation='payment.capture_succeeded'
        AND (n->>'status'='PROCESSED' OR EXISTS(SELECT 1 FROM public.first_capture_intent_manifests c
          WHERE c.payment_id=e.payment_id AND c.attempt_id=e.attempt_id)));
  ELSIF p_relation='financial_application_effect_links' THEN
    RETURN EXISTS(SELECT 1 FROM public.financial_application_roots r JOIN public.financial_application_scope_authority s USING(merchant_id,currency)
      WHERE r.id=(n->>'root_id')::uuid AND r.family='CAPTURE')
      OR EXISTS(SELECT 1 FROM public.ledger_transactions j CROSS JOIN LATERAL public.financial_application_effect_owners('ledger_transactions',to_jsonb(j)) own
        JOIN public.financial_application_scope_authority s ON (s.merchant_id,s.currency)=(own.merchant_id,own.currency)
        WHERE j.id=(n->>'journal_id')::uuid AND j.business_type='CAPTURE');
  END IF;
  RETURN EXISTS(SELECT 1 FROM public.first_capture_intent_record_owners('audit_logs',n) own JOIN public.financial_application_scope_authority s
    ON s.merchant_id=own.merchant_id AND (own.currency IS NULL OR s.currency=own.currency) WHERE n->>'action'='payment.capture_succeeded')
    OR EXISTS(SELECT 1 FROM public.payment_operation_evidence e JOIN public.financial_application_scope_authority s USING(merchant_id,currency)
      WHERE e.operation='payment.capture_succeeded' AND e.id=CASE WHEN pg_input_is_valid(n#>>'{metadata,proofId}','uuid') THEN (n#>>'{metadata,proofId}')::uuid END)
    OR EXISTS(SELECT 1 FROM public.financial_application_roots r JOIN public.financial_application_scope_authority s USING(merchant_id,currency)
      WHERE r.family='CAPTURE' AND r.id=CASE WHEN pg_input_is_valid(n#>>'{metadata,rootId}','uuid') THEN (n#>>'{metadata,rootId}')::uuid END);
END $$;

CREATE FUNCTION public.check_capture_effect_finality(p_relation text,p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE m public.financial_application_manifests%ROWTYPE; actual jsonb;
BEGIN
  m:=public.current_financial_application_manifest();
  IF p_relation NOT IN ('payments','payment_attempts','refunds','disputes','payouts','settlements','settlement_items',
    'capture_accounting_lots','refund_capture_allocations','dispute_capture_allocations','dispute_hold_effects','ledger_transactions','ledger_entries') THEN
    RAISE EXCEPTION 'Unsupported capture effect relation'; END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',p_relation) INTO actual USING p_id;
  IF actual IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=p_relation AND x->>'id'=p_id::text AND x->'after'=actual) THEN
    RAISE EXCEPTION 'Protected final capture effect requires exact manifest'; END IF;
  PERFORM public.check_capture_application(m.id,true,false);
END $$;

CREATE OR REPLACE FUNCTION public.guard_capture_preparation_write() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE n jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END; o jsonb; m public.financial_application_manifests%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  IF NOT (public.capture_application_record_protected(TG_TABLE_NAME,n) OR public.capture_application_record_protected(TG_TABLE_NAME,o)) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  IF TG_TABLE_NAME='webhook_events' THEN
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.manual_authorization_claim_writes c WHERE c.transaction_id=pg_current_xact_id()
    AND c.backend_pid=pg_backend_pid() AND c.database_principal=session_user AND c.inbox_id=NEW.id AND c.operation='CLAIM'
    AND public.financial_image_at_utc('webhook_events',c.before_image)=o AND public.financial_image_at_utc('webhook_events',c.after_image)=n)
    AND n-ARRAY['status','attempts','locked_at','updated_at']=o-ARRAY['status','attempts','locked_at','updated_at']
    AND NEW.status='PROCESSING' AND NEW.attempts=OLD.attempts+1 AND OLD.attempts<8 AND OLD.available_at<=now()
    AND (OLD.status IN ('PENDING','RETRY') OR (OLD.status='PROCESSING' AND OLD.locked_at<now()-interval '2 minutes'))
    AND NEW.locked_at=now() AND NEW.updated_at=now() THEN RETURN NEW; END IF;
  END IF;
  m:=public.current_financial_application_manifest();
  IF TG_OP='DELETE' OR m.source_manifest->>'contract' IS DISTINCT FROM 'CAPTURE_APPLICATION_V1' THEN RAISE EXCEPTION 'Exact capture final write required'; END IF;
  IF TG_TABLE_NAME='financial_application_effect_links' THEN
    IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.source_manifest->'completion') x WHERE x->>'table'=TG_TABLE_NAME AND x->'after'=n) THEN
      RAISE EXCEPTION 'Exact capture effect link required'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.effect_manifest) x WHERE x->>'table'=TG_TABLE_NAME AND x->>'id'=n->>'id'
    AND x->>'write'=TG_OP AND x->'after'=n AND (TG_OP='INSERT' OR x->'before'=o)) THEN RAISE EXCEPTION 'Exact owned SQL capture final write required'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.reject_capture_preparation_commit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE root uuid; manifest uuid; n jsonb:=to_jsonb(NEW); o jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='capture_preparation_issuances' THEN manifest:=NEW.manifest_id; root:=NEW.root_id;
  ELSIF TG_TABLE_NAME='financial_application_roots' THEN root:=NEW.id;
  ELSIF TG_TABLE_NAME IN ('financial_application_manifests','financial_application_revision_effects','financial_application_effect_links') THEN root:=NEW.root_id;
  ELSIF TG_TABLE_NAME='financial_application_permits' THEN
    IF NEW.permit_kind<>'APPLICATION' THEN RETURN NULL; END IF;
    SELECT root_id INTO STRICT root FROM public.financial_application_manifests WHERE id=NEW.manifest_id;
  ELSE
    IF TG_TABLE_NAME='webhook_events' AND n->>'status'<>'PROCESSED' THEN RETURN NULL; END IF;
    IF NOT (public.capture_application_record_protected(TG_TABLE_NAME,n) OR public.capture_application_record_protected(TG_TABLE_NAME,o)) THEN RETURN NULL; END IF;
    root:=(public.current_financial_application_manifest()).root_id;
  END IF;
  IF EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.id=root AND r.family='CAPTURE'
    AND EXISTS(SELECT 1 FROM public.financial_application_scope_authority s WHERE (s.merchant_id,s.currency)=(r.merchant_id,r.currency))) THEN
    SELECT manifest_id INTO STRICT manifest FROM public.financial_applications WHERE root_id=root;
    PERFORM public.validate_capture_preparation(manifest);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER capture_application_complete AFTER INSERT OR UPDATE ON public.audit_logs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_capture_preparation_commit();
CREATE CONSTRAINT TRIGGER capture_application_complete AFTER UPDATE ON public.webhook_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_capture_preparation_commit();
CREATE CONSTRAINT TRIGGER capture_application_complete AFTER INSERT ON public.financial_application_effect_links DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_capture_preparation_commit();
CREATE CONSTRAINT TRIGGER capture_application_complete AFTER INSERT ON public.financial_application_revision_effects DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_capture_preparation_commit();
--> statement-breakpoint

-- All dispatch changes are transactional; registered identities, noncapture bodies and ACLs survive.
DO $$ DECLARE d text; needle text; branch text; BEGIN
  SELECT pg_get_functiondef('public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)'::regprocedure) INTO d;
  needle:='  INSERT INTO public.capture_preparation_issuances VALUES';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected installed capture preparation issuer'; END IF;
  d:=replace(d,needle,E'  m:=public.materialize_capture_application(m);\n  src:=m.source_manifest; effects:=m.effect_manifest;\n'||needle);
  EXECUTE d;
  ALTER FUNCTION public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint) SET timezone='UTC';
  ALTER FUNCTION public.read_capture_preparation() SET timezone='UTC';
  SELECT pg_get_functiondef('public.guard_capture_preparation_issuance()'::regprocedure) INTO d;
  IF position('CAPTURE_PREPARATION_V1' IN d)=0 THEN RAISE EXCEPTION 'Expected closed preparation issuance guard'; END IF;
  EXECUTE replace(d,'CAPTURE_PREPARATION_V1','CAPTURE_APPLICATION_V1');
  SELECT pg_get_functiondef('public.current_financial_application_manifest()'::regprocedure) INTO d;
  needle:='IF r.family=''CAPTURE'' THEN RAISE EXCEPTION ''Capture financial consumption closed before B2-B''; END IF;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected closed capture consumer'; END IF;
  EXECUTE replace(d,needle,'IF r.family=''CAPTURE'' THEN RETURN public.current_capture_application_manifest(m.id); END IF;');

  SELECT pg_get_functiondef('public.check_financial_application_effect_finality()'::regprocedure) INTO d;
  needle:=E'BEGIN\n';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected installed reverse effect finality'; END IF;
  EXECUTE overlay(d placing needle||$b$
  IF EXISTS(SELECT 1 FROM public.financial_application_permits p JOIN public.financial_application_manifests cap_manifest ON cap_manifest.id=p.manifest_id
    WHERE p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.database_principal=session_user
      AND cap_manifest.source_manifest->>'contract'='CAPTURE_APPLICATION_V1') THEN
    PERFORM public.check_capture_effect_finality(TG_TABLE_NAME,NEW.id); RETURN NULL;
  END IF;
$b$ from position(needle IN d) for length(needle));

  SELECT pg_get_functiondef('public.validate_financial_application(uuid)'::regprocedure) INTO d;
  needle:='  IF FOUND AND m.proof_kind=''PAYMENT_OPERATION_V1'' THEN';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected installed typed application validation'; END IF;
  EXECUTE replace(d,needle,$b$
  IF EXISTS(SELECT 1 FROM public.financial_application_roots r WHERE r.id=p_root AND r.family='CAPTURE') THEN
    PERFORM public.check_capture_application(m.id,false,false); RETURN;
  END IF;
$b$||needle);
  SELECT pg_get_functiondef('public.guard_financial_application_records()'::regprocedure) INTO d;
  needle:='  m:=public.current_financial_application_manifest();';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected installed final-record guard'; END IF;
  EXECUTE replace(d,needle,needle||$b$
  IF m.source_manifest->>'contract'='CAPTURE_APPLICATION_V1' THEN
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.source_manifest->'completion') x WHERE x->>'table'=TG_TABLE_NAME AND x->'after'=to_jsonb(NEW)) THEN
      RAISE EXCEPTION 'Exact complete capture record required'; END IF;
    RETURN NEW;
  END IF;
$b$);
  SELECT pg_get_functiondef('public.complete_financial_application()'::regprocedure) INTO d;
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected installed completion entry'; END IF;
  EXECUTE replace(d,needle,needle||$b$
  IF m.source_manifest->>'contract'='CAPTURE_APPLICATION_V1' THEN RETURN public.complete_capture_application(); END IF;
$b$);

  SELECT pg_get_functiondef('public.manual_authorization_blocked(text,text,uuid,text,uuid,bigint,uuid)'::regprocedure) INTO d;
  needle:='AND NOT (o.disposition=''AWAITING_APPLICATION'' AND public.manual_authorization_cause_cleared(o.inbox_id,o.obligation_revision,NULL))';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected AUTH receipt clearance'; END IF;
  d:=replace(d,needle,'AND NOT (o.disposition=''AWAITING_APPLICATION'' AND (public.manual_authorization_cause_cleared(o.inbox_id,o.obligation_revision,NULL) OR public.capture_application_cause_cleared(o.inbox_id,o.obligation_revision,NULL)))');
  needle:='AND NOT (o.disposition=''AWAITING_APPLICATION'' AND public.manual_authorization_cause_cleared(NULL,NULL,o.source_id))';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected AUTH source clearance'; END IF;
  d:=replace(d,needle,'AND NOT ((o.disposition=''AWAITING_APPLICATION'' AND public.manual_authorization_cause_cleared(NULL,NULL,o.source_id)) OR (o.disposition=''BLOCKING_REVIEW'' AND o.reason=''CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED'' AND public.capture_application_cause_cleared(NULL,NULL,o.source_id)))');
  EXECUTE d;
  SELECT pg_get_functiondef('public.capture_preparation_sources(public.payment_operation_evidence)'::regprocedure) INTO d;
  needle:='    IF o.disposition=''AWAITING_APPLICATION'' AND public.manual_authorization_cause_cleared(o.inbox_id,o.obligation_revision,NULL) THEN';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected capture receipt inventory'; END IF;
  d:=replace(d,needle,$b$
    IF o.disposition='AWAITING_APPLICATION' AND public.capture_application_cause_cleared(o.inbox_id,o.obligation_revision,NULL) THEN CONTINUE; END IF;
$b$||needle);
  needle:='    IF o.disposition=''AWAITING_APPLICATION'' AND public.manual_authorization_cause_cleared(NULL,NULL,o.source_id) THEN';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'Expected capture source inventory'; END IF;
  d:=replace(d,needle,$b$
    IF o.disposition='BLOCKING_REVIEW' AND o.reason='CAPTURE_AMOUNT_ATTRIBUTION_REQUIRED' AND public.capture_application_cause_cleared(NULL,NULL,o.source_id) THEN CONTINUE; END IF;
$b$||needle);
  EXECUTE d;
END $$;

-- Retained P-B/P-C history is immutable. Upgrade only typed timestamp comparisons;
-- all ownership, monetary calculations, JSON keys and non-timestamp values stay exact.
DO $$ DECLARE patch jsonb; definition text; target record; BEGIN
  FOR target IN SELECT value->>0 signature,jsonb_agg(value ORDER BY sequence) patches FROM jsonb_array_elements($patches$[
    ["public.check_manual_authorization(uuid,boolean,boolean)","src->'proof' IS DISTINCT FROM to_jsonb(e)","public.financial_image_at_utc('payment_operation_evidence',src->'proof') IS DISTINCT FROM public.financial_image_at_utc('payment_operation_evidence',to_jsonb(e))"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","src->'command' IS DISTINCT FROM to_jsonb(a)","public.financial_image_at_utc('provider_command_authorities',src->'command') IS DISTINCT FROM public.financial_image_at_utc('provider_command_authorities',to_jsonb(a))"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","src->'root' IS DISTINCT FROM to_jsonb(r)","public.financial_image_at_utc('financial_application_roots',src->'root') IS DISTINCT FROM public.financial_image_at_utc('financial_application_roots',to_jsonb(r))"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","IF m.effect_manifest IS DISTINCT FROM jsonb_build_array(","IF public.financial_effects_at_utc(m.effect_manifest) IS DISTINCT FROM public.financial_effects_at_utc(jsonb_build_array("],
    ["public.check_manual_authorization(uuid,boolean,boolean)","'before',bw,'after',aw)) THEN","'before',bw,'after',aw))) THEN"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","IF actual IS DISTINCT FROM x->'after' THEN","IF public.financial_image_at_utc(x->>'table',actual) IS DISTINCT FROM public.financial_image_at_utc(x->>'table',x->'after') THEN"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","i.root_image=to_jsonb(r)","public.financial_image_at_utc('financial_application_roots',i.root_image)=public.financial_image_at_utc('financial_application_roots',to_jsonb(r))"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","i.manifest_image=to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id']","public.financial_image_at_utc('financial_application_manifests',i.manifest_image)=public.financial_image_at_utc('financial_application_manifests',to_jsonb(m)-ARRAY['legacy_proof_inbox_id','payment_proof_inbox_id'])"],
    ["public.check_manual_authorization(uuid,boolean,boolean)","to_jsonb(o)=src->'obligation'","public.financial_image_at_utc('receipt_admission_obligations',to_jsonb(o))=public.financial_image_at_utc('receipt_admission_obligations',src->'obligation')"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","m.source_manifest->'request' IS DISTINCT FROM to_jsonb(q)","public.financial_image_at_utc('first_capture_intent_requests',m.source_manifest->'request') IS DISTINCT FROM public.financial_image_at_utc('first_capture_intent_requests',to_jsonb(q))"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","m.source_manifest->'auth_root' IS DISTINCT FROM to_jsonb(r)","public.financial_image_at_utc('financial_application_roots',m.source_manifest->'auth_root') IS DISTINCT FROM public.financial_image_at_utc('financial_application_roots',to_jsonb(r))"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","m.source_manifest->'auth_manifest' IS DISTINCT FROM to_jsonb(auth)","public.financial_image_at_utc('financial_application_manifests',m.source_manifest->'auth_manifest') IS DISTINCT FROM public.financial_image_at_utc('financial_application_manifests',to_jsonb(auth))"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","m.source_manifest->'auth_proof' IS DISTINCT FROM to_jsonb(proof)","public.financial_image_at_utc('payment_operation_evidence',m.source_manifest->'auth_proof') IS DISTINCT FROM public.financial_image_at_utc('payment_operation_evidence',to_jsonb(proof))"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","IF m.effect_manifest IS DISTINCT FROM expected THEN","IF public.financial_effects_at_utc(m.effect_manifest) IS DISTINCT FROM public.financial_effects_at_utc(expected) THEN"],
    ["public.check_first_capture_intent(uuid,boolean,boolean)","    IF p_historical AND n=1 THEN","    actual:=public.financial_image_at_utc(x->>'table',actual);\n    x:=jsonb_set(x,ARRAY['after'],public.financial_image_at_utc(x->>'table',x->'after'));\n    IF p_historical AND n=1 THEN"],
    ["public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)","c.after_image=to_jsonb(w)","public.financial_image_at_utc('webhook_events',c.after_image)=to_jsonb(w)"],
    ["public.prepare_capture_application(uuid,uuid,uuid,integer,bigint,bigint,bigint)","to_jsonb(p) IS DISTINCT FROM intent.effect_manifest#>'{0,after}' OR to_jsonb(t) IS DISTINCT FROM intent.effect_manifest#>'{1,after}'","public.financial_image_at_utc('payments',to_jsonb(p)) IS DISTINCT FROM public.financial_image_at_utc('payments',intent.effect_manifest#>'{0,after}') OR public.financial_image_at_utc('payment_attempts',to_jsonb(t)) IS DISTINCT FROM public.financial_image_at_utc('payment_attempts',intent.effect_manifest#>'{1,after}')"]
  ]$patches$::jsonb) WITH ORDINALITY AS p(value,sequence) GROUP BY value->>0 LOOP
    SELECT pg_get_functiondef(target.signature::regprocedure) INTO definition;
    FOR patch IN SELECT value FROM jsonb_array_elements(target.patches) LOOP
      IF position(patch->>1 IN definition)=0 THEN RAISE EXCEPTION 'Expected installed timestamp comparison in %',patch->>0; END IF;
      definition:=replace(definition,patch->>1,patch->>2);
    END LOOP;
    EXECUTE definition;
  END LOOP;
END $$;


DO $$ DECLARE writer text:='fintech_capture_prepare_'||md5(current_database()); checker text:='fintech_capture_check_'||md5(current_database());
  role_name text; f record; name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP
    EXECUTE format('GRANT SELECT ON public.ledger_accounts,public.ledger_entries,public.financial_application_dispositions,public.financial_application_revision_effects,public.financial_application_effect_links TO %I',role_name);
  END LOOP;
  EXECUTE format('GRANT INSERT ON public.ledger_accounts,public.ledger_transactions,public.ledger_entries,public.capture_accounting_lots,public.audit_logs,
    public.financial_applications,public.financial_application_dispositions,public.financial_application_effect_links TO %I',writer);
  EXECUTE format('GRANT SELECT ON public.capture_accounting_legacy_inventory TO %I',writer);
  EXECUTE format('GRANT UPDATE(created_at) ON public.ledger_accounts TO %I',writer);
  EXECUTE format('GRANT UPDATE(status,posted_at) ON public.ledger_transactions TO %I',writer);
  EXECUTE format('GRANT UPDATE(status,provider_transaction_id,failure_code,updated_at) ON public.payment_attempts TO %I',writer);
  EXECUTE format('GRANT UPDATE(status,captured_amount,platform_fee_amount,captured_at,version,updated_at) ON public.payments TO %I',writer);
  EXECUTE format('GRANT UPDATE(status,processed_at,locked_at,updated_at) ON public.webhook_events TO %I',writer);
  -- Checkers acquire no new issuance or financial write capability.
  FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',role_name);
  END LOOP;
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('financial_image_at_utc','financial_effects_at_utc','capture_application_effects','capture_application_completion','materialize_capture_application','current_capture_application_manifest',
     'check_capture_application','capture_application_cause_cleared','complete_capture_application','apply_capture_application','capture_application_record_protected','check_capture_effect_finality') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.signature,CASE WHEN f.proname IN ('materialize_capture_application','apply_capture_application','complete_capture_application') THEN writer ELSE checker END);
    FOREACH role_name IN ARRAY ARRAY[writer,checker] LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,role_name); END LOOP;
  END LOOP;
  -- Existing history owners receive read-only normalization, with no new financial authority.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.financial_image_at_utc(text,jsonb),public.financial_effects_at_utc(jsonb) TO %I','fintech_manual_history_'||md5(current_database()));
  -- Existing callers retain their own owners; grant only the exact new private read delegates they use.
  FOR name IN SELECT unnest(ARRAY['fintech_application_','fintech_manual_history_','fintech_admission_','fintech_manual_authorization_','fintech_capture_intent_']) LOOP
    role_name:=name||md5(current_database());
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_capture_application_manifest(uuid),public.check_capture_application(uuid,boolean,boolean),
        public.capture_application_cause_cleared(uuid,bigint,uuid),public.complete_capture_application(),public.check_capture_effect_finality(text,uuid) TO %I',role_name);
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_financial_application_manifest(),public.complete_financial_application(),public.advance_financial_application_revision(),
    public.validate_capture_preparation(uuid),public.reject_capture_preparation_commit() TO %I',writer);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_financial_application_manifest() TO %I',checker);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I,%I',writer,checker);
END $$;

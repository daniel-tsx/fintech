import type { ReceiptTransactions } from './trusted-receipt-database';

export interface PaymentEvidenceResult { state: 'SEALED' | 'BLOCKING_REVIEW'; proof_id?: string; operation?: string; reason?: string }

// Isolated composition only. SQL owns all source interpretation; binding commits
// separately so a failed transfer leaves the original unknown blocker intact.
export class TrustedPaymentOperationEvidence {
  constructor(private readonly database: ReceiptTransactions) {}

  seal(inboxId: string, generation: number, revision: string, sourceId: string, authorizationSourceId: string | null) {
    return this.database.transaction(async tx => {
      const [row] = await tx<{ result: PaymentEvidenceResult }[]>`select public.seal_payment_operation_evidence(
        ${inboxId},${generation},${revision},${sourceId},${authorizationSourceId}) as result`;
      return row.result;
    });
  }

  bind(inboxId: string, proofId: string, revision: string) {
    return this.database.transaction(async tx => {
      const [row] = await tx`select * from public.bind_payment_operation_obligation(${inboxId},${proofId},${revision})`;
      return row;
    });
  }

  read(inboxId: string, operation: string) {
    return this.database.transaction(async tx => {
      const [row] = await tx`select * from public.load_effective_payment_operation_evidence(${inboxId},1,${operation})`;
      return row;
    });
  }
}

import { api, formatMoney, formatTime } from "@/lib/api";
import {
  DataTable,
  EvidencePane,
  PageHeading,
  PaymentLink,
  Status,
} from "@/components/console";

interface Payment {
  id: string;
  status: string;
  amount: string;
  capturedAmount: string;
  refundedAmount: string;
  currency: string;
  captureMethod: string;
  createdAt: string;
}
export const dynamic = "force-dynamic";
export default async function PaymentsPage() {
  const result = await api<{ data: Payment[] }>("/payments?pageSize=100");
  return (
    <>
      <PageHeading eyebrow="operational aggregate" title="Payments">
        Mutable workflow state. Open a payment to compare it with its immutable
        financial evidence.
      </PageHeading>
      <EvidencePane label="payment register" title="Latest 100 merchant intents">
        <DataTable
          empty="No payments yet. Demo payment intents will appear here."
          columns={[
            { key: "id", label: "payment" },
            { key: "status", label: "state" },
            { key: "flow", label: "capture flow" },
            { key: "captured", label: "captured", align: "right" },
            { key: "refunded", label: "refunded", align: "right" },
            { key: "created", label: "created" },
          ]}
          rows={result.data.map((payment) => ({
            id: <PaymentLink id={payment.id} />,
            status: <Status value={payment.status} />,
            flow: payment.captureMethod.toLowerCase(),
            captured: formatMoney(payment.capturedAmount, payment.currency),
            refunded: formatMoney(payment.refundedAmount, payment.currency),
            created: formatTime(payment.createdAt),
          }))}
        />
      </EvidencePane>
    </>
  );
}

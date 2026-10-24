export const navGroups: Array<{ label: string; items: Array<[label: string, href: string]> }> = [
  { label: 'flow', items: [['Overview', '/'], ['Payments', '/payments'], ['Ledger', '/ledger']] },
  { label: 'money movement', items: [['Settlements', '/settlements'], ['Payouts', '/payouts'], ['Disputes', '/disputes']] },
  { label: 'control plane', items: [['Webhooks', '/webhooks'], ['Reconciliation', '/reconciliation'], ['Audit trail', '/audit']] },
];

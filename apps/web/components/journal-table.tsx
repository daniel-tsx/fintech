import { formatAmount, formatTime } from '@/lib/format';
import { Amount, IdCell, Status } from './console';

export interface JournalLine { account: string; accountType?: string; debit: string; credit: string }
export interface Journal { id: string; type: string; description: string; currency: string; at: string; status?: string; reference?: string; lines: JournalLine[] }

/** Group flat ledger lines (one per entry, journal fields repeated) into journals, keeping API order. */
export function groupJournals<T>(rows: T[], id: (row: T) => string, journal: (row: T) => Omit<Journal, 'lines'>, line: (row: T) => JournalLine): Journal[] {
  const journals = new Map<string, Journal>();
  for (const row of rows) {
    const key = id(row);
    if (!journals.has(key)) journals.set(key, { ...journal(row), lines: [] });
    journals.get(key)!.lines.push(line(row));
  }
  return [...journals.values()];
}

const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), BigInt(0)).toString();
const label = (code: string) => code.replaceAll('_', ' ').toLowerCase();

/** One tbody per journal: a head row, its lines, and debit/credit totals. */
export function JournalTable({ journals, caption, incompleteId }: { journals: Journal[]; caption: string; incompleteId?: string }) {
  const typed = journals.some((journal) => journal.lines.some((line) => line.accountType));
  const span = typed ? 4 : 3;
  return <div className="table-scroll"><table className="journal-table">
    <caption className="sr-only">{caption}</caption>
    <thead><tr><th scope="col">Account</th>{typed && <th scope="col">Type</th>}<th scope="col" className="align-right">Debit</th><th scope="col" className="align-right">Credit</th></tr></thead>
    {journals.map((journal) => <tbody key={journal.id}>
      <tr className="journal-head"><th scope="rowgroup" colSpan={span}>
        <span className="journal-type">{label(journal.type)}</span>
        <span>{journal.description}</span>
        {journal.status && <Status value={journal.status} />}
        <span className="journal-meta">{journal.reference && <>ref <IdCell id={journal.reference} label="Business reference" /> · </>}journal <IdCell id={journal.id} label="Journal" /> · <span className="mono">{journal.currency}</span> · <span className="mono">{formatTime(journal.at)}</span></span>
      </th></tr>
      {journal.lines.map((line, index) => <tr key={index}>
        <td>{label(line.account)}</td>
        {typed && <td>{line.accountType?.toLowerCase()}</td>}
        <td className="align-right numeric">{BigInt(line.debit) ? <Amount value={line.debit} currency={journal.currency} /> : '—'}</td>
        <td className="align-right numeric">{BigInt(line.credit) ? <Amount value={line.credit} currency={journal.currency} /> : '—'}</td>
      </tr>)}
      <tr className="journal-total">
        <td colSpan={span - 2}>{journal.id === incompleteId ? 'Total of the lines shown · this journal may continue past the API limit' : 'Total'}</td>
        <td className="align-right numeric">{formatAmount(sum(journal.lines.map((line) => line.debit)), journal.currency)}</td>
        <td className="align-right numeric">{formatAmount(sum(journal.lines.map((line) => line.credit)), journal.currency)}</td>
      </tr>
    </tbody>)}
  </table></div>;
}

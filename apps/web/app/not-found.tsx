import Link from 'next/link';
export default function NotFound(){return <div className="error-screen"><span className="micro-label">trace not found</span><strong aria-hidden>404</strong><h1>This evidence coordinate is empty.</h1><p>The payment may belong to another merchant, or the identifier is no longer valid.</p><Link href="/payments">Return to the payment register</Link></div>}

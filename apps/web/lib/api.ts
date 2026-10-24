const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';
const API_KEY = process.env.DEMO_API_KEY ?? 'fl_test_demo_6f414a845fe04eb4';

/** `status` is set when the API answered with an error; absent when it could not be reached. */
export class ApiUnavailableError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function api<T>(path: string): Promise<T> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: { 'x-api-key': API_KEY } });
    if (!response.ok) throw new ApiUnavailableError(`API returned ${response.status}`, response.status);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiUnavailableError) throw error;
    throw new ApiUnavailableError('The local API is not reachable. Start PostgreSQL, Redis, the API, and the worker.');
  }
}

/** `.catch(offline)`: resolves to null when the API is unreachable so the page can show the offline state; rethrows real API errors. */
export function offline(error: unknown): null {
  if (error instanceof ApiUnavailableError && error.status === undefined) return null;
  throw error;
}

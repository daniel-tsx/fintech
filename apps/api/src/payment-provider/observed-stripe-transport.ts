import { AsyncLocalStorage } from 'node:async_hooks';
import { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import Stripe from 'stripe';

export type StripeHttpClient = InstanceType<typeof Stripe.HttpClient>;
type StripeHttpResponse = Awaited<ReturnType<StripeHttpClient['makeRequest']>>;

export interface CapturedExchange {
  method: string; path: string; host: string; protocol: string;
  requestHeaders: Record<string, string>; requestBody: string;
  responseHeaders: Record<string, string>; httpStatus: number | null;
  transportError: string | null; body: Buffer | null;
  completeness: 'COMPLETE' | 'PARTIAL' | 'ABSENT'; observedAt: Date;
}
interface CaptureContext { exchanges: CapturedExchange[]; safeUntil: number; account: string; key?: string }
const BODY_LIMIT = 1048576;

function retainedHeaders(headers: object, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]: [string, unknown]) =>
    names.includes(name.toLowerCase()) && typeof value === 'string' ? [[name.toLowerCase(), value]] : []));
}

// Supported stripe-node transport boundary. Each HTTP attempt, including SDK
// retries, is captured before its body is decoded. No request/response logging.
export class ObservedStripeTransport extends Stripe.HttpClient {
  private readonly context = new AsyncLocalStorage<CaptureContext>();
  constructor(private readonly inner: StripeHttpClient) { super(); }
  getClientName(): string { return 'd02-observed-node'; }
  capture<T>(context: CaptureContext, work: () => Promise<T>): Promise<T> { return this.context.run(context, work); }

  async makeRequest(...args: Parameters<StripeHttpClient['makeRequest']>): Promise<StripeHttpResponse> {
    const [host, port, path, method, headers, data, protocol] = args;
    const context = this.context.getStore();
    const safe = retainedHeaders(headers, ['stripe-account', 'idempotency-key', 'stripe-version', 'content-type']);
    if (!context || host !== 'api.stripe.com' || port !== '443' || protocol !== 'https'
      || safe['stripe-account'] !== context.account || (method === 'POST' && safe['idempotency-key'] !== context.key)
      || Date.now() >= context.safeUntil || Buffer.byteLength(data) > BODY_LIMIT) throw new Error('D02 transport authority required');
    const exchange: CapturedExchange = { method, path, host, protocol, requestHeaders: safe, requestBody: Buffer.from(data).toString('hex'),
      responseHeaders: {}, httpStatus: null, transportError: null, body: null, completeness: 'ABSENT', observedAt: new Date() };
    context.exchanges.push(exchange);
    try {
      const response = await this.inner.makeRequest(...args);
      exchange.httpStatus = response.getStatusCode();
      exchange.responseHeaders = retainedHeaders(response.getHeaders(), ['request-id', 'stripe-account', 'stripe-version', 'content-type', 'stripe-should-retry']);
      // RequestSender may select a retry without ever calling toJSON(). Retain
      // every response before returning control to that decision. Body failures
      // stay on the response so SDK status/header retry selection is preserved.
      const captured = new CapturedResponse(response, exchange);
      await captured.retainBody();
      return captured;
    } catch (error) {
      exchange.transportError = error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'CONNECTION_FAILURE';
      exchange.observedAt = new Date();
      throw error;
    }
  }
}

class CapturedResponse extends Stripe.HttpClientResponse {
  private bodyError?: Error;
  private decoded?: Promise<unknown>;
  constructor(private readonly inner: StripeHttpResponse, private readonly exchange: CapturedExchange) {
    super(inner.getStatusCode(), inner.getHeaders());
  }
  getRawResponse(): unknown { return this.inner.getRawResponse(); }
  toStream(): never { throw new Error('D02 supports SDK JSON operations only'); }
  async retainBody(): Promise<void> {
    const chunks: Buffer[] = []; let length = 0;
    const stream = this.inner.toStream(() => undefined);
    if (!(stream instanceof Readable)) throw new Error('D02 requires the Node byte-stream transport');
    try {
      for await (const value of stream) {
        if (!Buffer.isBuffer(value)) throw new Error('Provider stream was already decoded');
        const retained = value.subarray(0, Math.max(0, BODY_LIMIT - length)); chunks.push(Buffer.from(retained)); length += value.length;
        if (length > BODY_LIMIT) { stream.destroy(); throw new Error('Provider body exceeds retention limit'); }
      }
      if (stream instanceof IncomingMessage && !stream.complete) throw new Error('Incomplete provider HTTP message');
      this.exchange.completeness = 'COMPLETE';
    } catch (error) {
      this.exchange.completeness = 'PARTIAL'; this.exchange.transportError = 'INCOMPLETE_BODY';
      this.bodyError = Stripe.HttpClient.makeResponseBodyError(error);
    } finally {
      this.exchange.body = Buffer.concat(chunks); this.exchange.observedAt = new Date();
    }
  }
  toJSON(): Promise<unknown> {
    // Decode lazily: retry selection must still use the original status/headers
    // even when an intermediate body is malformed or could not be completed.
    return this.decoded ??= Promise.resolve().then(() => {
      if (this.bodyError) throw this.bodyError;
      const body = this.exchange.body;
      if (body === null) throw new Error('Provider response body was not retained');
      // Fatal decoding retains original invalid bytes instead of substituting
      // replacement characters into an authoritative provider object.
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    });
  }
}

export type ActorRole = 'PLATFORM_ADMIN' | 'MERCHANT_ADMIN' | 'MERCHANT_OPERATOR';

export interface AuthActor {
  id: string;
  type: 'API_KEY' | 'USER';
  merchantId: string | null;
  role: ActorRole;
  correlationId?: string;
}

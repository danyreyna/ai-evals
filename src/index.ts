export type PaymentStatus =
  | "pending"
  | "succeeded"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export type Payment = {
  id: string;
  amount: number;
  currency: string;
  source: string;
  status: PaymentStatus;
  amountRefunded: number;
  createdAt: string;
};

export type CreatePaymentInput = {
  amount: number;
  currency: string;
  source: string;
};

export type RefundInput = {
  amount?: number;
};

export class PaymentsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentsApiError";
  }
}

export type PaymentsClientOptions = {
  apiKey: string;
  baseUrl?: string;
};

export class PaymentsClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor({ apiKey, baseUrl = "https://api.example.com/v1" }: PaymentsClientOptions) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
  }

  createPayment(input: CreatePaymentInput) {
    return this.#request<Payment>("POST", "/payments", input);
  }

  getPayment(id: string) {
    return this.#request<Payment>("GET", `/payments/${encodeURIComponent(id)}`);
  }

  async listPayments(filter: { status?: PaymentStatus } = {}) {
    const query = filter.status ? `?status=${filter.status}` : "";
    const { data } = await this.#request<{ data: Payment[] }>("GET", `/payments${query}`);
    return data;
  }

  refundPayment(id: string, input: RefundInput = {}) {
    return this.#request<Payment>("POST", `/payments/${encodeURIComponent(id)}/refund`, input);
  }

  cancelPayment(id: string) {
    return this.#request<Payment>("POST", `/payments/${encodeURIComponent(id)}/cancel`);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      throw new PaymentsApiError(
        response.status,
        payload?.error?.code ?? "unknown_error",
        payload?.error?.message ?? response.statusText,
      );
    }

    return (await response.json()) as T;
  }
}

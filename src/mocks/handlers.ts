import { http, HttpResponse, delay } from "msw";

const BASE_URL = "https://api.example.com/v1";
const VALID_API_KEY = "test_key";

type PaymentStatus = "pending" | "succeeded" | "canceled" | "refunded" | "partially_refunded";

interface StoredPayment {
  id: string;
  amount: number;
  currency: string;
  source: string;
  status: PaymentStatus;
  amountRefunded: number;
  createdAt: string;
}

const payments = new Map<string, StoredPayment>();

export function resetPayments() {
  payments.clear();
}

function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function isAuthorized(request: Request) {
  return request.headers.get("Authorization") === `Bearer ${VALID_API_KEY}`;
}

const unauthorized = () => errorResponse(401, "unauthorized", "Missing or invalid API key");

const notFound = (id: string) =>
  errorResponse(404, "payment_not_found", `No payment with id ${id}`);

export const handlers = [
  http.get("https://api.example.com/user", () => {
    return HttpResponse.json({
      id: "abc-123",
      firstName: "John",
      lastName: "Maverick",
    });
  }),

  // 1. Create a payment. The `source` token selects the simulated outcome.
  http.post(`${BASE_URL}/payments`, async ({ request }) => {
    if (!isAuthorized(request)) {
      return unauthorized();
    }

    const body = (await request.json().catch(() => null)) as {
      amount?: unknown;
      currency?: unknown;
      source?: unknown;
    } | null;

    if (
      !body ||
      typeof body.amount !== "number" ||
      !Number.isInteger(body.amount) ||
      body.amount <= 0 ||
      typeof body.currency !== "string" ||
      typeof body.source !== "string"
    ) {
      return errorResponse(
        400,
        "invalid_request",
        "amount (positive integer), currency and source are required",
      );
    }

    switch (body.source) {
      case "tok_chargeDeclined":
        return errorResponse(402, "card_declined", "The card was declined");
      case "tok_insufficientFunds":
        return errorResponse(402, "insufficient_funds", "The card has insufficient funds");
      case "tok_serverError":
        return errorResponse(
          500,
          "processing_error",
          "An error occurred while processing the payment",
        );
      case "tok_timeout":
        await delay(10_000);
        break;
      case "tok_visa":
      case "tok_pending":
        break;
      default:
        return errorResponse(400, "invalid_source", "Unknown payment source");
    }

    const payment: StoredPayment = {
      id: `pay_${crypto.randomUUID()}`,
      amount: body.amount,
      currency: body.currency,
      source: body.source,
      status: body.source === "tok_pending" ? "pending" : "succeeded",
      amountRefunded: 0,
      createdAt: new Date().toISOString(),
    };
    payments.set(payment.id, payment);
    return HttpResponse.json(payment, { status: 201 });
  }),

  // 2. Retrieve a payment.
  http.get(`${BASE_URL}/payments/:id`, ({ request, params }) => {
    if (!isAuthorized(request)) {
      return unauthorized();
    }
    const payment = payments.get(params["id"] as string);
    if (!payment) {
      return notFound(params["id"] as string);
    }
    return HttpResponse.json(payment);
  }),

  // 3. List payments, optionally filtered by status.
  http.get(`${BASE_URL}/payments`, ({ request }) => {
    if (!isAuthorized(request)) {
      return unauthorized();
    }
    const status = new URL(request.url).searchParams.get("status");
    const data = [...payments.values()].filter((p) => !status || p.status === status);
    return HttpResponse.json({ data });
  }),

  // 4. Refund a payment, fully or partially.
  http.post(`${BASE_URL}/payments/:id/refund`, async ({ request, params }) => {
    if (!isAuthorized(request)) {
      return unauthorized();
    }
    const payment = payments.get(params["id"] as string);
    if (!payment) {
      return notFound(params["id"] as string);
    }

    if (payment.status === "refunded") {
      return errorResponse(409, "already_refunded", "Payment already refunded");
    }
    if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
      return errorResponse(409, "not_refundable", `A ${payment.status} payment cannot be refunded`);
    }

    const body = (await request.json().catch(() => ({}))) as {
      amount?: number;
    };
    const remaining = payment.amount - payment.amountRefunded;
    const amount = body.amount ?? remaining;

    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      return errorResponse(
        422,
        "invalid_refund_amount",
        `Refund amount must be between 1 and ${remaining}`,
      );
    }

    payment.amountRefunded += amount;
    payment.status = payment.amountRefunded === payment.amount ? "refunded" : "partially_refunded";
    return HttpResponse.json(payment);
  }),

  // 5. Cancel a pending payment.
  http.post(`${BASE_URL}/payments/:id/cancel`, ({ request, params }) => {
    if (!isAuthorized(request)) {
      return unauthorized();
    }
    const payment = payments.get(params["id"] as string);
    if (!payment) {
      return notFound(params["id"] as string);
    }

    if (payment.status !== "pending") {
      return errorResponse(409, "not_cancelable", `A ${payment.status} payment cannot be canceled`);
    }

    payment.status = "canceled";
    return HttpResponse.json(payment);
  }),
];

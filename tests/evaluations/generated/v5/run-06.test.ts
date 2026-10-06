import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import type { CreatePaymentInput } from "./index.ts";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });

const input = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
  ...overrides,
});

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error(`expected PaymentsApiError ${status} ${code}, but the call resolved`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(input());

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(1000);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(input({ source: "tok_pending" }));

    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(input({ amount: 2500 }));

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("sends the bearer token and JSON body", async () => {
    const seen: { authorization?: string | null; contentType?: string | null; body?: unknown } = {};
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        seen.authorization = request.headers.get("Authorization");
        seen.contentType = request.headers.get("Content-Type");
        seen.body = await request.json();
        return HttpResponse.json({ id: "pay_x" }, { status: 201 });
      }),
    );

    await client.createPayment(input({ amount: 42, currency: "eur" }));

    expect(seen.authorization).toBe("Bearer test_key");
    expect(seen.contentType).toBe("application/json");
    expect(seen.body).toEqual({ amount: 42, currency: "eur", source: "tok_visa" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(
      bad.createPayment(input()),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_chargeDeclined" })),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_insufficientFunds" })),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_serverError" })),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_nope" })),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, overrides) => {
    await expectApiError(client.createPayment(input(overrides)), 400, "invalid_request");
  });

  test("does not store a payment that failed", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_chargeDeclined" })),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment by id", async () => {
    const created = await client.createPayment(input());

    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(1000);
    expect(fetched.status).toBe("succeeded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id in the request path", async () => {
    let pathname = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        pathname = new URL(request.url).pathname;
        return HttpResponse.json({ id: "x" });
      }),
    );

    await client.getPayment("a/b c");

    expect(pathname).toBe("/v1/payments/a%2Fb%20c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(bad.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(input({ amount: 100 }));
    const b = await client.createPayment(input({ amount: 200, source: "tok_pending" }));

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input());
    const pending = await client.createPayment(input({ source: "tok_pending" }));

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a specific amount", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds only the remainder when no amount follows a partial refund", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so it is visible on retrieval", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(input());
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund larger than the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects a refund larger than the remaining balance with 422", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(bad.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input());

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(bad.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("bad gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });
});

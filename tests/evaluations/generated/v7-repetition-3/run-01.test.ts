import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

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

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

function createSucceeded(amount = 1000) {
  return client.createPayment({ amount, currency: "usd", source: "tok_visa" });
}

function createPending(amount = 1000) {
  return client.createPayment({ amount, currency: "usd", source: "tok_pending" });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
    });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await createPending(700);

    expect(payment).toMatchObject({
      amount: 700,
      source: "tok_pending",
      status: "pending",
      amountRefunded: 0,
    });
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await createSucceeded();
    const second = await createSucceeded();

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(
      client.createPayment({ amount, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await createSucceeded(1800);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("reflects state changes made after creation", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so a slash does not change the route", async () => {
    await expectApiError(client.getPayment("a/b"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await createSucceeded(100);
    const b = await createPending(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await createSucceeded(100);
    const pending = await createPending(200);

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createSucceeded();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("sees status changes in the filtered results", async () => {
    const payment = await createPending();
    const canceled = await client.cancelPayment(payment.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amount: 1000,
      amountRefunded: 1000,
    });
  });

  test("partially refunds the requested amount", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 300,
    });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await createSucceeded(1000);

    const first = await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 700 });

    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 300 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("bounds the refund by what is left after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 101 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 100",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await createPending();

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await createPending(900);

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await createPending();

    await expectApiError(badKeyClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and the status text for a non-JSON error body", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(
      client.getPayment("pay_any"),
      503,
      "unknown_error",
      "Service Unavailable",
    );
  });
});

describe("request shape", () => {
  test("sends the API key as a bearer token and returns the response", async () => {
    let authorization: string | null = null;
    server.use(
      http.get(`${BASE_URL}/payments`, ({ request }) => {
        authorization = request.headers.get("Authorization");
        return HttpResponse.json({ data: [] satisfies Payment[] });
      }),
    );

    const payments = await new PaymentsClient({ apiKey: "abc" }).listPayments();

    expect(payments).toEqual([]);
    expect(authorization).toBe("Bearer abc");
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://other.example.com/api/payments", () => HttpResponse.json({ data: [] })),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://other.example.com/api",
    });

    expect(await custom.listPayments()).toEqual([]);
  });
});

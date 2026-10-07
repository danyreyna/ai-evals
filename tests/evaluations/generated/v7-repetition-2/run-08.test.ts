import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });

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
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending = { amount: 1000, currency: "usd", source: "tok_pending" };

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(visa);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment(pending);

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(visa);
    const second = await client.createPayment(visa);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment({ ...visa, amount }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.createPayment(visa), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("does not store a payment that was rejected", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id instead of changing the request path", async () => {
    await client.createPayment(visa);

    // Unencoded, "../payments" would resolve to the list endpoint and succeed.
    await expectApiError(client.getPayment("../payments"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(visa);
    const pendingPayment = await client.createPayment(pending);

    expect(await client.listPayments({ status: "pending" })).toEqual([pendingPayment]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(visa);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in filtered results", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([
      { ...created, status: "canceled" },
    ]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("becomes refunded once partial refunds sum to the full amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 600 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error handling", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return new HttpResponse("<html>bad gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

describe("request shape", () => {
  test("sends the bearer token configured on the client", async () => {
    const other = new PaymentsClient({ apiKey: "other_key" });

    // The mock only accepts "test_key", so a 401 proves the configured key is what is sent.
    await expectApiError(other.listPayments(), { status: 401, code: "unauthorized" });
    expect(await client.listPayments()).toEqual([]);
  });

  test("uses a custom baseUrl", async () => {
    const custom = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://custom.example.com/v2" });
    const stored = {
      id: "pay_custom",
      amount: 5,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    server.use(
      http.get("https://custom.example.com/v2/payments/pay_custom", () =>
        HttpResponse.json(stored),
      ),
    );

    expect(await custom.getPayment("pay_custom")).toEqual(stored);
  });
});

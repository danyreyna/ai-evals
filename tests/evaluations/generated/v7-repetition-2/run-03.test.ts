import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    ...expected,
  });
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
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment({ amount: 2500, currency: "usd", source: "tok_visa" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([newPayment(), newPayment()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(newPayment("tok_serverError"), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_bogus"), {
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
    await expectApiError(newPayment("tok_visa", amount), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("a failed creation does not store a payment", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), { status: 402, code: "card_declined" });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await newPayment("tok_visa", 4200);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("reflects state changes made by other calls", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await newPayment("tok_visa");

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amount: 1000,
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 300,
    });
  });

  test("accumulates partial refunds and ends up refunded", async () => {
    const created = await newPayment("tok_visa", 1000);

    const first = await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 700 });

    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 300 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remaining balance with 422", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(client.refundPayment(created.id, { amount: 300 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 200",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("a rejected refund leaves the payment unchanged", async () => {
    const created = await newPayment("tok_visa", 1000);
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });
  const unauthorized = { status: 401, code: "unauthorized", message: "Missing or invalid API key" };

  test("createPayment rejects an invalid key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      unauthorized,
    );
  });

  test("getPayment rejects an invalid key with 401 unauthorized", async () => {
    const created = await newPayment();

    await expectApiError(badClient.getPayment(created.id), unauthorized);
  });

  test("listPayments rejects an invalid key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), unauthorized);
  });

  test("refundPayment rejects an invalid key with 401 unauthorized", async () => {
    const created = await newPayment();

    await expectApiError(badClient.refundPayment(created.id), unauthorized);
  });

  test("cancelPayment rejects an invalid key with 401 unauthorized", async () => {
    const created = await newPayment("tok_pending");

    await expectApiError(badClient.cancelPayment(created.id), unauthorized);
  });

  test("an unauthorized call does not change server state", async () => {
    const created = await newPayment("tok_pending");
    await expectApiError(badClient.cancelPayment(created.id), { status: 401, code: "unauthorized" });

    expect((await client.getPayment(created.id)).status).toBe("pending");
  });
});

describe("error payload fallbacks", () => {
  test("uses unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/pay_1`,
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_1"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("uses unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/pay_1`,
        () => HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_1"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

describe("request construction", () => {
  test("URL-encodes ids so path separators cannot reach another route", async () => {
    await expectApiError(client.getPayment("a/b"), { status: 404, code: "payment_not_found" });
  });

  test("sends the configured base URL", async () => {
    const custom = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://payments.internal/v2" });
    server.use(
      http.get("https://payments.internal/v2/payments", () =>
        HttpResponse.json({ data: [] }),
      ),
    );

    expect(await custom.listPayments()).toEqual([]);
  });
});

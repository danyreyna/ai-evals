import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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

function create(overrides: Partial<CreatePaymentInput> = {}) {
  return client.createPayment({
    amount: 1000,
    currency: "usd",
    source: "tok_visa",
    ...overrides,
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await create({ amount: 2500, currency: "eur" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await create({ source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([create(), create()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects 402 card_declined for tok_chargeDeclined", async () => {
    await expectApiError(create({ source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expectApiError(create({ source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects 500 processing_error for tok_serverError", async () => {
    await expectApiError(create({ source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects 400 invalid_source for an unknown source", async () => {
    await expectApiError(create({ source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["non-integer", 10.5],
  ])("rejects 400 invalid_request for a %s amount", async (_label, amount) => {
    await expectApiError(create({ amount }), { status: 400, code: "invalid_request" });
  });

  test("rejects 400 invalid_request when currency is missing", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects 401 unauthorized with a bad API key", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });

  test("does not store a payment whose creation was declined", async () => {
    await expectApiError(create({ source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await create({ amount: 4200, currency: "gbp" });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it reaches the server intact", async () => {
    await expectApiError(client.getPayment("a/b?c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b?c",
    });
  });

  test("rejects 401 unauthorized with a bad API key", async () => {
    const created = await create();

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
    const a = await create({ amount: 100 });
    const b = await create({ amount: 200, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await create({ amount: 100 });
    const pending = await create({ amount: 200, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await create();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes after a refund", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });

    const partial = await client.listPayments({ status: "partially_refunded" });

    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ id: created.id, amountRefunded: 400 });
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
  });

  test("rejects 401 unauthorized with a bad API key", async () => {
    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create({ amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await create({ amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 300 });
  });

  test("accumulates partial refunds and becomes refunded once the total is reached", async () => {
    const created = await create({ amount: 1000 });

    const first = await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 200 });
    const last = await client.refundPayment(created.id);

    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 300 });
    expect(second).toMatchObject({ status: "partially_refunded", amountRefunded: 500 });
    expect(last).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await create({ amount: 1000 });
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects 409 already_refunded for a fully refunded payment", async () => {
    const created = await create();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects 409 not_refundable for a pending payment", async () => {
    const created = await create({ source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects 409 not_refundable for a canceled payment", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await create({ amount: 1000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects 422 invalid_refund_amount when the amount exceeds what remains", async () => {
    const created = await create({ amount: 1000 });
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
    ["non-integer", 1.5],
  ])("rejects 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await create({ amount: 1000 });

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await create({ amount: 1000 });
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects 401 unauthorized with a bad API key", async () => {
    const created = await create();

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create({ source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await create({ source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects 409 not_cancelable for a succeeded payment", async () => {
    const created = await create();

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects 409 not_cancelable for an already canceled payment", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects 401 unauthorized with a bad API key", async () => {
    const created = await create({ source: "tok_pending" });

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error fallbacks", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("oops", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

const visa = (amount = 1000): CreatePaymentInput => ({
  amount,
  currency: "usd",
  source: "tok_visa",
});

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const before = Date.now();
    const payment = await client.createPayment({ amount: 2500, currency: "eur", source: "tok_visa" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(new Date(payment.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 700,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
    expect(payment.amountRefunded).toBe(0);
  });

  test("issues a distinct id for each payment", async () => {
    const a = await client.createPayment(visa());
    const b = await client.createPayment(visa());

    expect(a.id).not.toBe(b.id);
  });

  test("throws 402 card_declined for tok_chargeDeclined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );
  });

  test("throws 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      { status: 402, code: "insufficient_funds", message: "The card has insufficient funds" },
    );
  });

  test("throws 500 processing_error for tok_serverError", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      {
        status: 500,
        code: "processing_error",
        message: "An error occurred while processing the payment",
      },
    );
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      { status: 400, code: "invalid_source", message: "Unknown payment source" },
    );
  });

  test.each([
    ["zero amount", { amount: 0, currency: "usd", source: "tok_visa" }],
    ["negative amount", { amount: -5, currency: "usd", source: "tok_visa" }],
    ["fractional amount", { amount: 10.5, currency: "usd", source: "tok_visa" }],
    ["missing currency", { amount: 100, source: "tok_visa" }],
    ["missing source", { amount: 100, currency: "usd" }],
  ])("throws 400 invalid_request for %s", async (_name, input) => {
    await expectApiError(client.createPayment(input as unknown as CreatePaymentInput), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    await expectApiError(badKeyClient.createPayment(visa()), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("a rejected create does not store a payment", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined" },
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment(visa(1234));

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("encodes the id so path characters cannot change the route", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(badKeyClient.getPayment(created.id), {
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
    const a = await client.createPayment(visa(100));
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(visa(100));
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });
    const toRefund = await client.createPayment(visa(300));
    const refunded = await client.refundPayment(toRefund.id);

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([refunded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(visa());

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    await expectApiError(badKeyClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa(1000));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(visa(1000));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunding the remainder after a partial refund completes it", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("accumulates successive partial refunds", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id, { amount: 300 });

    const second = await client.refundPayment(created.id, { amount: 300 });

    expect(second.status).toBe("partially_refunded");
    expect(second.amountRefunded).toBe(600);
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(visa());
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const pending = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const pending = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await client.createPayment(visa(1000));

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 10.5],
  ])("throws 422 invalid_refund_amount for a %s amount", async (_name, amount) => {
    const created = await client.createPayment(visa(1000));

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const pending = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const pending = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(badKeyClient.cancelPayment(pending.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error responses without an error body", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});

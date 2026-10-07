import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message: string },
) {
  // bun-types declares `rejects` matchers as void, but they return a promise that must be awaited.
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    message: expected.message,
  });
}

const unauthorized = { status: 401, code: "unauthorized", message: "Missing or invalid API key" };

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 100,
      currency: "eur",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(100);
    expect(payment.currency).toBe("eur");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(a.id).not.toBe(b.id);
  });

  test("persists the payment so getPayment returns it", async () => {
    const created = await client.createPayment({
      amount: 700,
      currency: "usd",
      source: "tok_visa",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_nope" }),
      {
        status: 400,
        code: "invalid_source",
        message: "Unknown payment source",
      },
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment({ amount, currency: "usd", source: "tok_visa" }), {
      status: 400,
      code: "invalid_request",
      message: "amount (positive integer), currency and source are required",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
      message: "amount (positive integer), currency and source are required",
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_insufficientFunds" }),
      { status: 402, code: "insufficient_funds", message: "The card has insufficient funds" },
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_serverError" }),
      {
        status: 500,
        code: "processing_error",
        message: "An error occurred while processing the payment",
      },
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );

    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      unauthorized,
    );
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment({
      amount: 1234,
      currency: "usd",
      source: "tok_visa",
    });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
    expect(fetched.amount).toBe(1234);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(badKeyClient.getPayment(created.id), unauthorized);
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(a);
    expect(payments).toContainEqual(b);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made by other methods", async () => {
    const created = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    const refunded = await client.listPayments({ status: "refunded" });

    expect(refunded).toHaveLength(1);
    expect(refunded[0]?.id).toBe(created.id);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), unauthorized);
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("marks the payment refunded when partial refunds add up to the total", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 600 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment returns it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 301 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("leaves the payment unchanged when a refund is rejected", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(badKeyClient.refundPayment(created.id), unauthorized);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns it", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(badKeyClient.cancelPayment(created.id), unauthorized);
  });
});

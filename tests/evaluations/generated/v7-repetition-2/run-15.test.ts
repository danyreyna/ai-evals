import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
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
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    ...expected,
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
    expect(payment.amount).toBe(1000);
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment(card);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...card, amount: 0 }],
    ["negative amount", { ...card, amount: -5 }],
    ["fractional amount", { ...card, amount: 10.5 }],
    ["non-numeric amount", { ...card, amount: "1000" as unknown as number }],
    ["missing currency", { ...card, currency: undefined as unknown as string }],
    ["missing source", { ...card, source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
      message: "amount (positive integer), currency and source are required",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(card), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment({ ...card, amount: 2500, currency: "eur" });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
    expect(fetched.amount).toBe(2500);
    expect(fetched.currency).toBe("eur");
  });

  test("reflects later state changes", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 300 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(300);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("encodes the id so it cannot reach another route", async () => {
    await expectApiError(client.getPayment("x/refund"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id x/refund",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when unfiltered", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("filters on statuses reached through refunds and cancels", async () => {
    const refunded = await client.createPayment(card);
    const partial = await client.createPayment(card);
    const canceled = await client.createPayment({ ...card, source: "tok_pending" });
    const refundedNow = await client.refundPayment(refunded.id);
    const partialNow = await client.refundPayment(partial.id, { amount: 1 });
    const canceledNow = await client.cancelPayment(canceled.id);

    expect(await client.listPayments({ status: "refunded" })).toEqual([refundedNow]);
    expect(await client.listPayments({ status: "partially_refunded" })).toEqual([partialNow]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceledNow]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds the requested amount", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("accumulates several partial refunds up to the full amount", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 250 });
    const second = await client.refundPayment(created.id, { amount: 250 });
    const last = await client.refundPayment(created.id, { amount: 500 });

    expect(first.amountRefunded).toBe(250);
    expect(second.amountRefunded).toBe(500);
    expect(second.status).toBe("partially_refunded");
    expect(last.amountRefunded).toBe(1000);
    expect(last.status).toBe("refunded");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(client.refundPayment(created.id, { amount: 601 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 600",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(badClient.cancelPayment(pending.id), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

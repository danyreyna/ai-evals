import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  // bun-types types `.rejects` matchers as void, but they return a promise that must be awaited.
  // oxlint-disable-next-line typescript/await-thenable
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable
  await expect(promise).rejects.toMatchObject(expected);
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };
const pendingCard = { amount: 1000, currency: "usd", source: "tok_pending" };

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/) as string,
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String) as string,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pendingCard);

    expect(payment).toMatchObject({ status: "pending", amount: 1000, amountRefunded: 0 });
  });

  test("assigns a distinct id to each payment", async () => {
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
    ["non-integer amount", { ...card, amount: 10.5 }],
    ["non-numeric amount", { ...card, amount: "1000" as unknown as number }],
    ["missing currency", { ...card, currency: undefined as unknown as string }],
    ["missing source", { ...card, source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(card), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("does not store a payment whose creation failed", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it stays a single path segment", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

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
    const a = await client.createPayment(card);
    const b = await client.createPayment(pendingCard);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]) as Payment[]);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment(pendingCard);

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made through refund and cancel", async () => {
    const toRefund = await client.createPayment(card);
    const toCancel = await client.createPayment(pendingCard);
    await client.refundPayment(toRefund.id);
    await client.cancelPayment(toCancel.id);

    const refunded = await client.listPayments({ status: "refunded" });
    const canceled = await client.listPayments({ status: "canceled" });

    expect(refunded.map((p) => p.id)).toEqual([toRefund.id]);
    expect(canceled.map((p) => p.id)).toEqual([toCancel.id]);
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a given amount", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("moves to refunded once partial refunds add up to the full amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder when no amount follows a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pendingCard);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pendingCard);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
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

  test("rejects an amount above the unrefunded remainder with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(client.refundPayment(created.id, { amount: 200 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 100",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(card);
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pendingCard);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment(pendingCard);
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
    const created = await client.createPayment(card);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling a payment twice with 409 not_cancelable", async () => {
    const created = await client.createPayment(pendingCard);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await client.createPayment(pendingCard);

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error body fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_1",
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_1"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("uses unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_1", () =>
        HttpResponse.json({}, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_1"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

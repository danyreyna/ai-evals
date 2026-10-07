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
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const card = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const rejection = expect(call).rejects;
  await rejection.toBeInstanceOf(PaymentsApiError);
  await rejection.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment).toMatchObject({ status: "pending", amountRefunded: 0, source: "tok_pending" });
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

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...card, amount: -100 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a fractional amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.createPayment(card), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("does not create a payment when the request is rejected", async () => {
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

  test("rejects an id containing a slash with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay/../refund"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

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
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes in the filtered results", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 1200 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 1200,
    });
  });

  test("accumulates successive partial refunds until fully refunded", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 2000 });
    const second = await client.refundPayment(created.id, { amount: 3000 });

    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 2000 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 1500 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("persists the refund so getPayment returns it", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 700 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
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

  test("rejects a refund of a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects a refund of a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the amount paid with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 5001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 5000",
    });
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a zero refund with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a negative refund with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: -5 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a fractional refund with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 10.5 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(card);
    await expectApiError(client.refundPayment(created.id, { amount: 9999 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toMatchObject({ id: pending.id, status: "canceled", amountRefunded: 0 });
  });

  test("persists the cancellation so getPayment returns it", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(pending.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

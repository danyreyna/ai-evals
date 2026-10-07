import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

async function apiError(call: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("expected the call to reject with PaymentsApiError");
}

function expectApiError(error: PaymentsApiError, status: number, code: string, message?: string) {
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  if (message !== undefined) {
    expect(error.message).toBe(message);
  }
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(card);

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

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment(card);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects with 402 card_declined", async () => {
    const error = await apiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }));

    expectApiError(error, 402, "card_declined", "The card was declined");
  });

  test("rejects with 402 insufficient_funds", async () => {
    const error = await apiError(client.createPayment({ ...card, source: "tok_insufficientFunds" }));

    expectApiError(error, 402, "insufficient_funds", "The card has insufficient funds");
  });

  test("rejects with 500 processing_error", async () => {
    const error = await apiError(client.createPayment({ ...card, source: "tok_serverError" }));

    expectApiError(
      error,
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects with 400 invalid_source for an unknown source", async () => {
    const error = await apiError(client.createPayment({ ...card, source: "tok_nope" }));

    expectApiError(error, 400, "invalid_source", "Unknown payment source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects with 400 invalid_request for a %s amount", async (_label, amount) => {
    const error = await apiError(client.createPayment({ ...card, amount }));

    expectApiError(error, 400, "invalid_request");
  });

  test("rejects with 400 invalid_request when currency is missing", async () => {
    const error = await apiError(
      client.createPayment({ amount: 1000, source: "tok_visa" } as never),
    );

    expectApiError(error, 400, "invalid_request");
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const error = await apiError(badClient.createPayment(card));

    expectApiError(error, 401, "unauthorized", "Missing or invalid API key");
  });

  test("does not store a payment that was rejected", async () => {
    const error = await apiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }));
    expectApiError(error, 402, "card_declined");

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    const error = await apiError(client.getPayment("pay_missing"));

    expectApiError(error, 404, "payment_not_found", "No payment with id pay_missing");
  });

  test("url-encodes the id so it cannot reach another route", async () => {
    const error = await apiError(client.getPayment("a/refund"));

    expectApiError(error, 404, "payment_not_found", "No payment with id a/refund");
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment(card);

    const error = await apiError(badClient.getPayment(created.id));

    expectApiError(error, 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("defaults to no filter when called with an empty object", async () => {
    const a = await client.createPayment(card);

    expect(await client.listPayments({})).toEqual([a]);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes in the filter results", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const error = await apiError(badClient.listPayments());

    expectApiError(error, 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a specific amount", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 300 });
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(400);
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds the remainder when no amount follows a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects with 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    const error = await apiError(client.refundPayment(created.id));

    expectApiError(error, 409, "already_refunded", "Payment already refunded");
  });

  test("rejects with 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const error = await apiError(client.refundPayment(created.id));

    expectApiError(error, 409, "not_refundable", "A pending payment cannot be refunded");
  });

  test("rejects with 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = await apiError(client.refundPayment(created.id));

    expectApiError(error, 409, "not_refundable", "A canceled payment cannot be refunded");
  });

  test("rejects with 422 invalid_refund_amount when over the payment amount", async () => {
    const created = await client.createPayment(card);

    const error = await apiError(client.refundPayment(created.id, { amount: 1001 }));

    expectApiError(error, 422, "invalid_refund_amount", "Refund amount must be between 1 and 1000");
  });

  test("rejects with 422 invalid_refund_amount when over the remaining amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 800 });

    const error = await apiError(client.refundPayment(created.id, { amount: 201 }));

    expectApiError(error, 422, "invalid_refund_amount", "Refund amount must be between 1 and 200");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects with 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await client.createPayment(card);

    const error = await apiError(client.refundPayment(created.id, { amount }));

    expectApiError(error, 422, "invalid_refund_amount");
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    const error = await apiError(client.refundPayment("pay_missing"));

    expectApiError(error, 404, "payment_not_found", "No payment with id pay_missing");
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment(card);

    const error = await apiError(badClient.refundPayment(created.id));

    expectApiError(error, 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects with 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(card);

    const error = await apiError(client.cancelPayment(created.id));

    expectApiError(error, 409, "not_cancelable", "A succeeded payment cannot be canceled");
  });

  test("rejects with 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = await apiError(client.cancelPayment(created.id));

    expectApiError(error, 409, "not_cancelable", "A canceled payment cannot be canceled");
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    const error = await apiError(client.cancelPayment("pay_missing"));

    expectApiError(error, 404, "payment_not_found", "No payment with id pay_missing");
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const error = await apiError(badClient.cancelPayment(created.id));

    expectApiError(error, 401, "unauthorized");
  });
});

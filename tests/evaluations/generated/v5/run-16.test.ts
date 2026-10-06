import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const VALID_API_KEY = "test_key";

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

const client = new PaymentsClient({ apiKey: VALID_API_KEY });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected promise to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
}

const create = (overrides: Partial<{ amount: number; currency: string; source: string }> = {}) =>
  client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa", ...overrides });

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await create({ amount: 2500, currency: "eur" });

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("eur");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await create({ source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await create();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    const error = await expectApiError(
      bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
    expect(error.message).toBe("Missing or invalid API key");
  });

  test.each([0, -5, 10.5])("rejects amount %p with 400 invalid_request", async (amount) => {
    await expectApiError(create({ amount }), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, source: "tok_visa" } as never),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const error = await expectApiError(create({ source: "tok_nope" }), 400, "invalid_source");
    expect(error.message).toBe("Unknown payment source");
  });

  test("maps a declined card to 402 card_declined", async () => {
    const error = await expectApiError(
      create({ source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("maps insufficient funds to 402 insufficient_funds", async () => {
    const error = await expectApiError(
      create({ source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("maps a processing failure to 500 processing_error", async () => {
    await expectApiError(create({ source: "tok_serverError" }), 500, "processing_error");
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(create({ source: "tok_chargeDeclined" }), 402, "card_declined");
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await create({ amount: 700 });
    const fetched = await client.getPayment(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(700);
    expect(fetched.status).toBe("succeeded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id", async () => {
    const error = await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id a/b c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await create();
    const b = await create({ source: "tok_pending" });
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await create();
    const pending = await create({ source: "tok_pending" });

    const pendingList = await client.listPayments({ status: "pending" });
    expect(pendingList.map((p) => p.id)).toEqual([pending.id]);

    const succeededList = await client.listPayments({ status: "succeeded" });
    expect(succeededList.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await create();
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create({ amount: 1000 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await create({ amount: 1000 });
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 300 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 250 });
    const fetched = await client.getPayment(created.id);
    expect(fetched.amountRefunded).toBe(250);
    expect(fetched.status).toBe("partially_refunded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await create();
    await client.refundPayment(created.id);
    const error = await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await create({ source: "tok_pending" });
    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await create({ amount: 1000 });
    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("bounds the refund by what is left after a partial refund", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 700 });
    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 301 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 300");
  });

  test.each([0, -1, 1.5])("rejects refund amount %p with 422 invalid_refund_amount", async (amount) => {
    const created = await create({ amount: 1000 });
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await create({ amount: 1000 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );
    const fetched: Payment = await client.getPayment(created.id);
    expect(fetched.amountRefunded).toBe(0);
    expect(fetched.status).toBe("succeeded");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create({ source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);
    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create({ source: "tok_pending" });
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await create();
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A canceled payment cannot be canceled");
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await create();
    await client.refundPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

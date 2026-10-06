import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

async function catchApiError(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the request to fail, but it resolved");
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await catchApiError(promise);
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

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
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(newPayment("tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_unknown"), 400, "invalid_source");
  });

  test.each([0, -5, 10.5])("rejects amount %p with 400 invalid_request", async (amount) => {
    await expectApiError(newPayment("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });

  test("does not persist a payment that failed", async () => {
    await catchApiError(newPayment("tok_chargeDeclined"));
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await newPayment();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("encodes the id so special characters are not interpreted as a path", async () => {
    await expectApiError(client.getPayment("a/b?c"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await newPayment();
    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toHaveLength(1);
    expect(payments[0]?.id).toBe(pending.id);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await newPayment("tok_visa");
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("allows refunding the remainder after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
    );
  });

  test.each([0, -1, 1.5])("rejects amount %p with 422 invalid_refund_amount", async (amount) => {
    const created = await newPayment("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await newPayment();
    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await newPayment("tok_pending");
    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
}

const charge = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await charge("tok_visa", 2500);
    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await charge("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(charge("tok_visa", 0), 400, "invalid_request");
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(charge("tok_visa", 10.5), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(charge("tok_unknown"), 400, "invalid_source");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(charge("tok_chargeDeclined"), 402, "card_declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(charge("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(charge("tok_serverError"), 500, "processing_error");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await charge();
    const fetched = await client.getPayment(created.id);
    expect(fetched).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await charge();
    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });
});

describe("listPayments", () => {
  test("returns an empty list when no payments exist", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await charge("tok_visa");
    const b = await charge("tok_pending");
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await charge("tok_visa");
    const pending = await charge("tok_pending");
    const list = await client.listPayments({ status: "pending" });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(pending.id);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await charge("tok_visa");
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await charge("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await charge("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await charge("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await charge();
    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await charge();
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await charge("tok_pending");
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await charge("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await charge("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await charge("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer amount with 422 invalid_refund_amount", async () => {
    const created = await charge("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 10.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an amount above what remains after a partial refund", async () => {
    const created = await charge("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await charge("tok_pending");
    const canceled = await client.cancelPayment(created.id);
    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await charge("tok_pending");
    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await charge("tok_visa");
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await charge("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

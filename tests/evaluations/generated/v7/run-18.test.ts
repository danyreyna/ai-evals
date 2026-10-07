import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const visa = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
  ...overrides,
});

// Awaits a promise that must reject and hands back the error for assertions.
async function rejection(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(visa({ amount: 2500, currency: "eur" }));

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(visa({ source: "tok_pending" }));

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(visa());
    const second = await client.createPayment(visa());

    expect(first.id).not.toBe(second.id);
  });

  test.each([
    ["tok_chargeDeclined", 402, "card_declined", "The card was declined"],
    ["tok_insufficientFunds", 402, "insufficient_funds", "The card has insufficient funds"],
    [
      "tok_serverError",
      500,
      "processing_error",
      "An error occurred while processing the payment",
    ],
    ["tok_unknown", 400, "invalid_source", "Unknown payment source"],
  ])("rejects source %s with %d %s", async (source, status, code, message) => {
    const error = await rejection(client.createPayment(visa({ source })));

    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("rejects %s with 400 invalid_request", async (_name, overrides) => {
    const error = await rejection(client.createPayment(visa(overrides)));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as CreatePaymentInput;
    const error = await rejection(client.createPayment(input));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("does not persist a payment that was declined", async () => {
    await rejection(client.createPayment(visa({ source: "tok_chargeDeclined" })));

    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(badClient.createPayment(visa()));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa({ amount: 777 }));

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.getPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id so a slash does not hit another route", async () => {
    const error = await rejection(client.getPayment("a/b"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id a/b");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());
    const error = await rejection(badClient.getPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(visa({ amount: 100 }));
    const b = await client.createPayment(visa({ amount: 200, source: "tok_pending" }));

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(visa());
    const pending = await client.createPayment(visa({ source: "tok_pending" }));

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(visa());

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in the filter", async () => {
    const pending = await client.createPayment(visa({ source: "tok_pending" }));
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(badClient.listPayments());

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds the requested amount", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(visa());
    await client.refundPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
    expect(error.message).toBe("A canceled payment cannot be refunded");
  });

  test.each([
    ["more than the payment amount", 1001],
    ["zero", 0],
    ["a negative amount", -1],
    ["a fractional amount", 10.5],
  ])("rejects a refund of %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    const error = await rejection(client.refundPayment(created.id, { amount }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("rejects a refund larger than the remaining balance", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 900 });

    const error = await rejection(client.refundPayment(created.id, { amount: 101 }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 100");
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await rejection(client.refundPayment(created.id, { amount: 5000 }));

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.refundPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());
    const error = await rejection(badClient.refundPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa());

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A canceled payment cannot be canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.cancelPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    const error = await rejection(badClient.cancelPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

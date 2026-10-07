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

const seed = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({ amount: 1500, currency: "usd", source: "tok_visa" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 1500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await seed("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const promise = seed("tok_chargeDeclined");

    await expectApiError(promise, 402, "card_declined");
    await expect(promise).rejects.toThrow("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const promise = seed("tok_insufficientFunds");

    await expectApiError(promise, 402, "insufficient_funds");
    await expect(promise).rejects.toThrow("The card has insufficient funds");
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    const promise = seed("tok_serverError");

    await expectApiError(promise, 500, "processing_error");
    await expect(promise).rejects.toThrow("An error occurred while processing the payment");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const promise = seed("tok_nope");

    await expectApiError(promise, 400, "invalid_source");
    await expect(promise).rejects.toThrow("Unknown payment source");
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(seed("tok_visa", 0), 400, "invalid_request");
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(seed("tok_visa", 10.5), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    const promise = bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    await expectApiError(promise, 401, "unauthorized");
    await expect(promise).rejects.toThrow("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await seed();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const promise = client.getPayment("pay_missing");

    await expectApiError(promise, 404, "payment_not_found");
    await expect(promise).rejects.toThrow("No payment with id pay_missing");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed();
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await seed("tok_visa");
    const b = await seed("tok_pending");

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("filters by status", async () => {
    await seed("tok_visa");
    const pending = await seed("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await seed("tok_visa");

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await seed("tok_visa", 1000);

    expect(await client.refundPayment(created.id)).toEqual({
      ...created,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a given amount", async () => {
    const created = await seed("tok_visa", 1000);

    expect(await client.refundPayment(created.id, { amount: 400 })).toEqual({
      ...created,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await seed("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    expect(await client.refundPayment(created.id, { amount: 600 })).toEqual({
      ...created,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await seed();
    await client.refundPayment(created.id);
    const promise = client.refundPayment(created.id);

    await expectApiError(promise, 409, "already_refunded");
    await expect(promise).rejects.toThrow("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await seed("tok_pending");
    const promise = client.refundPayment(created.id);

    await expectApiError(promise, 409, "not_refundable");
    await expect(promise).rejects.toThrow("A pending payment cannot be refunded");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await seed("tok_visa", 1000);
    const promise = client.refundPayment(created.id, { amount: 1001 });

    await expectApiError(promise, 422, "invalid_refund_amount");
    await expect(promise).rejects.toThrow("Refund amount must be between 1 and 1000");
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await seed();

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), 422, "invalid_refund_amount");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed();
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await seed("tok_pending");

    expect(await client.cancelPayment(created.id)).toEqual({ ...created, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await seed("tok_visa");
    const promise = client.cancelPayment(created.id);

    await expectApiError(promise, 409, "not_cancelable");
    await expect(promise).rejects.toThrow("A succeeded payment cannot be canceled");
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const created = await seed("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed("tok_pending");
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.cancelPayment(created.id), 401, "unauthorized");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
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

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const succeeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });
const pending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment({ amount: 2500, currency: "usd", source: "tok_visa" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await pending(500);

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(500);
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([succeeded(), succeeded()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(
      client.createPayment({ amount, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("does not store a payment that was rejected", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong", baseUrl: "https://api.example.com/v1" });

    await expectApiError(
      bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await succeeded(1234);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("encodes the id before putting it in the path", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await succeeded();
    const bad = new PaymentsClient({ apiKey: "wrong", baseUrl: "https://api.example.com/v1" });

    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when nothing exists", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await succeeded(100);
    const b = await pending(200);

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const a = await succeeded(100);
    const b = await pending(200);

    expect(await client.listPayments({ status: "pending" })).toEqual([b]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([a]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await succeeded();

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong", baseUrl: "https://api.example.com/v1" });

    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await succeeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds and marks the payment partially_refunded", async () => {
    const created = await succeeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await succeeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await succeeded(1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await succeeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await pending();

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await pending();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await succeeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above what remains after a partial refund", async () => {
    const created = await succeeded(1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await succeeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after an invalid refund", async () => {
    const created = await succeeded(1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await succeeded();
    const bad = new PaymentsClient({ apiKey: "wrong", baseUrl: "https://api.example.com/v1" });

    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await pending();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await pending();
    await client.cancelPayment(created.id);

    const fetched: Payment = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await succeeded();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await pending();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await succeeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await pending();
    const bad = new PaymentsClient({ apiKey: "wrong", baseUrl: "https://api.example.com/v1" });

    await expectApiError(bad.cancelPayment(created.id), 401, "unauthorized");
  });
});

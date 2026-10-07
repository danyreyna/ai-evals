import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });

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

const visa = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
  ...overrides,
});

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa({ amount: 2500, currency: "eur" }));

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(visa({ source: "tok_pending" }));

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("returns distinct ids for separate payments", async () => {
    const first = await client.createPayment(visa());
    const second = await client.createPayment(visa());

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expect(
      client.createPayment(visa({ source: "tok_chargeDeclined" })),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expect(
      client.createPayment(visa({ source: "tok_insufficientFunds" })),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expect(client.createPayment(visa({ source: "tok_serverError" }))).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expect(client.createPayment(visa({ source: "tok_bogus" }))).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expect(client.createPayment(visa({ amount }))).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expect(client.createPayment(input)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expect(badClient.createPayment(visa())).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa({ amount: 777 }));

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.getPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id before sending it", async () => {
    await expect(client.getPayment("has space")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id has space",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expect(badClient.getPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when no payments exist", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await client.createPayment(visa());
    const pending = await client.createPayment(visa({ source: "tok_pending" }));

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(succeeded);
    expect(payments).toContainEqual(pending);
  });

  test("returns only payments matching the status filter", async () => {
    await client.createPayment(visa());
    const pending = await client.createPayment(visa({ source: "tok_pending" }));

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(visa());

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes in filtered results", async () => {
    const payment = await client.createPayment(visa({ source: "tok_pending" }));
    const canceled = await client.cancelPayment(payment.id);

    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
    expect(await client.listPayments({ status: "pending" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expect(badClient.listPayments()).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("refunds the full amount when no amount is given", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("accumulates successive partial refunds", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 600 });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(visa());
    await client.refundPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    await expect(client.refundPayment(created.id, { amount: 1001 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 700 });

    await expect(client.refundPayment(created.id, { amount: 301 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await client.createPayment(visa({ amount: 1000 }));

    await expect(client.refundPayment(created.id, { amount })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.refundPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expect(badClient.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa());

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.cancelPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa({ source: "tok_pending" }));
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expect(badClient.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

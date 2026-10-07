import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

beforeAll(() => {
  server.listen();
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

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });
const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await createSucceeded(2500);

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await createPending();

    expect(payment).toMatchObject({ source: "tok_pending", status: "pending" });
  });

  test("rejects an invalid amount with 400 invalid_request", async () => {
    const promise = client.createPayment({ amount: 0, currency: "usd", source: "tok_visa" });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "amount (positive integer), currency and source are required",
    });
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    const promise = client.createPayment({ amount: 10.5, currency: "usd", source: "tok_visa" });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const promise = client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const promise = client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_chargeDeclined",
    });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const promise = client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_insufficientFunds",
    });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    const promise = client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_serverError",
    });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await createSucceeded();

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const promise = client.getPayment("pay_missing");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.getPayment("pay_any");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("listPayments", () => {
  test("returns an empty list when no payments exist", async () => {
    const payments = await client.listPayments();

    expect(payments).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await createSucceeded(100);
    const b = await createPending(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    await createSucceeded(100);
    const pending = await createPending(200);

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await createSucceeded();

    const payments = await client.listPayments({ status: "refunded" });

    expect(payments).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.listPayments();

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);

    const promise = client.refundPayment(created.id, { amount: 1001 });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a zero refund amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);

    const promise = client.refundPayment(created.id, { amount: 0 });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 422, code: "invalid_refund_amount" });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    const promise = client.refundPayment(created.id);

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await createPending();

    const promise = client.refundPayment(created.id);

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const promise = client.refundPayment("pay_missing");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 404, code: "payment_not_found" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.refundPayment("pay_any");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    const promise = client.cancelPayment(created.id);

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    const promise = client.cancelPayment(created.id);

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const promise = client.cancelPayment("pay_missing");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 404, code: "payment_not_found" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.cancelPayment("pay_any");

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

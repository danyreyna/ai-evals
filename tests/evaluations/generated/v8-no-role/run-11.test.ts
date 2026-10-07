import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending = { amount: 500, currency: "usd", source: "tok_pending" };

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa);

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pending);

    expect(payment).toMatchObject({ amount: 500, source: "tok_pending", status: "pending" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expect(badClient.createPayment(visa)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expect(client.createPayment({ ...visa, amount: 10.5 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expect(client.createPayment({ ...visa, amount: 0 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expect(client.createPayment({ ...visa, source: "tok_nope" })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects tok_chargeDeclined with 402 card_declined", async () => {
    await expect(
      client.createPayment({ ...visa, source: "tok_chargeDeclined" }),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects tok_insufficientFunds with 402 insufficient_funds", async () => {
    await expect(
      client.createPayment({ ...visa, source: "tok_insufficientFunds" }),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects tok_serverError with 500 processing_error", async () => {
    await expect(
      client.createPayment({ ...visa, source: "tok_serverError" }),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(visa);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.getPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expect(badClient.getPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(visa);
    const waiting = await client.createPayment(pending);

    expect(await client.listPayments({ status: "pending" })).toEqual([waiting]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expect(badClient.listPayments()).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    await expect(client.refundPayment(created.id, { amount: 601 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 600",
    });
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expect(client.refundPayment(created.id, { amount: 0 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a non-integer amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expect(client.refundPayment(created.id, { amount: 1.5 })).rejects.toMatchObject({
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
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expect(badClient.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling a payment twice with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
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
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending);

    await expect(badClient.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

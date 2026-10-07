import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });
const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: "https://api.example.com/v1" });

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

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

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

  test("returns a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects with 402 card_declined for tok_chargeDeclined", async () => {
    await expect(newPayment("tok_chargeDeclined")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects with 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expect(newPayment("tok_insufficientFunds")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects with 500 processing_error for tok_serverError", async () => {
    await expect(newPayment("tok_serverError")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects with 400 invalid_source for an unknown source", async () => {
    await expect(newPayment("tok_nope")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", 0],
    ["negative amount", -5],
    ["fractional amount", 10.5],
  ])("rejects with 400 invalid_request for a %s", async (_label, amount) => {
    await expect(newPayment("tok_visa", amount)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    await expect(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
    ).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the created payment", async () => {
    const created = await newPayment();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.getPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await newPayment();

    await expect(badClient.getPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await newPayment("tok_visa");

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    await expect(badClient.listPayments()).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a given amount", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("completes a refund after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.refundPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects with 409 already_refunded for a fully refunded payment", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects with 409 not_refundable for a pending payment", async () => {
    const created = await newPayment("tok_pending");

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects with 409 not_refundable for a canceled payment", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects with 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await newPayment("tok_visa", 1000);

    await expect(client.refundPayment(created.id, { amount: 1001 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects with 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expect(client.refundPayment(created.id, { amount: 400 })).rejects.toMatchObject({
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
  ])("rejects with 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);

    await expect(client.refundPayment(created.id, { amount })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await newPayment();

    await expect(badClient.refundPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.cancelPayment("pay_missing")).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects with 409 not_cancelable for a succeeded payment", async () => {
    const created = await newPayment("tok_visa");

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects with 409 not_cancelable for an already canceled payment", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await newPayment("tok_pending");

    await expect(badClient.cancelPayment(created.id)).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 401,
      code: "unauthorized",
    });
  });
});

test("PaymentsApiError is an Error subclass", async () => {
  await expect(client.getPayment("pay_missing")).rejects.toBeInstanceOf(PaymentsApiError);
});

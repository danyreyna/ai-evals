/* oxlint-disable typescript/await-thenable -- bun-types types `.rejects` matchers as void, but they return promises */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

const card = { amount: 5000, currency: "usd", source: "tok_visa" };

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
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(card);

    expect(payment.id).toMatch(/^pay_/);
    expect(payment).toEqual({
      id: payment.id,
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: payment.createdAt,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(5000);
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment(card);

    expect(first.id).not.toBe(second.id);
  });

  test("throws 402 card_declined for a declined card", async () => {
    const error = client.createPayment({ ...card, source: "tok_chargeDeclined" });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("throws 402 insufficient_funds when the card lacks funds", async () => {
    const error = client.createPayment({ ...card, source: "tok_insufficientFunds" });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("throws 500 processing_error on a server failure", async () => {
    const error = client.createPayment({ ...card, source: "tok_serverError" });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    const error = client.createPayment({ ...card, source: "tok_bogus" });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -100],
    ["fractional", 10.5],
  ])("throws 400 invalid_request for a %s amount", async (_label, amount) => {
    const error = client.createPayment({ ...card, amount });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    const error = badClient.createPayment(card);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = client.getPayment("pay_missing");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it cannot change the request path", async () => {
    const error = client.getPayment("a/b");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const created = await client.createPayment(card);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    const error = badClient.getPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment({ ...card, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(first);
    expect(payments).toContainEqual(second);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    const error = badClient.listPayments();

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds a payment for the given amount", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 1200 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 1200 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 2000 });
    const second = await client.refundPayment(created.id, { amount: 3000 });

    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(2000);
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(5000);
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 1500 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    const error = client.refundPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    const error = client.refundPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = client.refundPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the balance", async () => {
    const created = await client.createPayment(card);
    const error = client.refundPayment(created.id, { amount: 5001 });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 5000",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 4000 });

    const error = client.refundPayment(created.id, { amount: 1001 });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("throws 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await client.createPayment(card);
    const error = client.refundPayment(created.id, { amount });

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 422, code: "invalid_refund_amount" });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = client.refundPayment("pay_missing");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const created = await client.createPayment(card);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    const error = badClient.refundPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(card);
    const error = client.cancelPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = client.cancelPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = client.cancelPayment("pay_missing");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    const error = badClient.cancelPayment(created.id);

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("non-standard error responses", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/:id",
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const error = client.getPayment("pay_any");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/:id", () =>
        HttpResponse.json({ detail: "boom" }, { status: 503, statusText: "Unavailable" }),
      ),
    );
    const error = client.getPayment("pay_any");

    await expect(error).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(error).rejects.toMatchObject({
      status: 503,
      code: "unknown_error",
      message: "Unavailable",
    });
  });
});

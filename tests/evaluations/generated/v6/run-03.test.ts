import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";
const client = new PaymentsClient({ apiKey: "test_key" });

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

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

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

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 1000,
      currency: "eur",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(1000);
    expect(payment.currency).toBe("eur");
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const first = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const second = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 500, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 500, currency: "usd", source: "tok_insufficientFunds" }),
      { status: 402, code: "insufficient_funds", message: "The card has insufficient funds" },
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 500, currency: "usd", source: "tok_serverError" }),
      {
        status: 500,
        code: "processing_error",
        message: "An error occurred while processing the payment",
      },
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 500, currency: "usd", source: "tok_bogus" }),
      { status: 400, code: "invalid_source", message: "Unknown payment source" },
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment({ amount, currency: "usd", source: "tok_visa" }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("does not store a payment that was rejected", async () => {
    await expectApiError(
      client.createPayment({ amount: 500, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined" },
    );

    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(
      badClient.createPayment({ amount: 500, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment({
      amount: 4200,
      currency: "usd",
      source: "tok_visa",
    });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so special characters reach the server intact", async () => {
    await expectApiError(client.getPayment("a/b c?d"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c?d",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const visa = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([visa, pending]));
  });

  test("returns only payments matching the status filter", async () => {
    const visa = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    expect(await client.listPayments({ status: "succeeded" })).toEqual([visa]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made by refund and cancel", async () => {
    const succeeded = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });
    await client.refundPayment(succeeded.id);
    await client.cancelPayment(pending.id);

    const refunded = await client.listPayments({ status: "refunded" });
    const canceled = await client.listPayments({ status: "canceled" });

    expect(refunded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(canceled.map((p) => p.id)).toEqual([pending.id]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("moves from partially_refunded to refunded when the remainder is refunded", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("refunds the remaining balance after a partial refund when no amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the payment amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
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
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error body fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("uses unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => HttpResponse.json({}, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

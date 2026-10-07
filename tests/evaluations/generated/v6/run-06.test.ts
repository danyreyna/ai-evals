import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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

const client = new PaymentsClient({ apiKey: "test_key" });

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject(expected);
}

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const input = { amount: 100, currency: "usd", source: "tok_visa" };
    const first = await client.createPayment(input);
    const second = await client.createPayment(input);

    expect(first.id).not.toBe(second.id);
  });

  test("throws 402 card_declined for tok_chargeDeclined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );
  });

  test("throws 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      { status: 402, code: "insufficient_funds", message: "The card has insufficient funds" },
    );
  });

  test("throws 500 processing_error for tok_serverError", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      {
        status: 500,
        code: "processing_error",
        message: "An error occurred while processing the payment",
      },
    );
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      { status: 400, code: "invalid_source", message: "Unknown payment source" },
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("throws 400 invalid_request for a %s amount", async (_label, amount) => {
    await expectApiError(client.createPayment({ amount, currency: "usd", source: "tok_visa" }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });

  test("does not store a payment that was declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined" },
    );

    await expect(client.listPayments()).resolves.toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment({
      amount: 4200,
      currency: "eur",
      source: "tok_visa",
    });

    await expect(client.getPayment(created.id)).resolves.toEqual(created);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const created = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    await expect(client.listPayments()).resolves.toEqual([]);
  });

  test("returns every created payment", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
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

    await expect(client.listPayments({ status: "pending" })).resolves.toEqual([pending]);
    await expect(client.listPayments({ status: "succeeded" })).resolves.toEqual([succeeded]);
    await expect(client.listPayments({ status: "refunded" })).resolves.toEqual([]);
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
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

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 250 });

    await expect(client.getPayment(created.id)).resolves.toMatchObject({
      status: "partially_refunded",
      amountRefunded: 250,
    });
  });

  test("throws 409 already_refunded on a fully refunded payment", async () => {
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

  test("throws 409 not_refundable on a pending payment", async () => {
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

  test("throws 409 not_refundable on a canceled payment", async () => {
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

  test("throws 422 invalid_refund_amount when the amount exceeds the payment", async () => {
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

  test("throws 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(client.refundPayment(created.id, { amount: 300 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 200",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 10.5],
  ])("throws 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
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

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
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

    expect(canceled).toMatchObject({ id: created.id, status: "canceled", amountRefunded: 0 });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expect(client.getPayment(created.id)).resolves.toMatchObject({ status: "canceled" });
  });

  test("throws 409 not_cancelable on a succeeded payment", async () => {
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

  test("throws 409 not_cancelable on an already canceled payment", async () => {
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

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("throws 401 unauthorized with an invalid API key", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () =>
          new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the error body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments`, () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

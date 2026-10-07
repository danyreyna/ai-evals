import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

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

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending = { amount: 1000, currency: "usd", source: "tok_pending" };

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
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pending);

    expect(payment).toMatchObject({ source: "tok_pending", status: "pending", amountRefunded: 0 });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...visa, amount: 0 }],
    ["negative amount", { ...visa, amount: -5 }],
    ["fractional amount", { ...visa, amount: 10.5 }],
    ["string amount", { ...visa, amount: "1000" }],
    ["missing currency", { amount: 1000, source: "tok_visa" }],
    ["missing source", { amount: 1000, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input as unknown as CreatePaymentInput), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.createPayment(visa), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(visa);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it is looked up as a single path segment", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.getPayment("pay_any"), {
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
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    const all = await client.listPayments();

    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(visa);
    const pend = await client.createPayment(pending);

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pend]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), { status: 401, code: "unauthorized" });
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

  test("moves to refunded once partial refunds add up to the full amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder when no amount follows a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects refunding a refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the unrefunded remainder with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);
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
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.refundPayment("pay_any"), {
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

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("non-standard error responses", () => {
  test("falls back to unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  // bun-types declare `rejects` matchers as void, but they return a promise that must be awaited.
  // oxlint-disable-next-line typescript/await-thenable
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 5000, source: "tok_visa" } as unknown as typeof validInput;

    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a bad api key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("does not persist a payment that was declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it stays a single path segment", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects a bad api key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.getPayment(created.id), {
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
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.find((p) => p.id === a.id)).toEqual(a);
    expect(payments.find((p) => p.id === b.id)).toEqual(b);
  });

  test("returns only payments matching the status filter", async () => {
    await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("reflects state changes in the status filter", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad api key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 5000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 1200 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 1200,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 1200 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("accumulates multiple partial refunds", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 1000 });

    const second = await client.refundPayment(created.id, { amount: 2000 });

    expect(second).toMatchObject({ status: "partially_refunded", amountRefunded: 3000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 700 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount: 5001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 5000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(validInput);
    await expectApiError(client.refundPayment(created.id, { amount: 9999 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a bad api key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
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

  test("rejects a bad api key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(pending.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
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

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});

describe("request wiring", () => {
  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal/v2/payments/pay_custom", () =>
        HttpResponse.json({
          ...validInput,
          id: "pay_custom",
          status: "succeeded",
          amountRefunded: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://payments.internal/v2",
    });

    const payment = await custom.getPayment("pay_custom");

    expect(payment.id).toBe("pay_custom");
  });
});

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
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(expected.status);
  expect(apiError.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(apiError.message).toBe(expected.message);
  }
}

const charge = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await charge("tok_visa", 2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await charge("tok_pending");

    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(charge("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(charge("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(charge("tok_serverError"), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(charge("tok_nope"), {
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
    await expectApiError(charge("tok_visa", amount), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await charge("tok_visa", 700);

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

  test("url-encodes the id", async () => {
    await expectApiError(client.getPayment("a/b c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await charge();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.getPayment(created.id), { status: 401, code: "unauthorized" });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await charge("tok_visa");
    const b = await charge("tok_pending");

    const all = await client.listPayments();

    expect(all).toEqual([a, b]);
  });

  test("filters by status", async () => {
    const succeeded = await charge("tok_visa");
    const pending = await charge("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await charge("tok_visa");

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const payment = await charge("tok_visa", 1000);

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toMatchObject({
      id: payment.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const payment = await charge("tok_visa", 1000);

    const refunded = await client.refundPayment(payment.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const payment = await charge("tok_visa", 1000);

    await client.refundPayment(payment.id, { amount: 400 });
    const refunded = await client.refundPayment(payment.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remainder of a partially refunded payment", async () => {
    const payment = await charge("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 250 });

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const payment = await charge("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 100 });

    const fetched = await client.getPayment(payment.id);

    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 100 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const payment = await charge();
    await client.refundPayment(payment.id);

    await expectApiError(client.refundPayment(payment.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const payment = await charge("tok_pending");

    await expectApiError(client.refundPayment(payment.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const payment = await charge("tok_pending");
    await client.cancelPayment(payment.id);

    await expectApiError(client.refundPayment(payment.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the payment amount with 422 invalid_refund_amount", async () => {
    const payment = await charge("tok_visa", 1000);

    await expectApiError(client.refundPayment(payment.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const payment = await charge("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 800 });

    await expectApiError(client.refundPayment(payment.id, { amount: 300 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 200",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const payment = await charge("tok_visa", 1000);

    await expectApiError(client.refundPayment(payment.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const payment = await charge();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.refundPayment(payment.id), { status: 401, code: "unauthorized" });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const payment = await charge("tok_pending");

    const canceled = await client.cancelPayment(payment.id);

    expect(canceled).toMatchObject({ id: payment.id, status: "canceled" });
    expect((await client.getPayment(payment.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const payment = await charge("tok_visa");

    await expectApiError(client.cancelPayment(payment.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const payment = await charge("tok_pending");
    await client.cancelPayment(payment.id);

    await expectApiError(client.cancelPayment(payment.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const payment = await charge("tok_pending");
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.cancelPayment(payment.id), { status: 401, code: "unauthorized" });
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return HttpResponse.json({ oops: true }, { status: 502, statusText: "Bad Gateway" });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});

describe("PaymentsClient options", () => {
  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal.test/payments", () => HttpResponse.json({ data: [] })),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://payments.internal.test",
    });

    expect(await custom.listPayments()).toEqual([]);
  });
});

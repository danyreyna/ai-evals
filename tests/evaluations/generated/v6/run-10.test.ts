import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
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

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });

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

function createPayment(source = "tok_visa", amount = 1000) {
  return client.createPayment({ amount, currency: "usd", source });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await createPayment("tok_visa", 2500);

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

  test("returns a pending payment for tok_pending", async () => {
    const payment = await createPayment("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(createPayment("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(createPayment("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(createPayment("tok_serverError"), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(createPayment("tok_unknown"), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(createPayment("tok_visa", 0), { status: 400, code: "invalid_request" });
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(createPayment("tok_visa", -5), { status: 400, code: "invalid_request" });
  });

  test("rejects a fractional amount with 400 invalid_request", async () => {
    await expectApiError(createPayment("tok_visa", 10.5), { status: 400, code: "invalid_request" });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const call = client.createPayment({ amount: 100, source: "tok_visa" } as never);

    await expectApiError(call, { status: 400, code: "invalid_request" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });
    const call = badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    await expectApiError(call, {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await createPayment("tok_visa", 4200);

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

  test("url-encodes the id so reserved characters reach the server intact", async () => {
    await expectApiError(client.getPayment("a/b?c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b?c",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createPayment();
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.getPayment(created.id), { status: 401, code: "unauthorized" });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every created payment when no filter is given", async () => {
    const a = await createPayment("tok_visa");
    const b = await createPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await createPayment("tok_visa");
    const pending = await createPayment("tok_pending");

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createPayment("tok_visa");

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes made by cancel and refund", async () => {
    const pending = await createPayment("tok_pending");
    const succeeded = await createPayment("tok_visa");
    const canceled = await client.cancelPayment(pending.id);
    const refunded = await client.refundPayment(succeeded.id);

    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([refunded]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await createPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds and marks the payment partially_refunded", async () => {
    const created = await createPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await createPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("accumulates two partial refunds that add up to the full amount", async () => {
    const created = await createPayment("tok_visa", 1000);
    const first = await client.refundPayment(created.id, { amount: 250 });
    const second = await client.refundPayment(created.id, { amount: 750 });

    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 250 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment returns the updated payment", async () => {
    const created = await createPayment("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await createPayment();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await createPayment("tok_pending");

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await createPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund larger than the payment with 422 invalid_refund_amount", async () => {
    const created = await createPayment("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund larger than the remaining balance with 422", async () => {
    const created = await createPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(client.refundPayment(created.id, { amount: 101 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 100",
    });
  });

  test("rejects a zero refund amount with 422 invalid_refund_amount", async () => {
    const created = await createPayment();

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a negative refund amount with 422 invalid_refund_amount", async () => {
    const created = await createPayment();

    await expectApiError(client.refundPayment(created.id, { amount: -1 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a fractional refund amount with 422 invalid_refund_amount", async () => {
    const created = await createPayment();

    await expectApiError(client.refundPayment(created.id, { amount: 1.5 }), {
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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createPayment();
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns the canceled payment", async () => {
    const created = await createPayment("tok_pending");
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createPayment("tok_visa");

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPayment("tok_pending");
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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createPayment("tok_pending");
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error payload fallbacks", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/pay_broken`, () =>
        HttpResponse.text("upstream exploded", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_broken"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/pay_odd`, () =>
        HttpResponse.json({ detail: "nope" }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_odd"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});
